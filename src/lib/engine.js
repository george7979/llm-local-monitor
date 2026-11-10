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

const MIB = 1024 * 1024;

/** Bytes of VRAM held by one TrueNAS app, summed over every GPU process row it owns. */
export function appVramBytes(procs, appName) {
  if (!appName) return 0;
  return procs.filter(p => p.container === appName).reduce((sum, p) => sum + (p.vramMb || 0) * MIB, 0);
}

/**
 * The `engine` object of /api/status. `state` is getEngineState()'s result (or
 * a collector `{ error }`); `configured` = LLAMACPP_APP_NAME is set. `enabled`
 * means llama.cpp is configured AND its app exists. Unconfigured → `apps`
 * carries only `ollama`. An unusable state degrades to "no engine, switch off"
 * so the UI can disable the control instead of failing the whole poll.
 */
export function buildEngine(state, { configured, switching }) {
  if (!state || state.error) {
    return { active: null, conflict: false, notFound: null, apps: {}, updatesWaiting: false,
      switching, enabled: false, ...(state?.error ? { error: state.error } : {}) };
  }
  const apps = configured ? state.apps : { ollama: state.apps.ollama };
  return { ...state, apps, switching, enabled: configured && !!state.apps.llamacpp };
}

/** The inactive engine's app name, left out of "Update all apps"; null = skip nothing. */
export function skipNameFor(engine, names) {
  if (!engine?.enabled || !engine.active) return null;
  return (engine.active === 'ollama' ? names.llamacpp : names.ollama) || null;
}

/** Copies of the GPU cards with the engine holding each GPU (never mutates the cached originals). */
export function annotateGpus(gpu, procs, names) {
  if (!gpu?.gpus) return gpu;
  return { ...gpu, gpus: gpu.gpus.map(g => ({
    ...g,
    engine: gpuEngine(procs.filter(p => p.busId === g.busId), names),
  })) };
}

/**
 * What a switch has to do, from fresh app states (`[{ name, state }]`):
 * stop the other engine unless STOPPED, start the target only if STOPPED.
 * Nothing to do = no-op. `missing` = the target app does not exist.
 */
export function switchPlan(apps, target, names) {
  const targetName = names[target];
  const otherName = names[target === 'ollama' ? 'llamacpp' : 'ollama'];
  const stateOf = name => apps.find(a => a.name === name)?.state;
  if (!stateOf(targetName)) return { missing: true, stop: null, start: null, noop: false };
  const otherState = stateOf(otherName);
  const stop = otherState && otherState !== 'STOPPED' ? otherName : null;
  const start = stateOf(targetName) === 'STOPPED' ? targetName : null;
  return { missing: false, stop, start, noop: !stop && !start };
}
