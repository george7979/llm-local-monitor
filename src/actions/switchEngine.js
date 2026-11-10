import { sshExec } from '../lib/ssh.js';
import { cfg } from '../config.js';
import { switchPlan } from '../lib/engine.js';
import { acquireEngineLock } from '../lib/engineLock.js';
import { withPendingJobs, parseAppsAndJobs, refuseWhileEngineJobs } from '../lib/truenasJobs.js';

const JOB_TIMEOUT_MS = 120_000;  // a stop or start job can outlast sshExec's default 10 s
const GPU_RELEASE_MS = 3_000;    // same gap the restart action uses

const LABELS = { ollama: 'Ollama', llamacpp: 'llama.cpp' };

const fail = (status, message) => Object.assign(new Error(message), { status });

/**
 * Moves the GPUs to `target` ('ollama' | 'llamacpp'): stop the other engine's
 * app (awaited), wait for the GPU to be released, start the target (awaited
 * too: resolves when the start job has finished — the container is up, the
 * model may still be loading).
 *
 * App states and pending TrueNAS jobs are read fresh here, in one ssh round
 * trip, not from the 2 s cache, so the plan cannot be built on a state that
 * the previous switch has already changed. A job still running on an engine
 * app (started by an upgrade or from the TrueNAS UI) refuses the switch with
 * 409, an unreadable job list with 503. The shared engine lock (also held by
 * restart and "Update all apps") is taken before the first await, so no other
 * engine action of this monitor can run in between.
 */
export async function switchEngine(target, exec = sshExec) {
  const release = acquireEngineLock('switch');
  try {
    const names = { ollama: cfg.ollamaAppName, llamacpp: cfg.llamacppAppName };
    const filter = JSON.stringify([['name', 'in', [names.ollama, names.llamacpp]]]);
    const read = parseAppsAndJobs(await exec(withPendingJobs(`midclt call app.query '${filter}' '{"select":["name","state"]}'`)));
    refuseWhileEngineJobs(read, names);
    const plan = switchPlan(read.apps, target, names);
    if (plan.missing) throw fail(404, 'Both engine apps must exist to switch');
    if (plan.stopping) throw fail(409, `${LABELS[target]} is still stopping — try again in a moment`);
    if (plan.noop) return { ok: true, target, noop: true };

    if (plan.stop) {
      await exec(`midclt call -j app.stop '${plan.stop}' > /dev/null`, JOB_TIMEOUT_MS);
      await new Promise(r => setTimeout(r, GPU_RELEASE_MS));
    }
    if (plan.start) await exec(`midclt call -j app.start '${plan.start}' > /dev/null`, JOB_TIMEOUT_MS);
    return { ok: true, target, noop: false };
  } finally {
    release();
  }
}
