import { sshExec } from '../lib/ssh.js';
import { cached } from '../lib/cache.js';
import { getApps } from './engineApps.js';

const prevCpu = new Map(); // app name -> { usec, ts }

function parseSection(raw, name) {
  const parts = raw.split(/===\w+===/);
  const headers = [...raw.matchAll(/===(\w+)===/g)].map(m => m[1]);
  const idx = headers.indexOf(name);
  return idx >= 0 ? (parts[idx + 1] || '').trim() : '';
}

export function getEngineAppStats(appName) {
  return cached(`engine-app:${appName}`, 2_000, async () => {
    // ── 1. App info + container ID ──────────────────────────────────
    const app = (await getApps()).find(a => a.name === appName);
    if (!app) throw new Error(`App not found: ${appName}`);
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
      `echo '===NPROC==='; nproc`,
    ].join('; ');

    const raw = await sshExec(cmd);

    const cpu   = parseSection(raw, 'CPU');
    const mem   = parseSection(raw, 'MEM');
    const mmax  = parseSection(raw, 'MEMMAX');
    const nproc = parseInt(parseSection(raw, 'NPROC')) || 1;

    // CPU %
    const cpuUsec = parseInt(cpu.match(/^usage_usec\s+(\d+)/m)?.[1] || 0);
    const now = Date.now();
    let cpuPct = 0;
    const prev = prevCpu.get(appName);
    if (prev?.usec > 0) {
      const du = cpuUsec - prev.usec;
      const dw = (now - prev.ts) * 1000; // wall clock in µs
      // Divide by nproc to get % of total CPU (same as TrueNAS / docker stats)
      cpuPct = dw > 0 ? Math.max(0, Math.round((du / (dw * nproc)) * 100)) : 0;
    }
    prevCpu.set(appName, { usec: cpuUsec, ts: now });

    // Memory
    const memUsed = parseInt(mem) || 0;
    const memMax  = parseInt(mmax) || 0;

    return {
      ...base,
      cpu:    { pct: cpuPct, cores: nproc },
      memory: { used: memUsed, max: memMax },
    };
  });
}
