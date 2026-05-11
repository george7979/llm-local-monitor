import { execFile } from 'child_process';
import { cfg } from '../config.js';

export function sleepServer() {
  return new Promise((resolve, reject) => {
    const onDone = (err, stdout, stderr) => {
      if (err) reject(Object.assign(new Error(err.message), { stderr }));
      else resolve({ ok: true, output: stdout.trim() });
    };

    if (cfg.sleepCmd) {
      // Custom command from SLEEP_CMD env var — user-defined, supports any BMC
      execFile('/bin/sh', ['-c', cfg.sleepCmd], { timeout: 15_000 }, onDone);
    } else {
      // Default: IPMI graceful shutdown (ACPI power soft) — TrueNAS CE servers
      // don't support suspend; power soft triggers OS-level graceful shutdown
      execFile('ipmitool', [
        '-I', cfg.ipmiInterface,
        '-H', cfg.ipmiHost,
        '-U', cfg.ipmiUser,
        '-P', cfg.ipmiPass,
        'chassis', 'power', 'soft',
      ], { timeout: 15_000 }, onDone);
    }
  });
}
