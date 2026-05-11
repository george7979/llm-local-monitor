import { request, Agent } from 'undici';
import { cfg } from '../config.js';

const agent = new Agent({ connect: { rejectUnauthorized: false } });

export async function truenasGet(path) {
  if (!cfg.truenasApiKey) throw new Error('TRUENAS_API_KEY not configured');
  const { body, statusCode } = await request(`${cfg.truenasBaseUrl}${path}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${cfg.truenasApiKey}`,
      'Content-Type': 'application/json',
    },
    headersTimeout: 8_000,
    bodyTimeout: 8_000,
    dispatcher: agent,
  });
  if (statusCode >= 400) {
    const text = await body.text();
    throw new Error(`TrueNAS API ${statusCode}: ${text}`);
  }
  return body.json();
}
