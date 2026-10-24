/**
 * Saves read the whole list, change one entry and write it all back. Two
 * saves at once (a capture in the background and a stage change on the
 * dashboard, or two tabs) could each read the old list, and the second
 * write would drop the first one's change. Running each save under a lock
 * stops that.
 *
 * navigator.locks is shared by every page and the service worker of the
 * extension, so the lock holds across tabs. Where it is missing (unit tests)
 * saves still run one after another within this page.
 */

const chains = new Map<string, Promise<unknown>>();

export function withLock<T>(name: string, task: () => Promise<T>): Promise<T> {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  if (locks) return locks.request(`propsnap:${name}`, task);

  const run = (chains.get(name) ?? Promise.resolve()).then(task);
  chains.set(name, run.catch(() => undefined));
  return run;
}
