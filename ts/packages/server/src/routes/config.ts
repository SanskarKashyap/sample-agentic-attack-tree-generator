/**
 * Configuration routes — TS port of `src/server/routes/config.py`. Mounted under
 * `/api`. Reads/writes `.threatforest/config.yaml`.
 *
 *   GET  /config              current model/provider config
 *   GET  /config/frameworks   available threat-mapping frameworks
 *   GET  /config/providers    available providers (TS: bedrock/anthropic/openai/gemini)
 *   POST /config/test         validate a provider config
 *   POST /config/save         persist provider config
 *   GET  /config/langfuse     Langfuse tracing config
 *   POST /config/langfuse/test
 *   POST /config/langfuse
 *
 * NOTE on bounded gaps vs Python:
 *  - Providers list reflects the SDK-native four (Ollama is dropped — see WS-3
 *    "Known bounded gaps"); the Gemini YAML key is `gemini`, not `google_gemini`.
 *  - The Bedrock STS credential probe and the Langfuse live auth-check use
 *    Python-only deps (boto3, the langfuse SDK, EnvManager). They are ported as
 *    field-shape validation; the deep network checks are not duplicated here and
 *    the response shape is unchanged so the UI behaves identically.
 */
import { Router, type Request, type Response } from 'express';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { config as engineConfig, FRAMEWORKS } from '@threatforest/engine';
import {
  ApiKeySetRequestSchema,
  type ApiKeyStatusResponse,
  type ConfigResponse,
  ConfigSaveRequestSchema,
  ConfigTestRequestSchema,
  type ProviderModel,
  ProviderModelsRequestSchema,
  type ProviderModelsResponse,
  type ProvidersResponse,
  LangfuseConfigSaveRequestSchema,
} from '@threatforest/types';

export const configRouter: Router = Router();

// TS supports only the four SDK-native providers (no Ollama — see providers.ts).
const AVAILABLE_PROVIDERS = ['AWS Bedrock', 'Anthropic', 'OpenAI', 'Google Gemini'];

const PROVIDER_TO_KEY: Record<string, string> = {
  'AWS Bedrock': 'bedrock',
  Anthropic: 'anthropic',
  OpenAI: 'openai',
  'Google Gemini': 'gemini',
};
const KEY_TO_PROVIDER: Record<string, string> = Object.fromEntries(
  Object.entries(PROVIDER_TO_KEY).map(([k, v]) => [v, k]),
);

// The env var each API-key provider's SDK reads its key from. Runs build their
// models in this process, so setting the var here is all a run needs.
const PROVIDER_ENV_VAR: Record<string, string> = {
  Anthropic: 'ANTHROPIC_API_KEY',
  OpenAI: 'OPENAI_API_KEY',
  'Google Gemini': 'GEMINI_API_KEY',
};

// Values the server was launched with (e.g. from ~/.bashrc), so clearing a
// browser-supplied key falls back to them instead of leaving no key at all.
const LAUNCH_ENV: Record<string, string | undefined> = Object.fromEntries(
  Object.values(PROVIDER_ENV_VAR).map((v) => [v, process.env[v]]),
);

// Env vars currently overridden by a key the browser sent. In memory only: a
// browser-supplied key is never written to config.yaml or .env.
const browserKeyVars = new Set<string>();

const PROBE_TIMEOUT_MS = 15_000;

async function readErrorDetail(response: globalThis.Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } | string };
    const detail = typeof body.error === 'string' ? body.error : body.error?.message;
    return (detail ?? '').slice(0, 300);
  } catch {
    return '';
  }
}

const PROVIDER_API_BASE: Record<string, string> = {
  Anthropic: 'https://api.anthropic.com/v1',
  OpenAI: 'https://api.openai.com/v1',
  'Google Gemini': 'https://generativelanguage.googleapis.com/v1beta',
};

function authHeaders(provider: string, apiKey: string): Record<string, string> {
  switch (provider) {
    case 'Anthropic':
      return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
    case 'OpenAI':
      return { Authorization: `Bearer ${apiKey}` };
    default:
      // Header, not the ?key= query param, so the key stays out of URLs/logs.
      return { 'x-goog-api-key': apiKey };
  }
}

type ProviderCall =
  | { ok: true; body: unknown }
  | { ok: false; status: number | null; message: string };

/** GET a provider REST path with the key, turning every failure into a readable message. */
async function callProvider(provider: string, path: string, apiKey: string): Promise<ProviderCall> {
  const base = PROVIDER_API_BASE[provider];
  if (!base) {
    return { ok: false, status: null, message: `${provider} is not an API-key provider.` };
  }
  let response: globalThis.Response;
  try {
    response = await fetch(`${base}${path}`, {
      headers: authHeaders(provider, apiKey),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      status: null,
      message: `Could not reach ${provider}: ${(err as Error).message}`,
    };
  }
  if (response.ok) {
    try {
      return { ok: true, body: await response.json() };
    } catch {
      return { ok: false, status: response.status, message: `${provider} sent an unreadable reply.` };
    }
  }
  const detail = await readErrorDetail(response);
  const suffix = detail ? ` (${detail})` : '';
  // Gemini answers a bad key with 400 "API key not valid" rather than 401.
  const badKey =
    response.status === 401 ||
    response.status === 403 ||
    (response.status === 400 && /api key/i.test(detail));
  return {
    ok: false,
    status: response.status,
    message: badKey
      ? `${provider} rejected the API key${suffix}.`
      : `${provider} returned HTTP ${response.status}${suffix}.`,
  };
}

/**
 * Check an API key against the provider by fetching the chosen model's
 * metadata. That one cheap, token-free call proves both that the key
 * authenticates and that the model id exists for it.
 */
async function probeProvider(
  provider: string,
  modelId: string,
  apiKey: string,
): Promise<{ success: boolean; message: string }> {
  const result = await callProvider(provider, `/models/${encodeURIComponent(modelId)}`, apiKey);
  if (result.ok) {
    return {
      success: true,
      message: `Connected to ${provider}. The API key is valid and model ${modelId} is available.`,
    };
  }
  if (result.status === 404) {
    return {
      success: false,
      message: `The API key works, but ${provider} has no model "${modelId}". Pick another model.`,
    };
  }
  return { success: false, message: result.message };
}

// Pagination guard: providers list well under this many pages today.
const MAX_MODEL_PAGES = 10;

// OpenAI's /models also lists audio, image, embedding and moderation models
// the pipeline cannot drive as a chat agent; keep only chat-capable families.
const OPENAI_CHAT_MODEL = /^(gpt-|o\d|chatgpt-)/;
const OPENAI_NON_CHAT = /(audio|realtime|transcribe|tts|image|search|embedding|moderation|instruct)/;

/** The models this key can call, newest first where the provider says when. */
async function listProviderModels(
  provider: string,
  apiKey: string,
): Promise<{ success: boolean; message: string; models: ProviderModel[] }> {
  const models: ProviderModel[] = [];

  if (provider === 'Anthropic') {
    let afterId: string | null = null;
    for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
      const qs: string = afterId ? `&after_id=${encodeURIComponent(afterId)}` : '';
      const result = await callProvider(provider, `/models?limit=1000${qs}`, apiKey);
      if (!result.ok) return { success: false, message: result.message, models: [] };
      const body = result.body as {
        data?: { id: string; display_name?: string }[];
        has_more?: boolean;
        last_id?: string | null;
      };
      for (const m of body.data ?? []) models.push({ id: m.id, label: m.display_name || m.id });
      if (!body.has_more || !body.last_id) break;
      afterId = body.last_id;
    }
    // Anthropic already returns newest first.
  } else if (provider === 'OpenAI') {
    const result = await callProvider(provider, '/models', apiKey);
    if (!result.ok) return { success: false, message: result.message, models: [] };
    const data = ((result.body as { data?: { id: string; created?: number }[] }).data ?? [])
      .filter((m) => OPENAI_CHAT_MODEL.test(m.id) && !OPENAI_NON_CHAT.test(m.id))
      .sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
    for (const m of data) models.push({ id: m.id, label: m.id });
  } else if (provider === 'Google Gemini') {
    let pageToken: string | null = null;
    for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
      const qs: string = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
      const result = await callProvider(provider, `/models?pageSize=1000${qs}`, apiKey);
      if (!result.ok) return { success: false, message: result.message, models: [] };
      const body = result.body as {
        models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[];
        nextPageToken?: string;
      };
      for (const m of body.models ?? []) {
        if (!m.supportedGenerationMethods?.includes('generateContent')) continue;
        const id = m.name.replace(/^models\//, '');
        models.push({ id, label: m.displayName || id });
      }
      if (!body.nextPageToken) break;
      pageToken = body.nextPageToken;
    }
  } else {
    return { success: false, message: `${provider} does not use an API key.`, models: [] };
  }

  return {
    success: true,
    message: `API key is valid. ${models.length} ${provider} model${models.length === 1 ? '' : 's'} available.`,
    models,
  };
}

const DEFAULT_CONFIG: ConfigResponse = {
  model_provider: 'AWS Bedrock',
  model_id: 'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
  embeddings_model: 'basel/ATTACK-BERT',
  default_browse_path: process.cwd(),
  aws_profile: null,
};

// Module-level config override (for testing); null → auto-detect.
let _config: ConfigResponse | null = null;

export function setConfig(config: ConfigResponse | null): void {
  _config = config;
}

/**
 * Resolve config.yaml using the same order as the pipeline Config: cwd first,
 * then repo root. Returns the canonical CLI location even if neither exists, so
 * save creates the file there.
 */
function resolveConfigPath(): string {
  const cwdConfig = join('.threatforest', 'config.yaml');
  if (existsSync(cwdConfig)) return cwdConfig;
  return join(process.cwd(), '.threatforest', 'config.yaml');
}

function loadConfigFromYaml(path: string): ConfigResponse {
  const raw = (parseYaml(readFileSync(path, 'utf-8')) as Record<string, unknown> | null) ?? {};

  const embeddings = (raw.embeddings as Record<string, unknown> | undefined) ?? {};
  const embeddingsModel = (embeddings.model as string | undefined) ?? DEFAULT_CONFIG.embeddings_model;

  let modelProvider = DEFAULT_CONFIG.model_provider;
  let modelId = DEFAULT_CONFIG.model_id;
  let awsProfile: string | null = null;

  for (const [yamlKey, providerName] of Object.entries(KEY_TO_PROVIDER)) {
    if (yamlKey in raw) {
      const section = (raw[yamlKey] && typeof raw[yamlKey] === 'object'
        ? (raw[yamlKey] as Record<string, unknown>)
        : {}) as Record<string, unknown>;
      modelProvider = providerName;
      modelId = (section.model_id as string | undefined) ?? DEFAULT_CONFIG.model_id;
      awsProfile = (section.aws_profile as string | undefined) ?? null;
      break;
    }
  }

  return {
    model_provider: modelProvider,
    model_id: modelId,
    embeddings_model: embeddingsModel,
    default_browse_path: process.cwd(),
    aws_profile: awsProfile,
  };
}

function getConfig(): ConfigResponse {
  if (_config !== null) return _config;
  const path = resolveConfigPath();
  if (existsSync(path)) return loadConfigFromYaml(path);
  return {
    model_provider: DEFAULT_CONFIG.model_provider,
    model_id: DEFAULT_CONFIG.model_id,
    embeddings_model: DEFAULT_CONFIG.embeddings_model,
    default_browse_path: process.cwd(),
    aws_profile: null,
  };
}

/** GET /config — current model/provider configuration. */
configRouter.get('/config', (_req: Request, res: Response) => {
  res.json(getConfig());
});

/** GET /config/frameworks — available threat-mapping frameworks. */
configRouter.get('/config/frameworks', (_req: Request, res: Response) => {
  const frameworks: Record<string, { name: string; description: string }> = {};
  for (const [k, v] of Object.entries(FRAMEWORKS)) {
    frameworks[k] = { name: v.name ?? k, description: v.description ?? '' };
  }
  res.json({ frameworks });
});

/** GET /config/providers — available model providers. */
configRouter.get('/config/providers', (_req: Request, res: Response) => {
  const body: ProvidersResponse = { providers: AVAILABLE_PROVIDERS };
  res.json(body);
});

/** POST /config/test — validate a provider configuration. */
configRouter.post('/config/test', async (req: Request, res: Response) => {
  const parsed = ConfigTestRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ detail: parsed.error.issues });
    return;
  }
  const request = parsed.data;

  if (!request.provider || !request.provider.trim()) {
    res.json({ success: false, message: 'Provider is required.' });
    return;
  }
  if (!request.model_id || !request.model_id.trim()) {
    res.json({ success: false, message: 'Model ID is required.' });
    return;
  }
  if (!AVAILABLE_PROVIDERS.includes(request.provider)) {
    res.json({
      success: false,
      message: `Unknown provider '${request.provider}'. Available: ${AVAILABLE_PROVIDERS.join(', ')}`,
    });
    return;
  }

  // AWS Bedrock: the Python path does an STS get_caller_identity probe via boto3.
  // That dep isn't part of the TS engine; credentials are validated on first
  // model call instead. Keep the success/contract shape stable.
  if (request.provider === 'AWS Bedrock') {
    res.json({
      success: true,
      message:
        'AWS Bedrock configured. Credentials are validated on first use via the ' +
        'AWS SDK default credential chain (profile/role/env).',
    });
    return;
  }

  // API-key providers: use the key typed in the form, else the one the server
  // already holds (browser-supplied or from its launch environment), and make
  // a real call to the provider with it.
  const envVar = PROVIDER_ENV_VAR[request.provider];
  const apiKey = request.api_key?.trim() || (envVar ? process.env[envVar] : undefined);
  if (!apiKey) {
    res.json({
      success: false,
      message:
        `${request.provider} requires an API key. Paste one into the API key field` +
        (envVar ? `, or set ${envVar} before starting the server.` : '.'),
    });
    return;
  }

  res.json(await probeProvider(request.provider, request.model_id, apiKey));
});

/**
 * POST /config/provider-models — list the models an API key can call. POST,
 * not GET, so a key typed in the form travels in the body rather than a URL.
 * With no key in the body, the key the server already holds is used.
 */
configRouter.post('/config/provider-models', async (req: Request, res: Response) => {
  const parsed = ProviderModelsRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ detail: parsed.error.issues });
    return;
  }
  const { provider, api_key } = parsed.data;
  const envVar = PROVIDER_ENV_VAR[provider];
  if (!envVar) {
    const body: ProviderModelsResponse = {
      success: false,
      message: `${provider} does not use an API key.`,
      models: [],
    };
    res.json(body);
    return;
  }
  const apiKey = api_key?.trim() || process.env[envVar];
  if (!apiKey) {
    const body: ProviderModelsResponse = {
      success: false,
      message: `${provider} requires an API key. Paste one into the API key field, or set ${envVar} before starting the server.`,
      models: [],
    };
    res.json(body);
    return;
  }
  const body: ProviderModelsResponse = await listProviderModels(provider, apiKey);
  res.json(body);
});

/** POST /config/api-key — set (or clear) a provider key held in memory only. */
configRouter.post('/config/api-key', (req: Request, res: Response) => {
  const parsed = ApiKeySetRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ detail: parsed.error.issues });
    return;
  }
  const { provider, api_key } = parsed.data;
  const envVar = PROVIDER_ENV_VAR[provider];
  if (!envVar) {
    res.json({ success: false, message: `${provider} does not use an API key.` });
    return;
  }

  const key = api_key?.trim();
  if (key) {
    process.env[envVar] = key;
    browserKeyVars.add(envVar);
    res.json({ success: true, message: `${provider} API key set for this server session.` });
    return;
  }

  const launch = LAUNCH_ENV[envVar];
  if (launch === undefined) delete process.env[envVar];
  else process.env[envVar] = launch;
  browserKeyVars.delete(envVar);
  res.json({ success: true, message: `${provider} API key cleared.` });
});

/** GET /config/api-key-status?provider=… — whether a key is set (never the key). */
configRouter.get('/config/api-key-status', (req: Request, res: Response) => {
  const provider = typeof req.query.provider === 'string' ? req.query.provider : '';
  const envVar = PROVIDER_ENV_VAR[provider] ?? null;
  const configured = envVar ? Boolean(process.env[envVar]) : false;
  const body: ApiKeyStatusResponse = {
    configured,
    source: !envVar || !configured ? null : browserKeyVars.has(envVar) ? 'browser' : 'environment',
    env_var: envVar,
  };
  res.json(body);
});

/** POST /config/save — persist provider config to `.threatforest/config.yaml`. */
configRouter.post('/config/save', (req: Request, res: Response) => {
  const parsed = ConfigSaveRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ detail: parsed.error.issues });
    return;
  }
  const request = parsed.data;

  if (!request.provider || !request.provider.trim()) {
    res.status(400).json({ detail: 'Provider is required.' });
    return;
  }
  if (!request.model_id || !request.model_id.trim()) {
    res.status(400).json({ detail: 'Model ID is required.' });
    return;
  }

  const yamlKey = PROVIDER_TO_KEY[request.provider];
  if (yamlKey === undefined) {
    res.status(400).json({
      detail: `Unknown provider '${request.provider}'. Available: ${AVAILABLE_PROVIDERS.join(', ')}`,
    });
    return;
  }

  const configPath = resolveConfigPath();

  const providerSection: Record<string, unknown> = { model_id: request.model_id };
  if (request.aws_profile) providerSection.aws_profile = request.aws_profile;

  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    existing = (parseYaml(readFileSync(configPath, 'utf-8')) as Record<string, unknown> | null) ?? {};
  }
  // Remove all provider keys, then set the new one.
  for (const key of Object.values(PROVIDER_TO_KEY)) {
    delete existing[key];
  }
  existing[yamlKey] = providerSection;

  try {
    mkdirSync(dirname(configPath), { recursive: true });
    // Default key ordering preserves insertion order (matches `sort_keys=False`).
    writeFileSync(configPath, stringifyYaml(existing), 'utf-8');
  } catch (err) {
    res.status(500).json({ detail: `Failed to write config: ${(err as Error).message}` });
    return;
  }

  // Reset route cache + the pipeline Config singleton so the next read/run picks
  // up the new file.
  setConfig(null);
  try {
    engineConfig.reset();
  } catch {
    /* non-fatal */
  }

  res.json({ success: true, message: 'Configuration saved successfully.' });
});

// ---------------------------------------------------------------------------
// Langfuse tracing config. The Python path reads/writes a `.env` via EnvManager
// and does a live auth-check with the langfuse SDK. In TS we read process.env
// for the GET, and the live check is reported as configured-on-save (the SDK
// auth probe is a Python-only dep). Response shapes are unchanged.
// ---------------------------------------------------------------------------

/** GET /config/langfuse — current Langfuse tracing configuration. */
configRouter.get('/config/langfuse', (_req: Request, res: Response) => {
  res.json({
    enabled: process.env.LANGFUSE_ENABLED === 'true',
    public_key: process.env.LANGFUSE_PUBLIC_KEY ?? null,
    secret_key_configured: Boolean(process.env.LANGFUSE_SECRET_KEY),
    host: process.env.LANGFUSE_HOST || 'https://cloud.langfuse.com',
  });
});

/** POST /config/langfuse/test — test Langfuse connectivity. */
configRouter.post('/config/langfuse/test', (req: Request, res: Response) => {
  const parsed = LangfuseConfigSaveRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ detail: parsed.error.issues });
    return;
  }
  const request = parsed.data;
  const publicKey = request.public_key || process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = request.secret_key || process.env.LANGFUSE_SECRET_KEY;

  if (!publicKey || !secretKey) {
    res.json({
      success: false,
      message: 'Public key and secret key are required to test the connection.',
    });
    return;
  }
  res.json({
    success: true,
    message: 'Langfuse credentials present. Connectivity is verified when tracing starts.',
  });
});

/** POST /config/langfuse — save Langfuse tracing configuration. */
configRouter.post('/config/langfuse', (req: Request, res: Response) => {
  const parsed = LangfuseConfigSaveRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ detail: parsed.error.issues });
    return;
  }
  const request = parsed.data;
  if (request.enabled && (!request.public_key || !request.secret_key)) {
    res.status(400).json({
      detail: 'Public key and secret key are required when enabling Langfuse.',
    });
    return;
  }

  // Persist to the process environment so the engine tracing layer (which reads
  // LANGFUSE_* env) picks them up. (The Python path wrote a `.env`; the TS engine
  // reads env directly, so we set env vars in-process.)
  process.env.LANGFUSE_ENABLED = request.enabled ? 'true' : 'false';
  if (request.public_key) process.env.LANGFUSE_PUBLIC_KEY = request.public_key;
  if (request.secret_key) process.env.LANGFUSE_SECRET_KEY = request.secret_key;
  process.env.LANGFUSE_HOST = request.host;

  res.json({ success: true, message: 'Langfuse configuration saved.' });
});
