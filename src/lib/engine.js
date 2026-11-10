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
 * `skip` (a name, a list of names or null: the engine apps that are not active) is left out; `skipped` reports that it had
 * an update pending.
 */
export function selectPending(apps, skip = null) {
  const skipSet = new Set([skip].flat().filter(Boolean));
  const charts = [], images = [];
  let skipped = false;
  for (const a of apps) {
    const pending = a.upgrade_available || a.image_updates_available;
    if (skipSet.has(a.name)) {
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
 * a collector `{ error }`); `configured` = LLAMACPP_APP_NAME is set;
 * `switching` = an engine action holds the lock, `action` = which one. `enabled`
 * means llama.cpp is configured AND its app exists. Unconfigured → `apps`
 * carries only `ollama`. An unusable state degrades to "no engine, switch off"
 * so the UI can disable the control instead of failing the whole poll.
 */
export function buildEngine(state, { configured, switching, action = null, busy = null }) {
  if (!state || state.error) {
    // The app cannot be checked, so `enabled` reflects configuration alone.
    return { active: null, conflict: false, notFound: null, apps: {}, updatesWaiting: false,
      switching, action, busy, enabled: configured, ...(state?.error ? { error: state.error } : {}) };
  }
  const apps = configured ? state.apps : { ollama: state.apps.ollama };
  return { ...state, apps, switching, action, busy, enabled: configured && !!state.apps.llamacpp };
}

// TrueNAS job methods that can start, stop or redeploy an app.
const APP_JOB_METHODS = new Set(['app.start', 'app.stop', 'app.redeploy', 'app.update', 'app.upgrade',
  'app.upgrade_bulk', 'app.pull_images', 'app.rollback', 'app.delete']);
const JOB_PENDING_STATES = new Set(['WAITING', 'RUNNING']);

/** The engine app a job argument names: a string, an object's `app_name`, or either inside (nested) arrays. */
function argumentApp(arg, wanted) {
  if (typeof arg === 'string') return wanted.has(arg) ? arg : null;
  if (Array.isArray(arg)) {
    for (const a of arg) {
      const name = argumentApp(a, wanted);
      if (name) return name;
    }
    return null;
  }
  if (arg && typeof arg === 'object' && typeof arg.app_name === 'string') return wanted.has(arg.app_name) ? arg.app_name : null;
  return null;
}

/**
 * TrueNAS jobs (`core.get_jobs` rows) still WAITING or RUNNING that act on an
 * engine app — while one runs, it can start an engine behind a switch's back.
 * Exact app-name equality only; object values other than `app_name` are not
 * searched (an `app.update` carries the whole compose config). `names` =
 * `{ ollama, llamacpp }`, llamacpp may be null. Malformed rows are ignored.
 */
export function engineJobsPending(jobs, names) {
  if (!Array.isArray(jobs)) return [];
  const wanted = new Set([names.ollama, names.llamacpp].filter(n => typeof n === 'string' && n));
  const pending = [];
  for (const job of jobs) {
    if (!job || !JOB_PENDING_STATES.has(job.state) || !APP_JOB_METHODS.has(job.method) || !Array.isArray(job.arguments)) continue;
    const app = argumentApp(job.arguments, wanted);
    if (app) pending.push({ id: job.id, method: job.method, app });
  }
  return pending;
}

/**
 * Engine apps "Update all apps" must leave alone: with llama.cpp configured,
 * every engine app that is not the active one (both when none is active) —
 * upgrading a stopped app may start it. Not configured: nothing (v1.5.1).
 */
export function skipListFor(engine, names, configured) {
  if (!configured) return [];
  const activeName = engine?.active ? names[engine.active] : null;
  return [names.ollama, names.llamacpp].filter(n => n && n !== activeName);
}

/** The skipped apps that actually had an update pending. */
export function skippedWithUpdate(apps, skip) {
  const skipSet = new Set([skip].flat().filter(Boolean));
  return apps.filter(a => skipSet.has(a.name) && (a.upgrade_available || a.image_updates_available)).map(a => a.name);
}

/**
 * App the app card acts on. `enabled` = llama.cpp configured AND its app
 * exists (engine.enabled). Not enabled: always the Ollama app, whatever its
 * state (v1.5.1). Enabled: the active engine's app, else null.
 */
export function engineAppName(engine, names, enabled) {
  if (!enabled) return names.ollama;
  return engine?.active ? names[engine.active] : null;
}

/**
 * Where the model card's data comes from: 'ollama' (`/api/ps`), 'llamacpp'
 * (llama-server) or null (no engine). Not enabled (llama.cpp unset or its app
 * not found) → always Ollama, whatever the app list says (v1.5.1).
 */
export function modelsSource(engine) {
  if (!engine?.enabled) return 'ollama';
  return engine.active === 'ollama' || engine.active === 'llamacpp' ? engine.active : null;
}

const appByName = (apps, name) => (name ? apps.find(a => a.name === name) : undefined);

/**
 * The app a restart acts on, from fresh app states (`[{ name, state }]`).
 * llama.cpp not configured or its app missing: the Ollama app, whatever its
 * state. Otherwise the active engine (GPU holder on a conflict), `name: null`
 * when none is active.
 */
export function restartTarget(apps, procs, names, configured) {
  const ollama = appByName(apps, names.ollama);
  const llamacpp = configured ? appByName(apps, names.llamacpp) : undefined;
  if (!llamacpp) return { name: names.ollama, state: ollama?.state ?? null };
  const { active } = pickEngine({ ollama, llamacpp }, procs, names);
  if (!active) return { name: null, state: null };
  return { name: names[active], state: (active === 'ollama' ? ollama : llamacpp).state };
}

/**
 * Engine apps "Update all apps" leaves alone, from fresh app states. llama.cpp
 * not configured or its app missing: none (v1.5.1). Otherwise every engine app
 * that is not the active one — both when none is active, and both on a
 * conflict, where no GPU process list is at hand to pick the winner.
 */
export function upgradeSkipList(apps, names, configured) {
  const llamacpp = configured ? appByName(apps, names.llamacpp) : undefined;
  if (!llamacpp) return [];
  const { active, conflict } = pickEngine({ ollama: appByName(apps, names.ollama), llamacpp }, [], names);
  return skipListFor({ active: conflict ? null : active }, names, true);
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
 * Nothing to do = no-op. `missing` = an engine app does not exist.
 * `stopping` = the target is still STOPPING: it would finish stopping after
 * the switch and leave no engine, so the switch must refuse.
 */
export function switchPlan(apps, target, names) {
  const targetName = names[target];
  const otherName = names[target === 'ollama' ? 'llamacpp' : 'ollama'];
  const stateOf = name => apps.find(a => a.name === name)?.state;
  const targetState = stateOf(targetName);
  const otherState = stateOf(otherName);
  if (!targetState || !otherState) return { missing: true, stopping: false, stop: null, start: null, noop: false };
  if (targetState === 'STOPPING') return { missing: false, stopping: true, stop: null, start: null, noop: false };
  const stop = otherState !== 'STOPPED' ? otherName : null;
  const start = targetState === 'STOPPED' ? targetName : null;
  return { missing: false, stopping: false, stop, start, noop: !stop && !start };
}
