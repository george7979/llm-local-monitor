import { config } from 'dotenv';

config({ path: '.env', override: true });

const required = ['LLM_HOST', 'LLM_USER'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
}

export const cfg = {
  llmHost: process.env.LLM_HOST,
  llmUser: process.env.LLM_USER,
  sshKeyPath: process.env.SSH_KEY_PATH || '/root/.ssh/id_ed25519',
  ipmiHost: process.env.IPMI_HOST,
  ipmiUser: process.env.IPMI_USER || 'ADMIN',
  ipmiPass: process.env.IPMI_PASS,
  ipmiInterface: process.env.IPMI_INTERFACE || 'lanplus',
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || `http://${process.env.LLM_HOST}:11434`,
  ollamaAppName: process.env.OLLAMA_APP_NAME || 'ollama',
  wakeCmd: process.env.WAKE_CMD || null,
  sleepCmd: process.env.SLEEP_CMD || null,
  pollIntervalSec: Math.max(1, parseInt(process.env.POLL_INTERVAL_SEC, 10) || 5),
};
