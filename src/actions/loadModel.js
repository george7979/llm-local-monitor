import { ollamaGenerate } from '../lib/ollamaClient.js';

// Empty prompt loads the weights into VRAM without generating tokens.
// keep_alive:-1 is passed explicitly rather than relying on the server
// default, so the request stays self-describing.
export async function loadModel(name) {
  await ollamaGenerate({ model: name, prompt: '', keep_alive: -1 });
  return { ok: true };
}
