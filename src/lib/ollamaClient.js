import { request, Agent } from 'undici';
import { cfg } from '../config.js';

// Separate dispatcher from the collectors': collectors poll every 5 s with
// 8 s timeouts, model loads can run for minutes. Sharing one agent would
// force one of the two into the wrong timeout regime.
const actionAgent = new Agent({ connect: { rejectUnauthorized: false } });

export async function ollamaGenerate(payload) {
  const ms = cfg.modelActionTimeoutSec * 1000;
  // stream:false is required — with streaming on, headers return immediately
  // and the timeout would govern an idle gap rather than the operation.
  const { body, statusCode } = await request(`${cfg.ollamaBaseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stream: false, ...payload }),
    headersTimeout: ms,
    bodyTimeout: ms,
    dispatcher: actionAgent,
  });
  const text = await body.text();
  if (statusCode >= 400) throw new Error(`Ollama API ${statusCode}: ${text}`);
  return text;
}
