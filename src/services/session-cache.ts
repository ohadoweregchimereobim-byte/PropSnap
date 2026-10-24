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

/** Keep `value` for `key` for maxAgeMs, and drop entries that are too old while at it */
export async function writeCache<T>(key: string, value: T, maxAgeMs: number): Promise<void> {
  try {
    const store = session();
    if (!store) return;
    const all = await store.get(null);
    const stale = Object.entries(all)
      .filter(([k, e]) => {
        const until = (e as Entry<unknown> | undefined)?.until;
        return k.startsWith(PREFIX) && !(typeof until === 'number' && Date.now() < until);
      })
      .map(([k]) => k);
    if (stale.length) await store.remove(stale);
    const now = Date.now();
    await store.set({ [PREFIX + key]: { at: now, until: now + maxAgeMs, value } satisfies Entry<T> });
  } catch {
    // A full or missing cache only costs a new request next time
  }
}
