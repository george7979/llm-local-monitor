import { sshExec } from '../lib/ssh.js';

export async function restartEngine(appName) {
  // stop + sleep 3 + start — proven sequence; app.restart skips the 3s GPU init gap
  await sshExec(`midclt call app.stop '${appName}' > /dev/null && sleep 3 && midclt call app.start '${appName}' > /dev/null`);
  return { ok: true };
}
