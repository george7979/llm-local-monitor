import { sshExec } from '../lib/ssh.js';
import { cached } from '../lib/cache.js';
import { cfg } from '../config.js';

let prevCpu = null; // { usec, ts }

function parseSection(raw, name) {
  const parts = raw.split(/===\w+===/);
  const headers = [...raw.matchAll(/===(\w+)===/g)].map(m => m[1]);
  const idx = headers.indexOf(name);
  return idx >= 0 ? (parts[idx + 1] || '').trim() : '';
}

export function getOllamaAppStats() {
  return cached('ollama-app', 2_000, async () => {
    // ── 1. App info + container ID ──────────────────────────────────
    const midcltRaw = await sshExec(`midclt call app.query '[["name","=","${cfg.ollamaAppName}"]]'`);
    const app = JSON.parse(midcltRaw)[0];
    const containerId = app.active_workloads?.container_details?.[0]?.id;

    const base = {
      state: app.state,
      version: app.metadata?.app_version || app.human_version || '',
      chartVersion: app.version || '',
      upgradeAvailable: !!(app.upgrade_available || app.image_updates_available),
      image: app.active_workloads?.images?.[0] || '',
    };

    if (!containerId) return base;

    // ── 2. Cgroup stats — single SSH call ───────────────────────────
    const cmd = [
      `B=/sys/fs/cgroup/docker/${containerId}`,
      `echo '===CPU==='; cat $B/cpu.stat`,
      `echo '===MEM==='; cat $B/memory.current`,
      `echo '===MEMMAX==='; cat $B/memory.max`,
      `echo '===IO==='; cat $B/io.stat`,
      `echo '===NET==='; cat /proc/$(cat $B/cgroup.procs | head -1)/net/dev 2>/dev/null`,
      `echo '===NPROC==='; nproc`,
    ].join('; ');

    const raw = await sshExec(cmd);

    const cpu   = parseSection(raw, 'CPU');
    const mem   = parseSection(raw, 'MEM');
    const mmax  = parseSection(raw, 'MEMMAX');
    const io    = parseSection(raw, 'IO');
    const net   = parseSection(raw, 'NET');
    const nproc = parseInt(parseSection(raw, 'NPROC')) || 1;

    // CPU %
    const cpuUsec = parseInt(cpu.match(/^usage_usec\s+(\d+)/m)?.[1] || 0);
    const now = Date.now();
    let cpuPct = 0;
    if (prevCpu?.usec > 0) {
      const du = cpuUsec - prevCpu.usec;
      const dw = (now - prevCpu.ts) * 1000; // wall clock in µs
      // Divide by nproc to get % of total CPU (same as TrueNAS / docker stats)
      cpuPct = dw > 0 ? Math.max(0, Math.round((du / (dw * nproc)) * 100)) : 0;
    }
    prevCpu = { usec: cpuUsec, ts: now };

    // Memory
    const memUsed = parseInt(mem) || 0;
    const memMax  = parseInt(mmax) || 0;

    // Block I/O (cumulative since container start)
    let ioRead = 0, ioWrite = 0;
    for (const line of io.split('\n')) {
      const rm = line.match(/rbytes=(\d+)/);
      const wm = line.match(/wbytes=(\d+)/);
      if (rm) ioRead  += parseInt(rm[1]);
      if (wm) ioWrite += parseInt(wm[1]);
    }

    // Network (cumulative)
    let netRx = 0, netTx = 0;
    for (const line of net.split('\n')) {
      const m = line.trim().match(/^eth0:\s+(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/);
      if (m) { netRx = parseInt(m[1]); netTx = parseInt(m[2]); }
    }

    return {
      ...base,
      cpu:    { pct: cpuPct },
      memory: { used: memUsed, max: memMax },
      io:     { read: ioRead, write: ioWrite },
      network: { rx: netRx, tx: netTx },
    };
  });
}
