import { config } from 'dotenv';
import { readFileSync } from 'fs';
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));

config({ path: '.env', override: true });

const required = ['LLM_HOST', 'LLM_USER'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
}

export const cfg = {
  version,
  llmHost: process.env.LLM_HOST,
  llmUser: process.env.LLM_USER,
  sshKeyPath: process.env.SSH_KEY_PATH || '/root/.ssh/id_ed25519',
  ipmiHost: process.env.IPMI_HOST,
  ipmiUser: process.env.IPMI_USER || 'ADMIN',
  ipmiPass: process.env.IPMI_PASS,
  ipmiInterface: process.env.IPMI_INTERFACE || 'lanplus',
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || `http://${process.env.LLM_HOST}:11434`,
  ollamaAppName: process.env.OLLAMA_APP_NAME || 'ollama',
  networkPhysIfaces: process.env.NETWORK_PHYS_IFACES
    ? process.env.NETWORK_PHYS_IFACES.split(',').map(s => s.trim()).filter(Boolean)
    : null,
  networkHostIface: process.env.NETWORK_HOST_IFACE || null,
  networkLinkSpeedMbit: parseInt(process.env.NETWORK_LINK_SPEED_MBIT, 10) || 0,
  wakeCmd: process.env.WAKE_CMD || null,
  sleepCmd: process.env.SLEEP_CMD || null,
  pollIntervalSec: Math.max(1, parseInt(process.env.POLL_INTERVAL_SEC, 10) || 5),
};
