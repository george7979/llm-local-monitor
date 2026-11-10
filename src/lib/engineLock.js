// One "engine action in progress" lock shared by the switch, the restart and
// "Update all apps". Any of them can start or stop an engine app, so letting
// two overlap can leave both engines running on the same GPUs.

const LABELS = {
  switch: 'An engine switch is in progress',
  restart: 'An engine restart is in progress',
  upgrade: 'An app upgrade is in progress',
};

let holder = null; // { kind, token } while an action runs

/** Kind of the action holding the lock ('switch' | 'restart' | 'upgrade'), or null. */
export const engineAction = () => holder?.kind ?? null;

/**
 * Takes the lock synchronously — call it before the first await — and returns
 * the release function for a `finally`. Throws an HTTP 409 error when another
 * action holds it; the refused caller gets no release function, so it can
 * never free someone else's lock.
 */
export function acquireEngineLock(kind) {
  if (holder) {
    throw Object.assign(new Error(`${LABELS[holder.kind] ?? 'An engine action is in progress'} — try again in a moment`), { status: 409 });
  }
  const token = {};
  holder = { kind, token };
  return () => { if (holder?.token === token) holder = null; };
}
