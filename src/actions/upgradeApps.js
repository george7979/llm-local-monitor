import { sshExec } from '../lib/ssh.js';
import { selectPending, skippedWithUpdate } from '../lib/engine.js';

export { selectPending };

function jobId(raw) {
  const id = parseInt(raw, 10);
  if (!id) throw new Error(`Unexpected response from midclt: ${raw}`);
  return id;
}

/**
 * Upgrades every app that has an update waiting.
 *
 * The app list is read here, at click time, rather than by a collector: the
 * answer has to be fresh at the moment of the call, not up to a poll interval
 * stale. `skip` (the non-active engine apps; a name, a list or null) is never touched: upgrading a
 * stopped app may start it, putting both engines on the same GPUs.
 */
export async function upgradeApps(skip = null) {
  const raw = await sshExec(
    `midclt call app.query '[]' '{"select":["name","upgrade_available","image_updates_available"]}'`
  );
  const all = JSON.parse(raw);
  const { charts, images } = selectPending(all, skip);
  const skippedNames = skippedWithUpdate(all, skip);
  const skippedName = skippedNames.length ? skippedNames.join(', ') : null;
  const apps = [...charts, ...images];
  if (!apps.length) return { ok: true, jobIds: [], apps: [], skipped: skippedName };

  const jobIds = [];

  if (charts.length) {
    // JSON.stringify never emits a single quote, so the '…' wrapper holds.
    const payload = JSON.stringify(charts.map(app_name => ({ app_name })));
    jobIds.push(jobId(await sshExec(`midclt call app.upgrade_bulk '${payload}'`)));
  }

  // No bulk form for image pulls; sequential keeps one failure from hiding
  // the others, and these return a job id immediately rather than blocking.
  for (const name of images) {
    jobIds.push(jobId(await sshExec(`midclt call app.pull_images '"${name}"' '{"redeploy":true}'`)));
  }

  return { ok: true, jobIds, apps, skipped: skippedName };
}
