import { sshExec } from '../lib/ssh.js';
import { cached } from '../lib/cache.js';

export function getUptime() {
  return cached('uptime', 3_000, async () => {
    const raw = await sshExec("awk '{print int($1)}' /proc/uptime");
    const seconds = parseInt(raw, 10);
    return { seconds };
  });
}
