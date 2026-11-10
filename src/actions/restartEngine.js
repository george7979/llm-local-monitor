import { sshExec } from '../lib/ssh.js';
import { cfg } from '../config.js';
import { restartTarget } from '../lib/engine.js';
import { acquireEngineLock } from '../lib/engineLock.js';

const STOP_TIMEOUT_MS = 120_000; // a slow container can outlast sshExec's default 10 s
const GPU_RELEASE_MS = 3_000;    // app.restart skips this GPU init gap, hence stop + start

const sleep = ms => new Promise(r => setTimeout(r, ms));
const fail = (status, message) => Object.assign(new Error(message), { status });

/**
 * Restarts the active engine's app: stop (awaited with `midclt call -j`), 3 s
 * for the GPU, start. Holds the shared engine lock for the whole stop, so no
 * switch or upgrade can start the other engine meanwhile.
 *
 * The app is chosen from a fresh `app.query` taken under the lock, not from
 * the 2 s cache, which can still show the engine a switch has just stopped.
 * `procs` (GPU process rows) only break a conflict tie. A STOPPED app is just
 * started. Resolves once the start is queued.
 */
export async function restartEngine(procs = [], exec = sshExec, wait = sleep) {
  const release = acquireEngineLock('restart');
  try {
    const names = { ollama: cfg.ollamaAppName, llamacpp: cfg.llamacppAppName };
    const filter = JSON.stringify([['name', 'in', [names.ollama, names.llamacpp].filter(Boolean)]]);
    const raw = await exec(`midclt call app.query '${filter}' '{"select":["name","state"]}'`);
    const { name, state } = restartTarget(JSON.parse(raw), procs, names, !!names.llamacpp);
    if (!name) throw fail(409, 'No engine is active');

    if (state !== 'STOPPED') {
      await exec(`midclt call -j app.stop '${name}' > /dev/null`, STOP_TIMEOUT_MS);
      await wait(GPU_RELEASE_MS);
    }
    await exec(`midclt call app.start '${name}' > /dev/null`);
    return { ok: true, app: name };
  } finally {
    release();
  }
}
