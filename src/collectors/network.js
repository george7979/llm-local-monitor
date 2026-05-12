import { sshExec } from '../lib/ssh.js';
import { cached } from '../lib/cache.js';
import { cfg } from '../config.js';

let _prev   = null;
let _speeds = null;
let _speedsTs = 0;
const SPEED_TTL = 30_000;

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

function toMbps(bytesDelta, dtSec) {
  if (dtSec <= 0 || bytesDelta < 0) return 0;
  return +(bytesDelta * 8 / dtSec / 1_000_000).toFixed(4);
}

async function readSpeeds(ifaces, fallback) {
  if (_speeds && Date.now() - _speedsTs < SPEED_TTL) return _speeds;

  const speeds = {};
  try {
    const cmd = `for i in ${ifaces.join(' ')}; do cat /sys/class/net/$i/speed 2>/dev/null || echo -1; done`;
    const raw = await sshExec(cmd);
    const values = raw.trim().split('\n').map(v => parseInt(v));
    ifaces.forEach((name, i) => {
      speeds[name] = (values[i] > 0) ? values[i] : fallback;
    });
  } catch {
    ifaces.forEach(name => { speeds[name] = fallback; });
  }

  _speeds = speeds;
  _speedsTs = Date.now();
  return speeds;
}

export function getNetworkStatus() {
  const physIfaces = cfg.networkPhysIfaces;
  const hostIface  = cfg.networkHostIface;

  if (!physIfaces) return Promise.resolve(null);

  const allIfaces  = hostIface ? [...physIfaces, hostIface] : physIfaces;
  const fallback   = cfg.networkLinkSpeedMbit || 1000;

  return cached('network', 2_000, async () => {
    const now = Date.now();
    const [raw, speeds] = await Promise.all([
      sshExec('cat /proc/net/dev'),
      readSpeeds(allIfaces, fallback),
    ]);
    const cur = parseProcNetDev(raw, allIfaces);

    if (!_prev) {
      _prev = { ts: now, data: cur };
      return {
        ts: now,
        ports: allIfaces.map(p => ({
          name: p, isHost: p === hostIface,
          rxMbps: 0, txMbps: 0, maxMbps: speeds[p] || fallback,
        })),
      };
    }

    const dt = (now - _prev.ts) / 1000;
    const ports = allIfaces.map(p => {
      const c  = cur[p]        || { rx: 0, tx: 0 };
      const pv = _prev.data[p] || { rx: 0, tx: 0 };
      return {
        name:    p,
        isHost:  p === hostIface,
        rxMbps:  toMbps(c.rx - pv.rx, dt),
        txMbps:  toMbps(c.tx - pv.tx, dt),
        maxMbps: speeds[p] || fallback,
      };
    });

    _prev = { ts: now, data: cur };
    return { ts: now, ports };
  });
}
