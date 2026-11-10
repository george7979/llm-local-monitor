import { request, Agent } from 'undici';
import { cached } from '../lib/cache.js';
import { cfg } from '../config.js';
import {
  parseMetrics, mapModelRow, slotSample, liveSpeed, requestWindow, lifetimeStats,
  contextFill, overallActivity, countersWentBackwards, pickSpeed, pickMtp,
} from '../lib/llamacppParse.js';

const agent = new Agent({ connect: { rejectUnauthorized: false } });

// Between-poll state (same idea as the app card's previous CPU sample).
let prevSlots = new Map(); // slot id -> slotSample
let prevMetrics = null;
let lastWindow = null;     // last requestWindow() result seen

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
    if (props.status === 'rejected' || models.status === 'rejected') return { ...NOT_READY };

    const now = Date.now();
    const slotList = slots.status === 'fulfilled' && Array.isArray(slots.value) ? slots.value : null;
    const curSlots = new Map();
    const lives = [];
    for (const s of slotList ?? []) {
      const cur = slotSample(s, now);
      curSlots.set(s.id, cur);
      lives.push(liveSpeed(prevSlots.get(s.id), cur));
    }
    prevSlots = curSlots;

    let lifetime = null;
    if (metricsText.status === 'fulfilled') {
      const cur = parseMetrics(metricsText.value);
      if (countersWentBackwards(prevMetrics, cur)) {
        prevSlots = new Map();
        lastWindow = null;
        lives.fill(null);
      } else {
        lastWindow = requestWindow(prevMetrics, cur) ?? lastWindow;
      }
      prevMetrics = cur;
      lifetime = lifetimeStats(cur);
    }

    return {
      models: [mapModelRow(props.value, models.value, vramBytes)],
      loading: false,
      activity: overallActivity(slotList),
      speed: pickSpeed(lives, metricsText.status === 'fulfilled' ? lastWindow : null, lifetime),
      mtp: pickMtp(metricsText.status === 'fulfilled' ? lastWindow : null, lifetime),
      slots: (slotList ?? []).map(contextFill),
    };
  });
}
