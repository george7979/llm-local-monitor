import { createConnection } from 'net';
import { cfg } from '../config.js';
import { cached } from '../lib/cache.js';

function probeTcp(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port, timeout: timeoutMs });
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => resolve(false));
  });
}

export function getHostStatus() {
  return cached('host', 2_000, async () => {
    const alive = await probeTcp(cfg.llmHost, 22, 4_000);
    return { alive, checkedAt: new Date().toISOString() };
  });
}
