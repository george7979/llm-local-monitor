import { Router } from 'express';
import { cfg } from './config.js';
import { getHostStatus } from './collectors/host.js';
import { getIpmiStatus } from './collectors/ipmi.js';
import { getUptime } from './collectors/uptime.js';
import { getOllamaStatus } from './collectors/ollama.js';
import { getOllamaAppStats } from './collectors/ollamaApp.js';
import { getAvailableModels } from './collectors/ollamaModels.js';
import { getGpuStatus } from './collectors/gpu.js';
import { getGpuProcs } from './collectors/gpuProcs.js';
import { getMemoryStatus } from './collectors/memory.js';
import { getNetworkStatus } from './collectors/network.js';
import { wakeServer } from './actions/wake.js';
import { sleepServer } from './actions/sleep.js';
import { restartOllama } from './actions/restartOllama.js';
import { upgradeOllama } from './actions/upgradeOllama.js';
import { checkUpdate } from './actions/checkUpdate.js';

export const router = Router();

router.get('/config', (_req, res) => {
  res.json({ llmHost: cfg.llmHost, truenasUrl: cfg.truenasUrl, pollIntervalSec: cfg.pollIntervalSec, version: cfg.version });
});

function safeCollect(fn) {
  return fn().catch(err => ({ error: err.message }));
}

router.get('/status', async (_req, res) => {
  const [host, ipmi] = await Promise.all([
    safeCollect(getHostStatus),
    safeCollect(getIpmiStatus),
  ]);
  let ollama = null, gpu = null, gpuProcs = null, memory = null, network = null;

  let uptime = null;
  if (host.alive) {
    [ollama, gpu, gpuProcs, memory, network, uptime] = await Promise.all([
      safeCollect(getOllamaStatus),
      safeCollect(getGpuStatus),
      safeCollect(getGpuProcs),
      safeCollect(getMemoryStatus),
      safeCollect(getNetworkStatus),
      safeCollect(getUptime),
    ]);
  }

  // Derive per-GPU ollama badge from the process list (matches old behavior;
  // false when the process collector failed — badge degrades, card still renders).
  // Copies, not mutation: the gpu objects live in the collector cache and are
  // also served by /api/gpu, which must stay hasOllama-free.
  if (gpu?.gpus) {
    gpu = { ...gpu, gpus: gpu.gpus.map(g => ({
      ...g,
      hasOllama: !!gpuProcs?.procs?.some(p =>
        p.busId === g.busId &&
        `${p.container || ''} ${p.binary || ''}`.toLowerCase().includes('ollama')),
    })) };
  }

  const ollamaApp = host.alive ? await safeCollect(getOllamaAppStats) : null;
  res.json({ host, ipmi, uptime, ollama, ollamaApp, gpu, gpuProcs, memory, network });
});

router.get('/ollama', async (_req, res) => {
  res.json(await safeCollect(getOllamaStatus));
});

router.get('/models', async (_req, res) => {
  res.json(await safeCollect(getAvailableModels));
});

router.get('/ollama-app', async (_req, res) => {
  res.json(await safeCollect(getOllamaAppStats));
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

router.post('/restart-ollama', async (_req, res) => {
  try {
    res.json(await restartOllama());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/upgrade-ollama', async (_req, res) => {
  try {
    res.json(await upgradeOllama());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
