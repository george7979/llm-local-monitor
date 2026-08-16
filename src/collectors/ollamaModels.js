import { request, Agent } from 'undici';
import { cached } from '../lib/cache.js';
import { cfg } from '../config.js';

const agent = new Agent({ connect: { rejectUnauthorized: false } });

// Pure: shape Ollama's /api/tags payload into what the UI needs.
// `family` and `modified_at` are available but deliberately dropped —
// neither informs a load decision (see spec, Rejected Alternatives).
export function mapTags(data) {
  return {
    models: (data.models || [])
      .map(m => ({
        name: m.name,
        sizeBytes: m.size || 0,
        parameterSize: m.details?.parameter_size || '',
        quantization: m.details?.quantization_level || '',
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// Pure: exact-match lookup used to turn a typo into a clear 400
// instead of Ollama's bare 404.
export function findModel(models, name) {
  if (typeof name !== 'string' || !name.trim()) return null;
  return models.find(m => m.name === name) || null;
}

export function getAvailableModels() {
  return cached('ollama-models', 2_000, async () => {
    const { body, statusCode } = await request(`${cfg.ollamaBaseUrl}/api/tags`, {
      method: 'GET',
      headersTimeout: 8_000,
      bodyTimeout: 8_000,
      dispatcher: agent,
    });
    if (statusCode >= 400) {
      const text = await body.text();
      throw new Error(`Ollama API ${statusCode}: ${text}`);
    }
    return mapTags(await body.json());
  });
}
