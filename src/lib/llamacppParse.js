// Pure parsing and derivation for llama-server payloads (/props, /v1/models,
// /slots, /metrics) and its launch command. No imports, no I/O.

const round1 = x => Math.round(x * 10) / 10;
const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** Prometheus text -> { name without "llamacpp:" prefix: value }. Skips comments and labelled series. */
export function parseMetrics(text) {
  const out = {};
  for (const line of String(text ?? '').split('\n')) {
    const m = /^llamacpp:([A-Za-z0-9_]+)\s+(\S+)\s*$/.exec(line.trim());
    if (!m) continue; // comments, labelled series (name{...}), junk
    const v = Number(m[2]);
    if (Number.isFinite(v)) out[m[1]] = v;
  }
  return out;
}

/** 27000000000 -> '27.0B', 350000000 -> '350M', falsy -> ''. */
export function formatParams(n) {
  if (!num(n) || n <= 0) return '';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  return `${Math.round(n / 1e6)}M`;
}

export function mapModelRow(props, models, vramBytes) {
  const meta = models?.data?.[0]?.meta;
  return {
    name: props?.model_alias || models?.data?.[0]?.id || '',
    parameterSize: formatParams(meta?.n_params),
    quantization: props?.model_ftype || meta?.ftype || '',
    contextLength: num(props?.default_generation_settings?.n_ctx) ?? num(meta?.n_ctx) ?? 0,
    sizeVram: num(vramBytes) ?? 0,
  };
}

const decoded = slot => num(slot?.next_token?.[0]?.n_decoded) ?? 0;

export function slotSample(slot, ts) {
  return {
    ts,
    idTask: slot?.id_task ?? null,
    nDecoded: decoded(slot),
    processing: Boolean(slot?.is_processing),
  };
}

// Shorter gaps than this between two samples give meaningless rates (a few
// tokens over a few milliseconds); the poll interval is seconds.
const MIN_SPEED_WINDOW_MS = 1_000;

/** tok/s between two samples of the same task; null when not comparable or under 1 s apart. */
export function liveSpeed(prev, cur) {
  if (!prev || !cur) return null;
  if (prev.idTask == null || prev.idTask !== cur.idTask) return null;
  const dt = cur.ts - prev.ts;
  const dn = cur.nDecoded - prev.nDecoded;
  if (!(dt >= MIN_SPEED_WINDOW_MS) || !(dn > 0)) return null;
  return round1(dn / (dt / 1000));
}

export function activity(slot) {
  if (!slot?.is_processing) return 'idle';
  return decoded(slot) > 0 ? 'generating' : 'reading';
}

function speedOf(tokens, seconds) {
  return num(tokens) != null && num(seconds) != null && tokens > 0 && seconds > 0
    ? round1(tokens / seconds) : null;
}
function mtpOf(accepted, draft) {
  return num(accepted) != null && num(draft) != null && draft > 0 && accepted >= 0
    ? Math.round((accepted / draft) * 100) : null;
}
/** Share of prompt tokens taken from the cache; `processed` excludes cached ones. */
export function cacheOf(cached, processed) {
  return num(cached) != null && num(processed) != null && cached >= 0 && processed >= 0
    && cached + processed > 0
    ? Math.round((cached / (cached + processed)) * 100) : null;
}

/** Speed and MTP over the span between two /metrics samples; null unless tokens_predicted_total grew. */
export function requestWindow(prevM, curM) {
  if (!prevM || !curM) return null;
  const dTokens = (num(curM.tokens_predicted_total) ?? NaN) - (num(prevM.tokens_predicted_total) ?? NaN);
  if (!(dTokens > 0)) return null;
  const d = k => (num(curM[k]) ?? NaN) - (num(prevM[k]) ?? NaN);
  return {
    speed: speedOf(dTokens, d('tokens_predicted_seconds_total')),
    mtp: mtpOf(d('spec_decode_num_accepted_tokens_total'), d('spec_decode_num_draft_tokens_total')),
    cache: cacheOf(d('prompt_tokens_cached_total'), d('prompt_tokens_total')),
    prefill: speedOf(d('prompt_tokens_total'), d('prompt_seconds_total')),
  };
}

export function lifetimeStats(m) {
  return {
    speed: speedOf(m?.tokens_predicted_total, m?.tokens_predicted_seconds_total),
    mtp: mtpOf(m?.spec_decode_num_accepted_tokens_total, m?.spec_decode_num_draft_tokens_total),
    cache: cacheOf(m?.prompt_tokens_cached_total, m?.prompt_tokens_total),
    prefill: speedOf(m?.prompt_tokens_total, m?.prompt_seconds_total),
  };
}

/**
 * Cache share of the prompts now being processed (summed over busy slots),
 * from /slots; null when no slot is busy or none has its prompt counted yet.
 */
export function liveCache(slots) {
  let cached = 0, total = 0;
  for (const s of Array.isArray(slots) ? slots : []) {
    if (!s?.is_processing) continue;
    // The prompt alone: n_prompt_tokens includes the tokens generated so far.
    const seq = num(s.n_prompt_tokens), c = num(s.n_prompt_tokens_cache);
    const t = seq == null ? null : seq - decoded(s);
    if (t == null || c == null || t <= 0 || c > t) continue;
    cached += c; total += t;
  }
  return total > 0 ? { pct: Math.round((cached / total) * 100), cached, total } : null;
}

// /slots n_prompt_tokens already counts the tokens generated so far
// (prompt + n_decoded): it is the slot's whole sequence, not the prompt alone.
export function contextFill(slot) {
  return {
    used: num(slot?.n_prompt_tokens) ?? 0,
    total: num(slot?.n_ctx) ?? 0,
  };
}

/** Value following the first of the given flags (also --flag=value); undefined when absent. */
function flagValue(args, names) {
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    for (const n of names) {
      if (a === n) return i + 1 < args.length ? String(args[i + 1]) : undefined;
      if (a.startsWith(`${n}=`)) return a.slice(n.length + 1);
    }
  }
  return undefined;
}

/** --cache-ram value (MiB) for display: 16384 -> '16 GiB', 512 -> '512 MiB', -1 -> 'no limit', 0 -> 'off'. */
export function formatCacheRam(v) {
  const n = Number(v);
  if (v == null || v === '' || !Number.isInteger(n)) return v;
  if (n < 0) return 'no limit';
  if (n === 0) return 'off';
  return n >= 1024 ? `${Math.round((n / 1024) * 10) / 10} GiB` : `${n} MiB`;
}

const SPLIT_TITLE = 'How the model is split across GPUs (-sm / --split-mode): layer = whole layers per card, row = rows of each layer, tensor = each layer across all cards, none = one card';

const N_PREDICT_TITLE = 'Max tokens generated per request (-n / --n-predict); longer replies are cut off';

/** --n-predict as shown: 8192 → '8k', 1000 → '1000'; -1 / 0 / -2 (no fixed limit) and non-numbers → null. */
export function formatNPredict(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n % 1024 === 0 ? `${n / 1024}k` : String(n);
}

const CACHE_RAM_TITLE = 'Prompt cache limit in host RAM (--cache-ram); llama-server does not report how much of it is in use';

/** Fixed-order list of the launch parameters worth showing, each with a tooltip saying what it means; unknown flags ignored. */
export function launchParams(command) {
  if (!Array.isArray(command)) return [];
  const out = [];
  const add = (label, value, title) => { if (value != null && value !== '') out.push({ label, value, title }); };
  const pair = (a, b) => (a && b ? (a === b ? a : `${a} / ${b}`) : a || b);

  add('split', flagValue(command, ['-sm', '--split-mode']), SPLIT_TITLE);
  // Speculative decoding: MTP gets its own label, any other type shows as
  // "spec <type> ×n"; "none" shows nothing.
  const spec = flagValue(command, ['--spec-type']);
  const draftN = flagValue(command, ['--spec-draft-n-max']);
  const drafted = draftN ? `, up to ${draftN} tokens drafted per step (--spec-draft-n-max)` : '';
  if (spec && /mtp/i.test(spec)) {
    add('MTP', draftN ? `×${draftN}` : 'on',
      `Speculative decoding with the model's own MTP head (--spec-type ${spec})${drafted}; the header shows how many drafts are accepted`);
  } else if (spec && spec.toLowerCase() !== 'none') {
    add('spec', draftN ? `${spec} ×${draftN}` : spec, `Speculative decoding (--spec-type ${spec})${drafted}`);
  }
  add('slots', flagValue(command, ['-np', '--parallel']),
    'Requests the server handles in parallel (-np / --parallel); the context is split between them');
  add('threads', flagValue(command, ['-t', '--threads']), 'CPU threads for the work not done on the GPUs (-t / --threads)');
  add('KV', pair(flagValue(command, ['-ctk', '--cache-type-k']), flagValue(command, ['-ctv', '--cache-type-v'])),
    'Precision of the context (KV) cache in VRAM, keys / values (-ctk / -ctv); lower fits more context at a small cost in accuracy');
  const cram = flagValue(command, ['-cram', '--cache-ram']);
  if (cram != null && cram !== '') add('cache', formatCacheRam(cram), CACHE_RAM_TITLE);
  const b = flagValue(command, ['-b', '--batch-size']);
  const ub = flagValue(command, ['-ub', '--ubatch-size']);
  add('batch', b && ub ? `${b} / ${ub}` : b || ub,
    'Prompt tokens processed per step, logical / physical batch (-b / -ub); larger speeds up prefill at the cost of VRAM');
  add('reasoning', flagValue(command, ['--reasoning-budget']),
    'Max thinking tokens before the answer (--reasoning-budget); -1 = no limit, 0 = thinking off');
  add('out', formatNPredict(flagValue(command, ['-n', '--n-predict'])), N_PREDICT_TITLE);
  return out;
}

/** Overall activity across raw /slots entries: generating > reading > idle; null without slots. */
export function overallActivity(slots) {
  if (!Array.isArray(slots) || slots.length === 0) return null;
  const all = slots.map(activity);
  if (all.includes('generating')) return 'generating';
  if (all.includes('reading')) return 'reading';
  return 'idle';
}

/** True when a cumulative counter went down between two /metrics samples (server restarted). */
export function countersWentBackwards(prevM, curM) {
  if (!prevM || !curM) return false;
  return ['tokens_predicted_total', 'tokens_predicted_seconds_total'].some(k =>
    num(prevM[k]) != null && num(curM[k]) != null && curM[k] < prevM[k]);
}

/** live (sum over slots) -> last window -> lifetime -> null. `lives` holds per-slot tok/s or null. */
export function pickSpeed(lives, last, lifetime) {
  const found = lives.filter(v => v != null);
  if (found.length) return { value: round1(found.reduce((a, b) => a + b, 0)), window: 'live' };
  if (last?.speed != null) return { value: last.speed, window: 'last' };
  if (lifetime?.speed != null) return { value: lifetime.speed, window: 'lifetime' };
  return null;
}

/** last window -> lifetime -> null. */
export function pickMtp(last, lifetime) {
  if (last?.mtp != null) return { pct: last.mtp, window: 'last' };
  if (lifetime?.mtp != null) return { pct: lifetime.mtp, window: 'lifetime' };
  return null;
}

/** live (current prompts) -> last window -> lifetime -> null. */
export function pickCache(live, last, lifetime) {
  if (live) return { pct: live.pct, window: 'live', cached: live.cached, total: live.total };
  if (last?.cache != null) return { pct: last.cache, window: 'last' };
  if (lifetime?.cache != null) return { pct: lifetime.cache, window: 'lifetime' };
  return null;
}

/** Prompt-reading speed (tok/s, cached tokens excluded): last window -> lifetime -> null. */
export function pickPrefill(last, lifetime) {
  if (last?.prefill != null) return { value: last.prefill, window: 'last' };
  if (lifetime?.prefill != null) return { value: lifetime.prefill, window: 'lifetime' };
  return null;
}

/**
 * Longest sequence seen since engine start (/metrics n_tokens_max) against
 * the largest slot context; null without either.
 */
export function contextPeak(metrics, slots) {
  const tokens = num(metrics?.n_tokens_max);
  const total = Math.max(0, ...(Array.isArray(slots) ? slots : []).map(s => num(s?.n_ctx) ?? 0));
  return tokens != null && tokens > 0 && total > 0 ? { tokens, total } : null;
}

/** Empty between-poll state: nothing sampled yet. */
export function initialState() {
  return { slots: new Map(), metrics: null, lastWindow: null };
}

/** /props and /v1/models answered 200 with the shape the model row needs. */
export function modelPayloadsOk(props, models) {
  return !!props && typeof props === 'object' && !Array.isArray(props)
    && !!models && Array.isArray(models.data);
}

/**
 * One step of the between-poll state machine. Pure.
 * `slots`: raw /slots array, or null when that GET failed.
 * `metrics`: parsed /metrics object, or null when that GET failed.
 * Returns the next state plus this poll's per-slot live speeds, lifetime stats
 * and last-window result (null when metrics failed or counters went backwards).
 */
export function advance(state, { slots, metrics, now }) {
  const cur = new Map();
  let lives = [];
  for (const s of slots ?? []) {
    const sample = slotSample(s, now);
    cur.set(s.id, sample);
    lives.push(liveSpeed(state.slots.get(s.id), sample));
  }
  if (!metrics) {
    // Metrics unavailable: keep the old metrics and window, report no window figures.
    return { state: { ...state, slots: cur }, lives, lifetime: null, lastWindow: null };
  }
  if (countersWentBackwards(state.metrics, metrics)) {
    // Server restarted: nothing from before is comparable.
    return {
      state: { slots: new Map(), metrics, lastWindow: null },
      lives: lives.map(() => null),
      lifetime: lifetimeStats(metrics),
      lastWindow: null,
    };
  }
  const lastWindow = requestWindow(state.metrics, metrics) ?? state.lastWindow;
  return {
    state: { slots: cur, metrics, lastWindow },
    lives,
    lifetime: lifetimeStats(metrics),
    lastWindow,
  };
}
