import { sshExec } from '../lib/ssh.js';
import { cfg } from '../config.js';

export async function restartOllama() {
  const n = cfg.ollamaAppName;
  // stop + sleep 3 + start — proven sequence; app.restart skips the 3s GPU init gap
  await sshExec(`midclt call app.stop ${n} > /dev/null && sleep 3 && midclt call app.start ${n} > /dev/null`);
  return { ok: true };
}
