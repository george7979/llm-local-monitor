import { execFile } from 'child_process';
import { cfg } from '../config.js';

export function wakeServer() {
  return new Promise((resolve, reject) => {
    const onDone = (err, stdout, stderr) => {
      if (err) reject(Object.assign(new Error(err.message), { stderr }));
      else resolve({ ok: true, output: stdout.trim() });
    };

    if (cfg.wakeCmd) {
      // Custom command from WAKE_CMD env var — user-defined, supports any BMC
      execFile('/bin/sh', ['-c', cfg.wakeCmd], { timeout: 15_000 }, onDone);
    } else {
      // Default: ipmitool IPMI v2.0 (Supermicro and compatible)
      execFile('ipmitool', [
        '-I', cfg.ipmiInterface,
        '-H', cfg.ipmiHost,
        '-U', cfg.ipmiUser,
        '-P', cfg.ipmiPass,
        'chassis', 'power', 'on',
      ], { timeout: 15_000 }, onDone);
    }
  });
}
