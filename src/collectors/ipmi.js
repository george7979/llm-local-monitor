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

export function getIpmiStatus() {
  return cached('ipmi', 2_000, async () => {
    if (!cfg.ipmiHost) return { alive: false, checkedAt: new Date().toISOString() };
    const alive = await probeTcp(cfg.ipmiHost, 443, 4_000);
    return { alive, checkedAt: new Date().toISOString() };
  });
}
