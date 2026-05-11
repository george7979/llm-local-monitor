import { execFile } from 'child_process';
import { cfg } from '../config.js';

export function wakeServer() {
  return new Promise((resolve, reject) => {
    const args = [
      '-I', 'lanplus',
      '-H', cfg.ipmiHost,
      '-U', cfg.ipmiUser,
      '-P', cfg.ipmiPass,
      'chassis', 'power', 'on',
    ];
    execFile('ipmitool', args, { timeout: 15_000 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(new Error(err.message), { stderr }));
      else resolve({ ok: true, output: stdout.trim() });
    });
  });
}
