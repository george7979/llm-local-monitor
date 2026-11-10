import { request, Agent } from 'undici';
import { cached } from '../lib/cache.js';
import { cfg } from '../config.js';
import {
  parseMetrics, mapModelRow, contextFill, overallActivity, pickSpeed, pickMtp,
  initialState, advance, modelPayloadsOk,
} from '../lib/llamacppParse.js';

const agent = new Agent({ connect: { rejectUnauthorized: false } });

// Between-poll state; the transitions live in llamacppParse.js advance().
let state = initialState();

async function get(path, asText = false) {
  const { body, statusCode } = await request(`${cfg.llamacppBaseUrl}${path}`, {
    method: 'GET',
    headersTimeout: 8_000,
    bodyTimeout: 8_000,
    dispatcher: agent,
  });
  if (statusCode >= 400) {
    await body.dump();
    throw new Error(`llama-server ${path} ${statusCode}`);
  }
  return asText ? body.text() : body.json();
}

const NOT_READY = { models: [], loading: true, activity: null, speed: null, mtp: null, slots: [] };

export function getLlamacppStatus(vramBytes) {
  return cached('llamacpp', 2_000, async () => {
    const [props, models, slots, metricsText] = await Promise.allSettled([
      get('/props'), get('/v1/models'), get('/slots'), get('/metrics', true),
    ]);
    if (props.status === 'rejected' || models.status === 'rejected'
        || !modelPayloadsOk(props.value, models.value)) {
      state = initialState(); // nothing is compared across the gap
      return { ...NOT_READY };
    }

    const slotList = slots.status === 'fulfilled' && Array.isArray(slots.value) ? slots.value : null;
    const metrics = metricsText.status === 'fulfilled' ? parseMetrics(metricsText.value) : null;
    const step = advance(state, { slots: slotList, metrics, now: Date.now() });
    state = step.state;

    return {
      models: [mapModelRow(props.value, models.value, vramBytes)],
      loading: false,
      activity: overallActivity(slotList),
      speed: pickSpeed(step.lives, step.lastWindow, step.lifetime),
      mtp: pickMtp(step.lastWindow, step.lifetime),
      slots: (slotList ?? []).map(contextFill),
    };
  });
}
