import { Router } from 'express';
import { cfg } from './config.js';
import { getHostStatus } from './collectors/host.js';
import { getIpmiStatus } from './collectors/ipmi.js';
import { getUptime } from './collectors/uptime.js';
import { getOllamaStatus } from './collectors/ollama.js';
import { getEngineAppStats } from './collectors/engineApp.js';
import { getAppsAndJobs, getEngineState, getLaunchInfo } from './collectors/engineApps.js';
import { getLlamacppStatus } from './collectors/llamacpp.js';
import { getAvailableModels, findModel } from './collectors/ollamaModels.js';
import { getGpuStatus } from './collectors/gpu.js';
import { getGpuProcs } from './collectors/gpuProcs.js';
import { getMemoryStatus } from './collectors/memory.js';
import { getNetworkStatus } from './collectors/network.js';
import { wakeServer } from './actions/wake.js';
import { sleepServer } from './actions/sleep.js';
import { restartEngine } from './actions/restartEngine.js';
import { switchEngine } from './actions/switchEngine.js';
import { upgradeApps } from './actions/upgradeApps.js';
import { checkUpdate } from './actions/checkUpdate.js';
import { loadModel } from './actions/loadModel.js';
import { unloadModel } from './actions/unloadModel.js';
import { appVramBytes, buildEngine, engineAppName, annotateGpus, modelsSource, engineJobsPending } from './lib/engine.js';
import { engineAction } from './lib/engineLock.js';

export const router = Router();

router.get('/config', (_req, res) => {
  res.json({ llmHost: cfg.llmHost, truenasUrl: cfg.truenasUrl, pollIntervalSec: cfg.pollIntervalSec, version: cfg.version });
});

function safeCollect(fn) {
  return fn().catch(err => ({ error: err.message }));
}

const engineNames = () => ({ ollama: cfg.ollamaAppName, llamacpp: cfg.llamacppAppName });
// llama.cpp configured but its app not found behaves as the feature off: the Ollama app.
const appNameOf = engine => engineAppName(engine, engineNames(), !!engine.enabled);

/**
 * `engine.switching` = an engine action of this monitor holds the lock;
 * `engine.action` says which; `engine.busy` = a TrueNAS job still running on
 * an engine app (`{ app, method }`), null when none or when the job list
 * could not be read.
 */
const engineOpts = (busy = null) => ({ configured: !!cfg.llamacppAppName, switching: !!engineAction(), action: engineAction(), busy });

function busyFrom(jobs) {
  const [job] = engineJobsPending(jobs ?? [], engineNames());
  return job ? { app: job.app, method: job.method } : null;
}

/**
 * The GPU process list and the app list (with the pending TrueNAS jobs, same
 * ssh command) are read in parallel; the engine state needs both (the
 * conflict tie-break uses the process list). A failed
 * process collector means "no GPU holders", not a failed call — `gpuProcs` is
 * still returned as-is (with its `error`) for the UI.
 */
function readEngine() {
  const gpuProcs = safeCollect(getGpuProcs);
  const read = safeCollect(getAppsAndJobs);
  const engine = Promise.all([gpuProcs, read]).then(async ([g, r]) => {
    const procs = g.procs ?? [];
    const state = r.error ? r : await safeCollect(() => getEngineState(procs, r.apps));
    return { engine: buildEngine(state, engineOpts(r.error ? null : busyFrom(r.jobs))), procs };
  });
  return { gpuProcs, engine };
}

/**
 * The active engine's loaded models (Ollama `/api/ps` or llama-server), null
 * when none. Without llama.cpp (not configured, or its app not found) Ollama
 * is always asked, whatever the app list says — as v1.5.1.
 */
function collectModels(engine, procs) {
  const source = modelsSource(engine);
  if (source === 'ollama') return safeCollect(getOllamaStatus);
  if (source === 'llamacpp') return safeCollect(() => getLlamacppStatus(appVramBytes(procs, cfg.llamacppAppName)));
  return Promise.resolve(null);
}

async function collectEngineApp(engine) {
  const name = appNameOf(engine);
  if (!name) return null;
  const stats = await safeCollect(() => getEngineAppStats(name));
  if (engine.active !== 'llamacpp' || stats.error) return stats;
  return { ...stats, launch: await getLaunchInfo(name).catch(() => null) };
}

router.get('/status', async (_req, res) => {
  const [host, ipmi] = await Promise.all([
    safeCollect(getHostStatus),
    safeCollect(getIpmiStatus),
  ]);
  let engine = buildEngine(null, engineOpts());
  let models = null, engineApp = null, gpu = null, gpuProcs = null, memory = null, network = null, uptime = null;

  if (host.alive) {
    const read = readEngine();
    let procs;
    [gpu, gpuProcs, memory, network, uptime, { engine, procs }] = await Promise.all([
      safeCollect(getGpuStatus),
      read.gpuProcs,
      safeCollect(getMemoryStatus),
      safeCollect(getNetworkStatus),
      safeCollect(getUptime),
      read.engine,
    ]);
    [models, engineApp] = await Promise.all([collectModels(engine, procs), collectEngineApp(engine)]);
    // Copies, not mutation: the gpu objects live in the collector cache and are
    // also served by /api/gpu, which must stay engine-free.
    gpu = annotateGpus(gpu, procs, engineNames());
  }

  res.json({ host, ipmi, uptime, engine, models, engineApp, gpu, gpuProcs, memory, network });
});

router.get('/models-loaded', async (_req, res) => {
  const { engine, procs } = await readEngine().engine;
  res.json(await collectModels(engine, procs));
});

router.get('/engine-app', async (_req, res) => {
  const { engine } = await readEngine().engine;
  res.json(await collectEngineApp(engine));
});

// Model management is an Ollama feature; with llama.cpp active these refuse
// before touching anything. Without llama.cpp configured the engine state is
// not read at all, so these never depend on midclt.
async function refuseWithLlamacpp(res) {
  if (!cfg.llamacppAppName) return false;
  const { engine } = await readEngine().engine;
  if (engine.active !== 'llamacpp') return false;
  res.status(409).json({ error: 'Not available with llama.cpp' });
  return true;
}

router.get('/models', async (_req, res) => {
  if (await refuseWithLlamacpp(res)) return;
  res.json(await safeCollect(getAvailableModels));
});

router.get('/gpu', async (_req, res) => {
  res.json(await safeCollect(getGpuStatus));
});

router.get('/gpu-procs', async (_req, res) => {
  res.json(await safeCollect(getGpuProcs));
});

router.get('/memory', async (_req, res) => {
  res.json(await safeCollect(getMemoryStatus));
});

router.get('/check-update', async (_req, res) => {
  res.json(await checkUpdate());
});

router.post('/wake', async (_req, res) => {
  try {
    res.json(await wakeServer());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sleep', async (_req, res) => {
  try {
    res.json(await sleepServer());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The action takes the shared engine lock and picks the app from a fresh
// app.query; the process list only breaks a conflict tie.
router.post('/restart-engine', async (_req, res) => {
  try {
    const procs = cfg.llamacppAppName ? ((await safeCollect(getGpuProcs)).procs ?? []) : [];
    res.json(await restartEngine(procs));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/switch-engine', async (req, res) => {
  const target = req.body?.target;
  if (!cfg.llamacppAppName) return res.status(404).json({ error: 'llama.cpp is not configured' });
  if (target !== 'ollama' && target !== 'llamacpp') return res.status(400).json({ error: `Unknown target: ${target ?? ''}` });
  try {
    const host = await safeCollect(getHostStatus);
    if (!host.alive) return res.status(503).json({ error: 'Host is down' });
    res.json(await switchEngine(target));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Gated in the UI on the active engine's update flag, but upgrades every app
// that has one except the inactive engine — the engine update is the occasion,
// not the scope. The action reads the app states itself, under the shared
// engine lock, and fails closed (503) when it cannot.
router.post('/upgrade-apps', async (_req, res) => {
  try {
    res.json(await upgradeApps());
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Validate against the installed-model list so a typo yields a clear 400
// instead of Ollama's bare 404. Not an injection defence — the name travels
// as JSON to an HTTP API, never to a shell.
async function resolveModelName(req, res) {
  const list = await getAvailableModels();
  const found = findModel(list.models, req.body?.model);
  if (!found) {
    res.status(400).json({ error: `Unknown model: ${req.body?.model ?? ''}` });
    return null;
  }
  return found.name;
}

router.post('/load-model', async (req, res) => {
  try {
    if (await refuseWithLlamacpp(res)) return;
    const name = await resolveModelName(req, res);
    if (!name) return;
    res.json(await loadModel(name));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/unload-model', async (req, res) => {
  try {
    if (await refuseWithLlamacpp(res)) return;
    const name = await resolveModelName(req, res);
    if (!name) return;
    res.json(await unloadModel(name));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
