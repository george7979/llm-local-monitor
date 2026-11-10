import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickEngine, gpuEngine, selectPending, appVramBytes, buildEngine, skipNameFor, annotateGpus, switchPlan } from '../src/lib/engine.js';

const N = { ollama: 'ollama', llamacpp: 'llama-cpp' };
const S = s => ({ state: s });

test('one engine not stopped is active', () => {
  assert.deepEqual(pickEngine({ ollama: S('STOPPED'), llamacpp: S('RUNNING') }, [], N), { active: 'llamacpp', conflict: false });
  assert.deepEqual(pickEngine({ ollama: S('RUNNING'), llamacpp: S('STOPPED') }, [], N), { active: 'ollama', conflict: false });
});

test('deploying and crashed count as selected', () => {
  assert.equal(pickEngine({ ollama: S('STOPPED'), llamacpp: S('DEPLOYING') }, [], N).active, 'llamacpp');
  assert.equal(pickEngine({ ollama: S('CRASHED'), llamacpp: S('STOPPED') }, [], N).active, 'ollama');
});

test('both stopped → none', () => {
  assert.deepEqual(pickEngine({ ollama: S('STOPPED'), llamacpp: S('STOPPED') }, [], N), { active: null, conflict: false });
});

test('conflict: GPU holder wins, tie → llamacpp', () => {
  const both = { ollama: S('RUNNING'), llamacpp: S('RUNNING') };
  assert.deepEqual(pickEngine(both, [{ container: 'ollama' }], N), { active: 'ollama', conflict: true });
  assert.deepEqual(pickEngine(both, [], N), { active: 'llamacpp', conflict: true });
  assert.deepEqual(pickEngine(both, [{ container: 'ollama' }, { container: 'llama-cpp' }], N), { active: 'llamacpp', conflict: true });
});

test('llamacpp not configured → ollama rules alone', () => {
  assert.deepEqual(pickEngine({ ollama: S('RUNNING'), llamacpp: null }, [], N), { active: 'ollama', conflict: false });
  assert.deepEqual(pickEngine({ ollama: S('STOPPED'), llamacpp: null }, [], N), { active: null, conflict: false });
});

test('gpuEngine matches app name exactly', () => {
  assert.equal(gpuEngine([{ container: 'llama-cpp', binary: '/app/llama-server' }], N), 'llamacpp');
  assert.equal(gpuEngine([{ container: 'ollama', binary: '/usr/lib/ollama/llama-server' }], N), 'ollama');
  assert.equal(gpuEngine([{ container: 'app-a', binary: '/usr/bin/ollama' }], N), null);
  assert.equal(gpuEngine([{ container: null }], N), null);
  assert.equal(gpuEngine([{ container: 'ollama' }], { ollama: 'ollama', llamacpp: 'llama' }), 'ollama'); // no substring match
});

test('gpuEngine: an unconfigured engine name never matches a null container', () => {
  assert.equal(gpuEngine([{ container: null }], { ollama: 'ollama', llamacpp: null }), null);
});

test('selectPending skips the inactive engine', () => {
  const apps = [
    { name: 'ollama', upgrade_available: true,  image_updates_available: false },
    { name: 'app-a',  upgrade_available: false, image_updates_available: true  },
  ];
  assert.deepEqual(selectPending(apps, 'ollama'), { charts: [], images: ['app-a'], skipped: true });
  assert.deepEqual(selectPending(apps, 'app-b'),  { charts: ['ollama'], images: ['app-a'], skipped: false });
});

const procs = [
  { busId: 'A', container: 'llama-cpp', vramMb: 1000 },
  { busId: 'B', container: 'llama-cpp', vramMb: 500 },
  { busId: 'B', container: 'ollama', vramMb: 7 },
];

test('appVramBytes sums the app\'s rows in bytes', () => {
  assert.equal(appVramBytes(procs, 'llama-cpp'), 1500 * 1024 * 1024);
  assert.equal(appVramBytes(procs, 'nope'), 0);
  assert.equal(appVramBytes(procs, null), 0);
  assert.equal(appVramBytes([{ container: null, vramMb: 5 }], null), 0);
});

const state = { active: 'llamacpp', conflict: false, notFound: null, updatesWaiting: false,
  apps: { ollama: { state: 'STOPPED' }, llamacpp: { state: 'RUNNING' } } };

test('buildEngine: enabled needs configured and found', () => {
  assert.equal(buildEngine(state, { configured: true, switching: false }).enabled, true);
  const missing = { ...state, apps: { ollama: { state: 'RUNNING' }, llamacpp: null } };
  assert.equal(buildEngine(missing, { configured: true, switching: false }).enabled, false);
  const off = buildEngine({ ...missing, active: 'ollama' }, { configured: false, switching: true });
  assert.equal(off.enabled, false);
  assert.equal(off.switching, true);
  assert.deepEqual(Object.keys(off.apps), ['ollama']);
});

test('buildEngine: a failed or missing state degrades to switch-off', () => {
  for (const bad of [null, { error: 'boom' }]) {
    const e = buildEngine(bad, { configured: true, switching: false });
    assert.equal(e.active, null);
    assert.equal(e.enabled, false);
    assert.deepEqual(e.apps, {});
  }
});

test('skipNameFor is the inactive engine, null when unknown', () => {
  const on = { enabled: true, active: 'llamacpp' };
  assert.equal(skipNameFor(on, N), 'ollama');
  assert.equal(skipNameFor({ enabled: true, active: 'ollama' }, N), 'llama-cpp');
  assert.equal(skipNameFor({ enabled: true, active: null }, N), null);
  assert.equal(skipNameFor({ enabled: false, active: 'ollama' }, N), null);
  assert.equal(skipNameFor(null, N), null);
});

test('annotateGpus copies and tags each GPU with its engine', () => {
  const gpu = { gpus: [{ busId: 'A' }, { busId: 'C' }] };
  const out = annotateGpus(gpu, procs, N);
  assert.deepEqual(out.gpus.map(g => g.engine), ['llamacpp', null]);
  assert.equal('engine' in gpu.gpus[0], false);
  assert.deepEqual(annotateGpus({ error: 'x' }, procs, N), { error: 'x' });
});

test('switchPlan: stop the other, start the target, or do nothing', () => {
  const ap = (o, l) => [{ name: 'ollama', state: o }, { name: 'llama-cpp', state: l }];
  assert.deepEqual(switchPlan(ap('RUNNING', 'STOPPED'), 'llamacpp', N), { missing: false, stop: 'ollama', start: 'llama-cpp', noop: false });
  assert.deepEqual(switchPlan(ap('STOPPED', 'STOPPED'), 'ollama', N), { missing: false, stop: null, start: 'ollama', noop: false });
  assert.equal(switchPlan(ap('STOPPED', 'RUNNING'), 'llamacpp', N).noop, true);
  assert.equal(switchPlan(ap('STOPPED', 'CRASHED'), 'llamacpp', N).noop, true);
  // conflict: target already up, other must go
  assert.deepEqual(switchPlan(ap('RUNNING', 'RUNNING'), 'ollama', N), { missing: false, stop: 'llama-cpp', start: null, noop: false });
  assert.equal(switchPlan([{ name: 'ollama', state: 'RUNNING' }], 'llamacpp', N).missing, true);
});
