import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickEngine, gpuEngine, selectPending, appVramBytes, buildEngine, skipListFor, skippedWithUpdate, engineAppName, annotateGpus, switchPlan, restartTarget, upgradeSkipList, modelsSource } from '../src/lib/engine.js';

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

test('buildEngine: host down or failed state -> no engine, enabled reflects configuration', () => {
  for (const bad of [null, { error: 'boom' }]) {
    const on = buildEngine(bad, { configured: true, switching: false });
    assert.equal(on.active, null);
    assert.equal(on.enabled, true);
    assert.deepEqual(on.apps, {});
    assert.equal(buildEngine(bad, { configured: false, switching: false }).enabled, false);
  }
});

test('skipListFor: every non-active engine app when configured', () => {
  assert.deepEqual(skipListFor({ active: 'llamacpp' }, N, true), ['ollama']);
  assert.deepEqual(skipListFor({ active: 'ollama' }, N, true), ['llama-cpp']);
  assert.deepEqual(skipListFor({ active: null }, N, true), ['ollama', 'llama-cpp']);
  assert.deepEqual(skipListFor({ active: 'ollama' }, N, false), []);
  assert.deepEqual(skipListFor({ active: null }, N, false), []);
});

test('skippedWithUpdate names only skipped apps with a pending update', () => {
  const apps = [
    { name: 'ollama', upgrade_available: true },
    { name: 'llama-cpp', image_updates_available: false },
    { name: 'app-a', upgrade_available: true },
  ];
  assert.deepEqual(skippedWithUpdate(apps, ['ollama', 'llama-cpp']), ['ollama']);
  assert.deepEqual(skippedWithUpdate(apps, null), []);
  assert.deepEqual(skippedWithUpdate(apps, 'ollama'), ['ollama']);
});

test('selectPending accepts a list of names to skip', () => {
  const apps = [
    { name: 'ollama', upgrade_available: true },
    { name: 'llama-cpp', image_updates_available: true },
    { name: 'app-a', upgrade_available: true },
  ];
  assert.deepEqual(selectPending(apps, ['ollama', 'llama-cpp']), { charts: ['app-a'], images: [], skipped: true });
  assert.deepEqual(selectPending(apps, []), { charts: ['ollama', 'app-a'], images: ['llama-cpp'], skipped: false });
});

test('engineAppName: not enabled always the Ollama app, enabled the active one', () => {
  assert.equal(engineAppName({ active: null }, N, false), 'ollama');
  assert.equal(engineAppName({ active: 'ollama' }, N, false), 'ollama');
  assert.equal(engineAppName({ active: null }, N, true), null);
  assert.equal(engineAppName({ active: 'llamacpp' }, N, true), 'llama-cpp');
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
  assert.deepEqual(switchPlan(ap('RUNNING', 'STOPPED'), 'llamacpp', N), { missing: false, stopping: false, stop: 'ollama', start: 'llama-cpp', noop: false });
  assert.deepEqual(switchPlan(ap('STOPPED', 'STOPPED'), 'ollama', N), { missing: false, stopping: false, stop: null, start: 'ollama', noop: false });
  assert.equal(switchPlan(ap('STOPPED', 'RUNNING'), 'llamacpp', N).noop, true);
  assert.equal(switchPlan(ap('STOPPED', 'CRASHED'), 'llamacpp', N).noop, true);
  // conflict: target already up, other must go
  assert.deepEqual(switchPlan(ap('RUNNING', 'RUNNING'), 'ollama', N), { missing: false, stopping: false, stop: 'llama-cpp', start: null, noop: false });
  assert.equal(switchPlan([{ name: 'ollama', state: 'RUNNING' }], 'llamacpp', N).missing, true);
  // the other engine's app absent is also missing: no start may run
  assert.equal(switchPlan([{ name: 'llama-cpp', state: 'STOPPED' }], 'llamacpp', N).missing, true);
});

test('switchPlan: a target still STOPPING is refused, never planned', () => {
  const ap = (o, l) => [{ name: 'ollama', state: o }, { name: 'llama-cpp', state: l }];
  assert.deepEqual(switchPlan(ap('RUNNING', 'STOPPING'), 'llamacpp', N), { missing: false, stopping: true, stop: null, start: null, noop: false });
  assert.equal(switchPlan(ap('STOPPING', 'RUNNING'), 'ollama', N).stopping, true);
  // the other engine STOPPING is just something to stop
  assert.equal(switchPlan(ap('STOPPING', 'STOPPED'), 'llamacpp', N).stopping, false);
});

test('restartTarget: Ollama when llama.cpp is off or missing, else the active engine', () => {
  const ap = (o, l) => [{ name: 'ollama', state: o }, ...(l ? [{ name: 'llama-cpp', state: l }] : [])];
  assert.deepEqual(restartTarget(ap('STOPPED', 'RUNNING'), [], N, false), { name: 'ollama', state: 'STOPPED' });
  assert.deepEqual(restartTarget(ap('STOPPED'), [], N, true), { name: 'ollama', state: 'STOPPED' });
  assert.deepEqual(restartTarget([], [], N, false), { name: 'ollama', state: null });
  assert.deepEqual(restartTarget(ap('STOPPED', 'RUNNING'), [], N, true), { name: 'llama-cpp', state: 'RUNNING' });
  // STOPPING still counts as active
  assert.deepEqual(restartTarget(ap('STOPPING', 'STOPPED'), [], N, true), { name: 'ollama', state: 'STOPPING' });
  assert.deepEqual(restartTarget(ap('STOPPED', 'STOPPED'), [], N, true), { name: null, state: null });
  // conflict: the GPU holder decides
  assert.equal(restartTarget(ap('RUNNING', 'RUNNING'), [{ container: 'ollama' }], N, true).name, 'ollama');
});

test('upgradeSkipList: from fresh states, both engines on a conflict or none active', () => {
  const ap = (o, l) => [{ name: 'ollama', state: o }, ...(l ? [{ name: 'llama-cpp', state: l }] : []), { name: 'app-a', state: 'RUNNING' }];
  assert.deepEqual(upgradeSkipList(ap('RUNNING', 'STOPPED'), N, false), []);
  assert.deepEqual(upgradeSkipList(ap('STOPPED'), N, true), []); // llama.cpp app missing = feature off
  assert.deepEqual(upgradeSkipList(ap('STOPPING', 'STOPPED'), N, true), ['llama-cpp']);
  assert.deepEqual(upgradeSkipList(ap('STOPPED', 'RUNNING'), N, true), ['ollama']);
  assert.deepEqual(upgradeSkipList(ap('STOPPED', 'STOPPED'), N, true), ['ollama', 'llama-cpp']);
  assert.deepEqual(upgradeSkipList(ap('RUNNING', 'RUNNING'), N, true), ['ollama', 'llama-cpp']);
});

test('modelsSource: Ollama whenever llama.cpp is not enabled, else the active engine', () => {
  const st = { active: null, conflict: false, notFound: null, updatesWaiting: false };
  // not configured: no engine active, or the app list unreadable → still Ollama
  assert.equal(modelsSource(buildEngine({ ...st, apps: { ollama: S('STOPPED'), llamacpp: null } }, { configured: false, switching: false })), 'ollama');
  assert.equal(modelsSource(buildEngine({ error: 'ssh down' }, { configured: false, switching: false })), 'ollama');
  // configured but its app not found = feature off
  assert.equal(modelsSource(buildEngine({ ...st, notFound: 'llama-cpp', apps: { ollama: S('STOPPED'), llamacpp: null } }, { configured: true, switching: false })), 'ollama');
  // enabled
  const on = active => buildEngine({ ...st, active, apps: { ollama: S('RUNNING'), llamacpp: S('STOPPED') } }, { configured: true, switching: false });
  assert.equal(modelsSource(on(null)), null);
  assert.equal(modelsSource(on('ollama')), 'ollama');
  assert.equal(modelsSource(on('llamacpp')), 'llamacpp');
  // configured, app list unreadable: no engine known
  assert.equal(modelsSource(buildEngine({ error: 'ssh down' }, { configured: true, switching: false })), null);
});
