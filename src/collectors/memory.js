import { sshExec } from '../lib/ssh.js';
import { cached } from '../lib/cache.js';

function parseMeminfo(text) {
  const get = (key) => {
    const m = text.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
    return m ? parseInt(m[1]) * 1024 : 0; // kB → bytes
  };
  return {
    total: get('MemTotal'),
    free: get('MemFree'),
  };
}

function parseArcSize(text) {
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
