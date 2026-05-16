import { sshExec } from '../lib/ssh.js';
import { cfg } from '../config.js';

export async function upgradeOllama() {
  const result = await sshExec(`midclt call app.upgrade '"${cfg.ollamaAppName}"'`);
  const jobId = parseInt(result, 10);
  if (!jobId) throw new Error('Unexpected response from app.upgrade');
  return { ok: true, jobId };
}
