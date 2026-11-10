import { sshExec } from '../lib/ssh.js';
import { cfg } from '../config.js';
import { selectPending, skippedWithUpdate, upgradeSkipList } from '../lib/engine.js';
import { acquireEngineLock } from '../lib/engineLock.js';

export { selectPending };

function jobId(raw) {
  const id = parseInt(raw, 10);
  if (!id) throw new Error(`Unexpected response from midclt: ${raw}`);
  return id;
}

/**
 * Upgrades every app that has an update waiting, except the engine apps that
 * are not active: upgrading a stopped app may start it, putting both engines
 * on the same GPUs.
 *
 * The app list — states included — is read here, at click time and under the
 * shared engine lock, rather than from the polled cache: the active engine
 * and the skip list must match the moment of the call, not a state a running
 * switch has already changed. With llama.cpp configured, an unreadable list
 * fails closed with HTTP 503 and nothing is upgraded.
 */
export async function upgradeApps(exec = sshExec) {
  const release = acquireEngineLock('upgrade');
  try {
    const configured = !!cfg.llamacppAppName;
    let all;
    try {
      const raw = await exec(
        `midclt call app.query '[]' '{"select":["name","state","upgrade_available","image_updates_available"]}'`
      );
      all = JSON.parse(raw);
      if (!Array.isArray(all)) throw new Error('app.query did not return a list');
    } catch (err) {
      if (configured) throw Object.assign(new Error(`Cannot determine the active engine: ${err.message}`), { status: 503 });
      throw err;
    }
    const names = { ollama: cfg.ollamaAppName, llamacpp: cfg.llamacppAppName };
    const skip = upgradeSkipList(all, names, configured);
    const { charts, images } = selectPending(all, skip);
    const skippedNames = skippedWithUpdate(all, skip);
    const skippedName = skippedNames.length ? skippedNames.join(', ') : null;
    const apps = [...charts, ...images];
    if (!apps.length) return { ok: true, jobIds: [], apps: [], skipped: skippedName };

    const jobIds = [];

    if (charts.length) {
      // JSON.stringify never emits a single quote, so the '…' wrapper holds.
      const payload = JSON.stringify(charts.map(app_name => ({ app_name })));
      jobIds.push(jobId(await exec(`midclt call app.upgrade_bulk '${payload}'`)));
    }

    // No bulk form for image pulls; sequential keeps one failure from hiding
    // the others, and these return a job id immediately rather than blocking.
    for (const name of images) {
      jobIds.push(jobId(await exec(`midclt call app.pull_images '"${name}"' '{"redeploy":true}'`)));
    }

    return { ok: true, jobIds, apps, skipped: skippedName };
  } finally {
    release();
  }
}
