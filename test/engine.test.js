import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickEngine, gpuEngine, selectPending } from '../src/lib/engine.js';

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
