/**
 * A small cache in chrome.storage.session: answers from other services that
 * do not change often (sold prices, EPC certificates) are kept so the next
 * ask is instant. Session storage has its own quota, so the cache never
 * eats into the space saved listings use, and Chrome empties it when the
 * browser closes. Any cache error just means asking again.
 */

const PREFIX = 'propsnap_cache:';

interface Entry<T> {
  at: number;     // when it was kept
  until: number;  // when it is too old to use
  value: T;
}

function session(): chrome.storage.StorageArea | null {
  return typeof chrome !== 'undefined' && chrome.storage?.session ? chrome.storage.session : null;
}

/** The value kept for `key`, with when it was kept, or null when there is none or it is too old */
export async function readCache<T>(key: string): Promise<{ value: T; at: number } | null> {
  try {
    const store = session();
    if (!store) return null;
    const entry = (await store.get(PREFIX + key))[PREFIX + key] as Entry<T> | undefined;
    if (!entry || !(Date.now() < entry.until)) return null;
    return { value: entry.value, at: entry.at };
  } catch {
    return null;
  }
}

// Reading every entry to find old ones costs time, so do it at most this often
const PRUNE_EVERY_MS = 10 * 60_000;
let lastPrune = 0;

/** Remove old entries; with `all`, every entry (when the store is full) */
async function prune(store: chrome.storage.StorageArea, all = false): Promise<void> {
  lastPrune = Date.now();
  const entries = await store.get(null);
  const doomed = Object.entries(entries)
    .filter(([k, e]) => {
      if (!k.startsWith(PREFIX)) return false;
      const until = (e as Entry<unknown> | undefined)?.until;
      return all || !(typeof until === 'number' && Date.now() < until);
    })
    .map(([k]) => k);
  if (doomed.length) await store.remove(doomed);
}

/** Keep `value` for `key` for maxAgeMs, dropping old entries now and then */
export async function writeCache<T>(key: string, value: T, maxAgeMs: number): Promise<void> {
  const store = session();
  if (!store) return;
  const now = Date.now();
  const item = { [PREFIX + key]: { at: now, until: now + maxAgeMs, value } satisfies Entry<T> };
  try {
    if (now - lastPrune > PRUNE_EVERY_MS) await prune(store);
    await store.set(item);
  } catch {
    // Most likely the store is full: start the cache again and try once more.
    // If that fails too, the only cost is a new request next time.
    try {
      await prune(store, true);
      await store.set(item);
    } catch {
      // Give up quietly
    }
  }
}
