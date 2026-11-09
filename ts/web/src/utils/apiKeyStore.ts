/**
 * Provider API keys cached in this browser's IndexedDB, keyed by provider name
 * ("Anthropic", "OpenAI", "Google Gemini").
 *
 * The browser is the durable home of a key pasted into the Configure page. The
 * local server only holds it in memory, so after a server restart the key is
 * re-sent from here (see `syncStoredApiKeys`, called by AppShell on mount).
 *
 * Every call degrades to "no key" when IndexedDB is unavailable (private
 * window, blocked site data), so callers never need their own try/catch.
 */

import { setApiKey } from '@/api/client';

const DB_NAME = 'threatforest';
const DB_VERSION = 1;
const STORE = 'api-keys';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function getStoredApiKey(provider: string): Promise<string | null> {
  try {
    const value = await withStore<unknown>('readonly', (s) => s.get(provider));
    return typeof value === 'string' && value ? value : null;
  } catch {
    return null;
  }
}

export async function setStoredApiKey(provider: string, key: string): Promise<boolean> {
  try {
    await withStore('readwrite', (s) => s.put(key, provider));
    return true;
  } catch {
    return false;
  }
}

export async function deleteStoredApiKey(provider: string): Promise<void> {
  try {
    await withStore('readwrite', (s) => s.delete(provider));
  } catch {
    // nothing stored, or storage unavailable: either way there is no key now
  }
}

async function getAllStoredApiKeys(): Promise<Record<string, string>> {
  try {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const out: Record<string, string> = {};
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) {
            resolve(out);
            return;
          }
          if (typeof cursor.value === 'string' && cursor.value) {
            out[String(cursor.key)] = cursor.value;
          }
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  } catch {
    return {};
  }
}

/** Re-send every cached key to the server, which forgets them on restart. */
export async function syncStoredApiKeys(): Promise<void> {
  const keys = await getAllStoredApiKeys();
  await Promise.all(
    Object.entries(keys).map(([provider, key]) =>
      setApiKey(provider, key).catch(() => {
        // server unreachable right now; the next page load retries
      }),
    ),
  );
}
