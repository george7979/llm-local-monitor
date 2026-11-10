import { sshExec } from '../lib/ssh.js';
import { cfg } from '../config.js';
import { restartTarget } from '../lib/engine.js';
import { acquireEngineLock } from '../lib/engineLock.js';
import { withPendingJobs, parseAppsAndJobs, refuseWhileEngineJobs } from '../lib/truenasJobs.js';

const JOB_TIMEOUT_MS = 120_000;  // a stop or start job can outlast sshExec's default 10 s
const GPU_RELEASE_MS = 3_000;    // app.restart skips this GPU init gap, hence stop + start

const sleep = ms => new Promise(r => setTimeout(r, ms));
const fail = (status, message) => Object.assign(new Error(message), { status });

/**
 * Restarts the active engine's app: stop, 3 s for the GPU, start — both
 * awaited with `midclt call -j`, so it resolves when the start job has
 * finished. Holds the shared engine lock throughout, so no switch or upgrade
 * of this monitor can start the other engine meanwhile.
 *
 * The app is chosen from a fresh `app.query` taken under the lock, not from
 * the 2 s cache, which can still show the engine a switch has just stopped;
 * the pending TrueNAS jobs come in the same round trip, and one still running
 * on an engine app (only the Ollama app with llama.cpp unset) refuses with
 * 409, an unreadable job list with 503. `procs` (GPU process rows) only break
 * a conflict tie. A STOPPED app is just started.
 */
export async function restartEngine(procs = [], exec = sshExec, wait = sleep) {
  const release = acquireEngineLock('restart');
  try {
    const names = { ollama: cfg.ollamaAppName, llamacpp: cfg.llamacppAppName };
    const filter = JSON.stringify([['name', 'in', [names.ollama, names.llamacpp].filter(Boolean)]]);
    const read = parseAppsAndJobs(await exec(withPendingJobs(`midclt call app.query '${filter}' '{"select":["name","state"]}'`)));
    refuseWhileEngineJobs(read, names);
    const { name, state } = restartTarget(read.apps, procs, names, !!names.llamacpp);
    if (!name) throw fail(409, 'No engine is active');

    if (state !== 'STOPPED') {
      await exec(`midclt call -j app.stop '${name}' > /dev/null`, JOB_TIMEOUT_MS);
      await wait(GPU_RELEASE_MS);
    }
    await exec(`midclt call -j app.start '${name}' > /dev/null`, JOB_TIMEOUT_MS);
    return { ok: true, app: name };
  } finally {
    release();
  }
}
