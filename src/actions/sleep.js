import { execFile } from 'child_process';
import { cfg } from '../config.js';

export function sleepServer() {
  return new Promise((resolve, reject) => {
    // TrueNAS CE servers don't support suspend — graceful ACPI shutdown via IPMI
    const args = [
      '-I', 'lanplus',
      '-H', cfg.ipmiHost,
      '-U', cfg.ipmiUser,
      '-P', cfg.ipmiPass,
      'chassis', 'power', 'soft',
    ];
    execFile('ipmitool', args, { timeout: 15_000 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(new Error(err.message), { stderr }));
      else resolve({ ok: true, output: stdout.trim() });
    });
  });
}
