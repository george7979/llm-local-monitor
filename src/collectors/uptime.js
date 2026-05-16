import { sshExec } from '../lib/ssh.js';
import { cached } from '../lib/cache.js';
import { cfg } from '../config.js';

const TTL = Math.max(1_000, (cfg.pollIntervalSec - 1) * 1_000);

export function getUptime() {
  return cached('uptime', TTL, async () => {
    const raw = await sshExec("awk '{print int($1)}' /proc/uptime");
    const seconds = parseInt(raw, 10);
    return { seconds };
  });
}
