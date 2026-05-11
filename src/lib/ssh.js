import { execFile } from 'child_process';
import { cfg } from '../config.js';

const TIMEOUT_MS = 10_000;

export function sshExec(command) {
  return new Promise((resolve, reject) => {
    const args = [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=8',
      '-o', 'BatchMode=yes',
      '-i', cfg.sshKeyPath,
      `${cfg.llmUser}@${cfg.llmHost}`,
      command,
    ];
    execFile('ssh', args, { timeout: TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        const e = Object.assign(new Error(err.message), { stderr, code: err.code });
        reject(e);
      } else {
        resolve(stdout.trim());
      }
    });
  });
}
