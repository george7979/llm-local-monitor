import { sshExec } from '../lib/ssh.js';
import { cfg } from '../config.js';
import { switchPlan } from '../lib/engine.js';

const STOP_TIMEOUT_MS = 120_000; // a slow container can outlast sshExec's default 10 s
const GPU_RELEASE_MS = 3_000;    // same gap the restart action uses

let switching = false;

export const isSwitching = () => switching;

const fail = (status, message) => Object.assign(new Error(message), { status });

/**
 * Moves the GPUs to `target` ('ollama' | 'llamacpp'): stop the other engine's
 * app (awaited), wait for the GPU to be released, start the target. Resolves
 * once the start is queued; the app reaching RUNNING is the poll's business.
 *
 * App states are read fresh here, not from the 2 s cache, so the plan cannot
 * be built on a state that the previous switch has already changed. The flag
 * is taken before the first await, so two simultaneous requests cannot both
 * get in.
 */
export async function switchEngine(target) {
  if (switching) throw fail(409, 'Switch already in progress');
  switching = true;
  try {
    const names = { ollama: cfg.ollamaAppName, llamacpp: cfg.llamacppAppName };
    const filter = JSON.stringify([['name', 'in', [names.ollama, names.llamacpp]]]);
    const raw = await sshExec(`midclt call app.query '${filter}' '{"select":["name","state"]}'`);
    const plan = switchPlan(JSON.parse(raw), target, names);
    if (plan.missing) throw fail(404, `App not found: ${names[target]}`);
    if (plan.noop) return { ok: true, target, noop: true };

    if (plan.stop) {
      await sshExec(`midclt call -j app.stop '${plan.stop}' > /dev/null`, STOP_TIMEOUT_MS);
      await new Promise(r => setTimeout(r, GPU_RELEASE_MS));
    }
    if (plan.start) await sshExec(`midclt call app.start '${plan.start}' > /dev/null`);
    return { ok: true, target, noop: false };
  } finally {
    switching = false;
  }
}
