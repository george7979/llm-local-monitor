import { sshExec } from '../lib/ssh.js';
import { cached } from '../lib/cache.js';

export function parseMeminfo(text) {
  const get = (key) => {
    const m = text.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
    return m ? parseInt(m[1]) * 1024 : 0; // kB → bytes
  };
  // MemAvailable, not MemFree. Linux fills the page cache on purpose, so
  // MemFree tends to zero on any long-running system — here 1.2 GiB out of
  // 126 — while MemAvailable is the kernel's estimate of what a new process
  // could actually get. That is the number TrueNAS shows, and because
  // `services` is computed as the remainder, using MemFree understated free
  // and overstated services by the same amount, drifting further with uptime.
  // MemAvailable exists since Linux 3.14; fall back for exotic kernels.
  return {
    total: get('MemTotal'),
    free: get('MemAvailable') || get('MemFree'),
  };
}

export function parseArcSize(text) {
  // /proc/spl/kstat/zfs/arcstats format: "size   4   <bytes>"
  const m = text.match(/^size\s+\d+\s+(\d+)/m);
  return m ? parseInt(m[1]) : 0;
}

export function getMemoryStatus() {
  return cached('memory', 2_000, async () => {
    const [meminfoRaw, arcstatsRaw] = await Promise.all([
      sshExec('cat /proc/meminfo'),
      sshExec('cat /proc/spl/kstat/zfs/arcstats'),
    ]);
    const { total, free } = parseMeminfo(meminfoRaw);
    const arc = parseArcSize(arcstatsRaw);
    const services = Math.max(0, total - free - arc);
    return { total, free, arc, services };
  });
}
