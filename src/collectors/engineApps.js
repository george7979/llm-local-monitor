import { sshExec } from '../lib/ssh.js';
import { cached } from '../lib/cache.js';
import { cfg } from '../config.js';
import { pickEngine } from '../lib/engine.js';
import { launchParams } from '../lib/llamacppParse.js';

const SELECT = ['name', 'state', 'version', 'human_version', 'metadata',
  'upgrade_available', 'image_updates_available', 'active_workloads'];

/** The only `app.query` per poll; every consumer of app state reads from here. */
export function getApps() {
  return cached('apps', 2_000, async () => {
    const raw = await sshExec(`midclt call app.query '[]' '${JSON.stringify({ select: SELECT })}'`);
    return JSON.parse(raw);
  });
}

const summary = app => (app ? { state: app.state, upgradeAvailable: !!(app.upgrade_available || app.image_updates_available) } : null);

/**
 * `procs` = rows from getGpuProcs() (`container` is the TrueNAS app name);
 * `apps` = getApps()' list when the caller already has it (routes.js reads
 * both in parallel; `cached()` does not share an in-flight call).
 */
export async function getEngineState(procs, apps) {
  apps ??= await getApps();
  const byName = name => (name ? apps.find(a => a.name === name) : undefined);
  const ollama = byName(cfg.ollamaAppName);
  const llamacpp = byName(cfg.llamacppAppName);
  const names = { ollama: cfg.ollamaAppName, llamacpp: cfg.llamacppAppName };
  const { active, conflict } = pickEngine({ ollama, llamacpp }, procs, names);
  const activeApp = active === 'llamacpp' ? llamacpp : active === 'ollama' ? ollama : null;
  return {
    active,
    conflict,
    notFound: cfg.llamacppAppName && !llamacpp ? cfg.llamacppAppName : null,
    apps: { ollama: summary(ollama), llamacpp: summary(llamacpp) },
    updatesWaiting: !!(activeApp && (activeApp.upgrade_available || activeApp.image_updates_available)),
  };
}

/** Launch parameters of an app's first service, from `app.config`. */
export function getLaunchInfo(appName) {
  return cached(`launch:${appName}`, 60_000, async () => {
    const raw = await sshExec(`midclt call app.config '${appName}'`);
    const service = Object.values(JSON.parse(raw)?.services ?? {})[0];
    const command = Array.isArray(service?.command) ? service.command : [];
    return { params: launchParams(command), command: command.join(' ') };
  });
}
