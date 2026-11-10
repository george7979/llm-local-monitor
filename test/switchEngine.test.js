import { test } from 'node:test';
import assert from 'node:assert/strict';
import { switchEngine, isSwitching } from '../src/actions/switchEngine.js';
import { cfg } from '../src/config.js';


test('concurrent switches: exactly one 409, flag clears after an error', async () => {
  const saved = cfg.llamacppAppName;
  cfg.llamacppAppName ??= 'x';
  try {
    let release;
    const gate = new Promise(r => { release = r; });
    const exec = async cmd => {
      if (cmd.includes('app.query')) { await gate; return JSON.stringify([
        { name: cfg.ollamaAppName, state: 'RUNNING' }, { name: cfg.llamacppAppName, state: 'STOPPED' }]); }
      throw new Error('stop failed');
    };
    const first = switchEngine('llamacpp', exec);
    const second = await switchEngine('llamacpp', exec).catch(e => e);
    assert.equal(second.status, 409);
    assert.equal(isSwitching(), true);
    release();
    await assert.rejects(first, /stop failed/);
    assert.equal(isSwitching(), false);
  } finally {
    cfg.llamacppAppName = saved;
  }
});
