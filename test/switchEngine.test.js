// Engine actions against a fake `exec`: never the default sshExec, which
// would reach the live server. Every fake throws on a command it does not
// expect, and every gate is released before the test ends so the shared lock
// never leaks into the next test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { switchEngine } from '../src/actions/switchEngine.js';
import { restartEngine } from '../src/actions/restartEngine.js';
import { upgradeApps } from '../src/actions/upgradeApps.js';
import { engineAction } from '../src/lib/engineLock.js';
import { cfg } from '../src/config.js';

const noWait = async () => {};

/** Runs `fn` with llama.cpp configured under a placeholder name. */
async function withLlamacpp(fn) {
  const saved = cfg.llamacppAppName;
  cfg.llamacppAppName = 'llama-test';
  try { await fn(); } finally { cfg.llamacppAppName = saved; }
}

const states = (o, l) => JSON.stringify([
  { name: cfg.ollamaAppName, state: o }, { name: cfg.llamacppAppName, state: l }]);

/** An exec whose first app.query waits for `release()`; later commands go to `then`. */
function gatedExec(answer, then = cmd => { throw new Error(`unexpected: ${cmd}`); }) {
  let release;
  const gate = new Promise(r => { release = r; });
  const calls = [];
  const exec = async (cmd, timeout) => {
    calls.push({ cmd, timeout });
    if (cmd.includes('app.query') && calls.length === 1) { await gate; return answer(); }
    return then(cmd);
  };
  return { exec, calls, release };
}

const neverCalled = async cmd => { throw new Error(`exec must not run: ${cmd}`); };

test('concurrent switches: exactly one 409, lock clears after an error', () => withLlamacpp(async () => {
  const g = gatedExec(() => states('RUNNING', 'STOPPED'), () => { throw new Error('stop failed'); });
  const first = switchEngine('llamacpp', g.exec);
  const second = await switchEngine('llamacpp', neverCalled).catch(e => e);
  assert.equal(second.status, 409);
  assert.equal(engineAction(), 'switch');
  g.release();
  await assert.rejects(first, /stop failed/);
  assert.equal(engineAction(), null);
}));

test('restart while a switch holds the lock → 409, nothing executed', () => withLlamacpp(async () => {
  const g = gatedExec(() => states('RUNNING', 'STOPPED'), () => { throw new Error('stop failed'); });
  const sw = switchEngine('llamacpp', g.exec);
  const err = await restartEngine([], neverCalled, noWait).catch(e => e);
  assert.equal(err.status, 409);
  assert.match(err.message, /switch/);
  assert.equal(engineAction(), 'switch'); // the refused request did not release the switch's lock
  g.release();
  await sw.catch(() => {});
  assert.equal(engineAction(), null);
}));

test('switch while a restart holds the lock → 409; restart releases after an error', () => withLlamacpp(async () => {
  const g = gatedExec(() => { throw new Error('query failed'); });
  const rs = restartEngine([], g.exec, noWait);
  const err = await switchEngine('llamacpp', neverCalled).catch(e => e);
  assert.equal(err.status, 409);
  assert.equal(engineAction(), 'restart');
  g.release();
  await assert.rejects(rs, /query failed/);
  assert.equal(engineAction(), null);
}));

test('upgrade while a switch holds the lock → 409', () => withLlamacpp(async () => {
  const g = gatedExec(() => states('RUNNING', 'STOPPED'), () => { throw new Error('stop failed'); });
  const sw = switchEngine('llamacpp', g.exec);
  const err = await upgradeApps(neverCalled).catch(e => e);
  assert.equal(err.status, 409);
  assert.equal(engineAction(), 'switch');
  g.release();
  await sw.catch(() => {});
  assert.equal(engineAction(), null);
}));

test('switch while an upgrade holds the lock → 409; unreadable state → 503 and released', () => withLlamacpp(async () => {
  const g = gatedExec(() => { throw new Error('ssh down'); });
  const up = upgradeApps(g.exec);
  const err = await switchEngine('ollama', neverCalled).catch(e => e);
  assert.equal(err.status, 409);
  g.release();
  const failed = await up.catch(e => e);
  assert.equal(failed.status, 503);
  assert.match(failed.message, /Cannot determine the active engine/);
  assert.equal(engineAction(), null);
  // garbage instead of a list is unreadable too
  const bad = await upgradeApps(async () => '{"not":"a list"}').catch(e => e);
  assert.equal(bad.status, 503);
  assert.equal(engineAction(), null);
}));

test('restart waits for the stop job, then starts; a STOPPED app is only started', () => withLlamacpp(async () => {
  const calls = [];
  const waits = [];
  const exec = state => async (cmd, timeout) => {
    calls.push({ cmd, timeout });
    if (cmd.includes('app.query')) return state;
    if (cmd.includes('app.stop') || cmd.includes('app.start')) return '';
    throw new Error(`unexpected: ${cmd}`);
  };
  const res = await restartEngine([], exec(states('STOPPED', 'RUNNING')), async ms => { waits.push(ms); });
  assert.deepEqual(res, { ok: true, app: 'llama-test' });
  assert.match(calls[1].cmd, /midclt call -j app\.stop 'llama-test'/);
  assert.equal(calls[1].timeout, 120_000);
  assert.deepEqual(waits, [3_000]);
  assert.match(calls[2].cmd, /midclt call app\.start 'llama-test'/);

  calls.length = 0;
  await restartEngine([], exec(JSON.stringify([{ name: cfg.ollamaAppName, state: 'STOPPED' }])), noWait);
  // llama.cpp app missing = feature off: the Ollama app, even STOPPED — just started
  assert.deepEqual(calls.map(c => c.cmd.split("'")[0].trim()), ['midclt call app.query', 'midclt call app.start']);
  assert.equal(engineAction(), null);
}));

test('restart with no engine active → 409, lock released', () => withLlamacpp(async () => {
  const err = await restartEngine([], async () => states('STOPPED', 'STOPPED'), noWait).catch(e => e);
  assert.equal(err.status, 409);
  assert.equal(engineAction(), null);
}));

test('switch to an app that is still STOPPING → 409, nothing stopped', () => withLlamacpp(async () => {
  const calls = [];
  const exec = async cmd => {
    calls.push(cmd);
    if (cmd.includes('app.query')) return states('RUNNING', 'STOPPING');
    throw new Error(`unexpected: ${cmd}`);
  };
  const err = await switchEngine('llamacpp', exec).catch(e => e);
  assert.equal(err.status, 409);
  assert.equal(err.message, 'llama.cpp is still stopping — try again in a moment');
  assert.equal(calls.length, 1);
  assert.equal(engineAction(), null);
}));

test('upgrade builds the skip list from its own fresh app.query', () => withLlamacpp(async () => {
  const calls = [];
  const exec = async cmd => {
    calls.push(cmd);
    if (cmd.includes('app.query')) {
      assert.match(cmd, /"state"/);
      return JSON.stringify([
        { name: cfg.ollamaAppName, state: 'STOPPING', upgrade_available: true },
        { name: cfg.llamacppAppName, state: 'STOPPED', image_updates_available: true },
        { name: 'app-a', state: 'RUNNING', upgrade_available: true },
      ]);
    }
    if (cmd.includes('app.upgrade_bulk')) return '41';
    throw new Error(`unexpected: ${cmd}`);
  };
  // Ollama still STOPPING counts as active: llama.cpp is skipped, Ollama upgraded.
  const res = await upgradeApps(exec);
  assert.deepEqual(res, { ok: true, jobIds: [41], apps: [cfg.ollamaAppName, 'app-a'], skipped: 'llama-test' });
  assert.equal(engineAction(), null);
}));
