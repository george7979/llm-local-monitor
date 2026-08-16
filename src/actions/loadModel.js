import { ollamaGenerate } from '../lib/ollamaClient.js';

// Empty prompt loads the weights into VRAM without generating tokens.
// keep_alive:-1 is passed explicitly rather than relying on the server
// default, so the request stays self-describing.
export async function loadModel(name) {
  try {
    await ollamaGenerate({ model: name, prompt: '', keep_alive: -1 });
  } catch (err) {
    // Embedding-only models reject /api/generate. Warming them from here is
    // pointless anyway — clients load them on demand and they are small — so
    // say that plainly instead of leaking Ollama's wording. Unloading them
    // still works: the keep_alive:0 path never reaches the capability check.
    if (/does not support generate/i.test(err.message)) {
      throw new Error(`${name} is an embedding model — clients load it on demand, it cannot be warmed from here`);
    }
    throw err;
  }
  return { ok: true };
}
