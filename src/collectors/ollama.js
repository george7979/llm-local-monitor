import { request, Agent } from 'undici';
import { cached } from '../lib/cache.js';
import { cfg } from '../config.js';

const agent = new Agent({ connect: { rejectUnauthorized: false } });

export function getOllamaStatus() {
  return cached('ollama', 2_000, async () => {
    const { body, statusCode } = await request(`${cfg.ollamaBaseUrl}/api/ps`, {
      method: 'GET',
      headersTimeout: 8_000,
      bodyTimeout: 8_000,
      dispatcher: agent,
    });
    if (statusCode >= 400) {
      const text = await body.text();
      throw new Error(`Ollama API ${statusCode}: ${text}`);
    }
    const data = await body.json();
    return {
      models: (data.models || []).map(m => {
        const total = m.size || 0;
        const vram = m.size_vram || 0;
        const gpuPct = total > 0 ? Math.round(vram / total * 100) : 0;
        const processor = gpuPct === 100 ? '100% GPU'
          : gpuPct === 0 ? '100% CPU'
          : `${gpuPct}% GPU / ${100 - gpuPct}% CPU`;
        return {
          name: m.name,
          parameterSize: m.details?.parameter_size || '',
          quantization: m.details?.quantization_level || '',
          sizeVram: vram,
          contextLength: m.context_length || 0,
          expiresAt: m.expires_at || null,
          processor,
        };
      }),
    };
  });
}
