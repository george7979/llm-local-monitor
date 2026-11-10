// The TrueNAS jobs still running, read in the same ssh round trip as an
// `app.query`. No ssh here: callers pass the command to their own exec.
import { engineJobsPending } from './engine.js';

export const JOBS_MARKER = '--- core.get_jobs ---';
export const JOBS_FAILED = '--- core.get_jobs failed ---';

// Filtered by state only; the method filter lives in engineJobsPending().
const PENDING_JOBS = `midclt call core.get_jobs '[["state","in",["WAITING","RUNNING"]]]' '{"select":["id","method","state","arguments"]}'`;

/**
 * `appQuery` followed by the pending-job read. A failed `app.query` still
 * fails the whole command; a failed job read prints JOBS_FAILED instead, so
 * the app list survives it.
 */
export const withPendingJobs = appQuery =>
  `${appQuery} && echo '${JOBS_MARKER}' && { ${PENDING_JOBS} || echo '${JOBS_FAILED}'; }`;

/**
 * Splits withPendingJobs() output into `{ apps, jobs, jobsError }`. An
 * unreadable app list throws (JSON.parse); an unreadable job list leaves
 * `jobs: null` with `jobsError` set.
 */
export function parseAppsAndJobs(raw) {
  const at = raw.lastIndexOf(JOBS_MARKER);
  const apps = JSON.parse(at < 0 ? raw : raw.slice(0, at));
  if (at < 0) return { apps, jobs: null, jobsError: 'no job list in the response' };
  const rest = raw.slice(at + JOBS_MARKER.length).trim();
  if (rest === JOBS_FAILED) return { apps, jobs: null, jobsError: 'core.get_jobs failed' };
  try {
    const jobs = JSON.parse(rest);
    if (Array.isArray(jobs)) return { apps, jobs, jobsError: null };
  } catch { /* reported below */ }
  return { apps, jobs: null, jobsError: 'core.get_jobs did not return a list' };
}

const fail = (status, message) => Object.assign(new Error(message), { status });

/**
 * Runs withPendingJobs(appQuery) on `exec` and parses it. A failed command or
 * an unreadable app list means the jobs are unknown too: 503 (fail closed).
 */
export async function readAppsAndJobs(exec, appQuery) {
  try {
    return parseAppsAndJobs(await exec(withPendingJobs(appQuery)));
  } catch (err) {
    throw fail(503, `Cannot read the engine state: ${err.message}`);
  }
}

/**
 * Throws 409 while TrueNAS still has a job on an engine app, 503 when the job
 * list could not be read (fail closed: an unseen job may be starting one).
 */
export function refuseWhileEngineJobs({ jobs, jobsError }, names) {
  if (jobsError) throw fail(503, `Cannot read TrueNAS jobs: ${jobsError}`);
  const [job] = engineJobsPending(jobs, names);
  if (job) throw fail(409, `TrueNAS is still working on ${job.app} (${job.method}) — try again when it finishes`);
}
