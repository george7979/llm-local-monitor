import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withPendingJobs, parseAppsAndJobs, refuseWhileEngineJobs, JOBS_MARKER, JOBS_FAILED } from '../src/lib/truenasJobs.js';

const N = { ollama: 'ollama', llamacpp: 'llama-cpp' };
const APPS = [{ name: 'ollama', state: 'RUNNING' }];

test('withPendingJobs: one command, a failed job read does not fail the app read', () => {
  const cmd = withPendingJobs("midclt call app.query '[]'");
  assert.match(cmd, /^midclt call app\.query '\[\]' && echo /);
  assert.match(cmd, /core\.get_jobs '\[\["state","in",\["WAITING","RUNNING"\]\]\]'/);
  // a hanging job read is cut short and reported as failed, not as an ssh timeout of the whole poll
  assert.match(cmd, /\{ timeout 5 midclt call core\.get_jobs .* \|\| echo /);
  assert.match(cmd, /\|\| echo /);
  // filtered by state only: no app method in the read itself
  assert.doesNotMatch(cmd, /app\.(start|stop|upgrade)/);
});

test('parseAppsAndJobs: apps and jobs', () => {
  const jobs = [{ id: 1, method: 'app.start', state: 'RUNNING', arguments: ['ollama'] }];
  const raw = `${JSON.stringify(APPS)}\n${JOBS_MARKER}\n${JSON.stringify(jobs)}`;
  assert.deepEqual(parseAppsAndJobs(raw), { apps: APPS, jobs, jobsError: null });
});

test('parseAppsAndJobs: unreadable job list is reported, the apps survive', () => {
  for (const tail of [`\n${JOBS_MARKER}\n${JOBS_FAILED}`, `\n${JOBS_MARKER}\nnot json`, `\n${JOBS_MARKER}\n{"a":1}`, '']) {
    const r = parseAppsAndJobs(JSON.stringify(APPS) + tail);
    assert.deepEqual(r.apps, APPS, tail);
    assert.equal(r.jobs, null, tail);
    assert.ok(r.jobsError, tail);
  }
});

test('parseAppsAndJobs: unreadable app list throws', () => {
  assert.throws(() => parseAppsAndJobs(`garbage\n${JOBS_MARKER}\n[]`));
});

test('refuseWhileEngineJobs: 409 naming the job, 503 when unreadable, quiet otherwise', () => {
  const busy = { jobs: [{ id: 3, method: 'app.upgrade', state: 'WAITING', arguments: ['ollama'] }], jobsError: null };
  const e = (() => { try { refuseWhileEngineJobs(busy, N); } catch (err) { return err; } })();
  assert.equal(e.status, 409);
  assert.equal(e.message, 'TrueNAS is still working on ollama (app.upgrade) — try again when it finishes');
  assert.throws(() => refuseWhileEngineJobs({ jobs: null, jobsError: 'core.get_jobs failed' }, N), err => err.status === 503);
  assert.doesNotThrow(() => refuseWhileEngineJobs({ jobs: [], jobsError: null }, N));
});
