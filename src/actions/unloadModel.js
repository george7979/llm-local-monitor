import { ollamaGenerate } from '../lib/ollamaClient.js';

// keep_alive:0 evicts immediately, overriding the server-wide -1 for this
// call only. Ollama honours it once any in-flight generation finishes.
export async function unloadModel(name) {
  await ollamaGenerate({ model: name, keep_alive: 0 });
  return { ok: true };
}
