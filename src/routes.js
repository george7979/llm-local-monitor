import { Router } from 'express';
import { cfg } from './config.js';
import { getHostStatus } from './collectors/host.js';
import { getOllamaStatus } from './collectors/ollama.js';
import { getOllamaAppStats } from './collectors/ollamaApp.js';
import { getGpuStatus } from './collectors/gpu.js';
import { getMemoryStatus } from './collectors/memory.js';
import { wakeServer } from './actions/wake.js';
import { sleepServer } from './actions/sleep.js';
import { restartOllama } from './actions/restartOllama.js';

export const router = Router();

router.get('/config', (_req, res) => {
  res.json({ llmHost: cfg.llmHost });
});

function safeCollect(fn) {
  return fn().catch(err => ({ error: err.message }));
}

router.get('/status', async (_req, res) => {
  const host = await safeCollect(getHostStatus);
  let ollama = null, gpu = null, memory = null;

  if (host.alive) {
    [ollama, gpu, memory] = await Promise.all([
      safeCollect(getOllamaStatus),
      safeCollect(getGpuStatus),
      safeCollect(getMemoryStatus),
    ]);
  }

  const ollamaApp = host.alive ? await safeCollect(getOllamaAppStats) : null;
  res.json({ host, ollama, ollamaApp, gpu, memory });
});

router.get('/ollama', async (_req, res) => {
  res.json(await safeCollect(getOllamaStatus));
});

router.get('/ollama-app', async (_req, res) => {
  res.json(await safeCollect(getOllamaAppStats));
});

router.get('/gpu', async (_req, res) => {
  res.json(await safeCollect(getGpuStatus));
});

router.get('/memory', async (_req, res) => {
  res.json(await safeCollect(getMemoryStatus));
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
