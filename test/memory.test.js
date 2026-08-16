import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMeminfo, parseArcSize } from '../src/collectors/memory.js';

const GIB = 2 ** 30;

// Real sample from the GPU server, 2026-08-16, ~4 h uptime with a warm cache.
// TrueNAS reported free 24 / ZFS 91 / services 10 GiB at that moment.
const MEMINFO = `MemTotal:       131869888 kB
MemFree:         1236680 kB
MemAvailable:   25202436 kB
Buffers:               0 kB
Cached:         25893892 kB
SwapCached:            0 kB
Shmem:           1442848 kB
SReclaimable:     767376 kB`;

const ARCSTATS = `c                               4    98472836128
c_min                           4    4219836416
c_max                           4    133961023488
size                            4    98201938488`;

test('free reflects MemAvailable, not MemFree', () => {
  const { free } = parseMeminfo(MEMINFO);
  // MemFree is 1.18 GiB here — the kernel keeps almost nothing truly unused,
  // because Linux fills the page cache. MemAvailable is the honest figure and
  // the one TrueNAS displays.
  assert.equal(free, 25202436 * 1024);
  assert.ok(Math.abs(free / GIB - 24.0) < 0.5, `free should be ~24 GiB, got ${free / GIB}`);
});

test('services matches what TrueNAS reports', () => {
  const { total, free } = parseMeminfo(MEMINFO);
  const arc = parseArcSize(ARCSTATS);
  const services = Math.max(0, total - free - arc);

  assert.ok(Math.abs(total / GIB - 125.8) < 0.5, `total ~125.8 GiB, got ${total / GIB}`);
  assert.ok(Math.abs(arc / GIB - 91.0) < 0.5, `arc ~91 GiB, got ${arc / GIB}`);
  assert.ok(Math.abs(services / GIB - 10.3) < 0.5, `services ~10 GiB, got ${services / GIB}`);
});

test('the three slices still add up to total', () => {
  const { total, free } = parseMeminfo(MEMINFO);
  const arc = parseArcSize(ARCSTATS);
  assert.equal(free + arc + Math.max(0, total - free - arc), total);
});

test('parseMeminfo falls back to MemFree when MemAvailable is absent', () => {
  // MemAvailable exists since Linux 3.14; keep the old field as a fallback so
  // an exotic kernel degrades to the previous behaviour instead of showing 0.
  const { free } = parseMeminfo('MemTotal:  131869888 kB\nMemFree:   1236680 kB');
  assert.equal(free, 1236680 * 1024);
});
