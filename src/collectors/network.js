import { sshExec } from '../lib/ssh.js';
import { cached } from '../lib/cache.js';
import { cfg } from '../config.js';

const MAX_MBPS = 125; // 1 Gbit/s in MB/s

let _prev = null;

function parseProcNetDev(text, ifaces) {
  const result = {};
  for (const line of text.trim().split('\n').slice(2)) {
    const parts = line.trim().split(/\s+/);
    const iface = parts[0].replace(':', '');
    if (ifaces.includes(iface)) {
      result[iface] = { rx: parseInt(parts[1]), tx: parseInt(parts[9]) };
    }
  }
  return result;
}

function toMBps(bytesDelta, dtSec) {
  if (dtSec <= 0 || bytesDelta < 0) return 0;
  return +(bytesDelta / dtSec / 1_000_000).toFixed(2);
}

export function getNetworkStatus() {
  const physIfaces = cfg.networkPhysIfaces;
  const hostIface  = cfg.networkHostIface;

  if (!physIfaces) return Promise.resolve(null);

  const allIfaces = hostIface ? [...physIfaces, hostIface] : physIfaces;

  return cached('network', 2_000, async () => {
    const now = Date.now();
    const raw = await sshExec('cat /proc/net/dev');
    const cur = parseProcNetDev(raw, allIfaces);

    if (!_prev) {
      _prev = { ts: now, data: cur };
      return { ports: allIfaces.map(p => ({ name: p, isHost: p === hostIface, rxMBps: 0, txMBps: 0, maxMBps: MAX_MBPS })) };
    }

    const dt = (now - _prev.ts) / 1000;
    const ports = allIfaces.map(p => {
      const c  = cur[p]   || { rx: 0, tx: 0 };
      const pv = _prev.data[p] || { rx: 0, tx: 0 };
      return {
        name:    p,
        isHost:  p === hostIface,
        rxMBps:  toMBps(c.rx - pv.rx, dt),
        txMBps:  toMBps(c.tx - pv.tx, dt),
        maxMBps: MAX_MBPS,
      };
    });

    _prev = { ts: now, data: cur };
    return { ports };
  });
}
