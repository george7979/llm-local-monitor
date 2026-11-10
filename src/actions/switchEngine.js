import { sshExec } from '../lib/ssh.js';
import { cfg } from '../config.js';
import { switchPlan } from '../lib/engine.js';
import { acquireEngineLock } from '../lib/engineLock.js';

const STOP_TIMEOUT_MS = 120_000; // a slow container can outlast sshExec's default 10 s
const GPU_RELEASE_MS = 3_000;    // same gap the restart action uses

const LABELS = { ollama: 'Ollama', llamacpp: 'llama.cpp' };

const fail = (status, message) => Object.assign(new Error(message), { status });

/**
 * Moves the GPUs to `target` ('ollama' | 'llamacpp'): stop the other engine's
 * app (awaited), wait for the GPU to be released, start the target. Resolves
 * once the start is queued; the app reaching RUNNING is the poll's business.
 *
 * App states are read fresh here, not from the 2 s cache, so the plan cannot
 * be built on a state that the previous switch has already changed. The
 * shared engine lock (also held by restart and "Update all apps") is taken
 * before the first await, so no other engine action can run in between.
 */
export async function switchEngine(target, exec = sshExec) {
  const release = acquireEngineLock('switch');
  try {
    const names = { ollama: cfg.ollamaAppName, llamacpp: cfg.llamacppAppName };
    const filter = JSON.stringify([['name', 'in', [names.ollama, names.llamacpp]]]);
    const raw = await exec(`midclt call app.query '${filter}' '{"select":["name","state"]}'`);
    const plan = switchPlan(JSON.parse(raw), target, names);
    if (plan.missing) throw fail(404, 'Both engine apps must exist to switch');
    if (plan.stopping) throw fail(409, `${LABELS[target]} is still stopping — try again in a moment`);
    if (plan.noop) return { ok: true, target, noop: true };

    if (plan.stop) {
      await exec(`midclt call -j app.stop '${plan.stop}' > /dev/null`, STOP_TIMEOUT_MS);
      await new Promise(r => setTimeout(r, GPU_RELEASE_MS));
    }
    if (plan.start) await exec(`midclt call app.start '${plan.start}' > /dev/null`);
    return { ok: true, target, noop: false };
  } finally {
    release();
  }
}
