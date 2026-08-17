import { sshExec } from '../lib/ssh.js';

/**
 * Splits TrueNAS apps into the two upgrade paths the middleware exposes.
 *
 * `upgrade_available` is a catalog/chart version bump — handled in one shot by
 * `app.upgrade_bulk`, which pulls the new images along the way. An app whose
 * chart is current but whose image tag moved has only `image_updates_available`
 * and needs `app.pull_images`; there is no bulk form of that one.
 *
 * Pure on purpose — the SSH shell below is untestable, this is not.
 */
export function selectPending(apps) {
  const charts = [], images = [];
  for (const a of apps) {
    if (a.upgrade_available) charts.push(a.name);
    else if (a.image_updates_available) images.push(a.name);
  }
  return { charts, images };
}

function jobId(raw) {
  const id = parseInt(raw, 10);
  if (!id) throw new Error(`Unexpected response from midclt: ${raw}`);
  return id;
}

/**
 * Upgrades every app that has an update waiting.
 *
 * The app list is read here, at click time, rather than by a collector: the
 * dashboard deliberately monitors Ollama only, and this answer has to be fresh
 * at the moment of the call, not up to a poll interval stale.
 */
export async function upgradeApps() {
  const raw = await sshExec(
    `midclt call app.query '[]' '{"select":["name","upgrade_available","image_updates_available"]}'`
  );
  const { charts, images } = selectPending(JSON.parse(raw));
  const apps = [...charts, ...images];
  if (!apps.length) return { ok: true, jobIds: [], apps: [] };

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

  return { ok: true, jobIds, apps };
}
