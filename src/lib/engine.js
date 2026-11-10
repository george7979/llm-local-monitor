// Pure engine-selection logic (Ollama vs llama.cpp). No imports on purpose.

/**
 * Which engine holds the GPU, by TrueNAS app name equality (gpuProcs.js puts
 * the app name in `container`). Never by binary name or substring: Ollama
 * ships its own `llama-server` binary. llama.cpp wins if both are present.
 */
export function gpuEngine(procsOnGpu, names) {
  const holds = name => !!name && procsOnGpu.some(p => p.container === name);
  if (holds(names.llamacpp)) return 'llamacpp';
  if (holds(names.ollama)) return 'ollama';
  return null;
}

const selected = app => !!app && !!app.state && app.state !== 'STOPPED';

/**
 * Picks the active engine from TrueNAS app states. An engine is "selected"
 * when its app exists and is not STOPPED (DEPLOYING/CRASHED count). Both
 * selected = conflict; the GPU holder decides, a tie goes to llamacpp.
 */
export function pickEngine(apps, procs, names) {
  const o = selected(apps.ollama);
  const l = selected(apps.llamacpp);
  if (o && l) {
    return { active: gpuEngine(procs, names) === 'ollama' ? 'ollama' : 'llamacpp', conflict: true };
  }
  if (l) return { active: 'llamacpp', conflict: false };
  if (o) return { active: 'ollama', conflict: false };
  return { active: null, conflict: false };
}

/**
 * Splits TrueNAS apps into the two upgrade paths the middleware exposes.
 *
 * `upgrade_available` is a catalog/chart version bump — handled in one shot by
 * `app.upgrade_bulk`, which pulls the new images along the way. An app whose
 * chart is current but whose image tag moved has only `image_updates_available`
 * and needs `app.pull_images`; there is no bulk form of that one.
 *
 * `skipName` (the inactive engine) is left out; `skipped` reports that it had
 * an update pending.
 */
export function selectPending(apps, skipName = null) {
  const charts = [], images = [];
  let skipped = false;
  for (const a of apps) {
    const pending = a.upgrade_available || a.image_updates_available;
    if (skipName && a.name === skipName) {
      if (pending) skipped = true;
      continue;
    }
    if (a.upgrade_available) charts.push(a.name);
    else if (a.image_updates_available) images.push(a.name);
  }
  return { charts, images, skipped };
}
