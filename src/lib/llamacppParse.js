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

/** 26895998464 -> '26.9B', 350000000 -> '350M', falsy -> ''. */
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

/** tok/s between two samples of the same task; null when not comparable. */
export function liveSpeed(prev, cur) {
  if (!prev || !cur) return null;
  if (prev.idTask == null || prev.idTask !== cur.idTask) return null;
  const dt = cur.ts - prev.ts;
  const dn = cur.nDecoded - prev.nDecoded;
  if (!(dt > 0) || !(dn > 0)) return null;
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

/** Speed and MTP over the span between two /metrics samples; null unless tokens_predicted_total grew. */
export function requestWindow(prevM, curM) {
  if (!prevM || !curM) return null;
  const dTokens = (num(curM.tokens_predicted_total) ?? NaN) - (num(prevM.tokens_predicted_total) ?? NaN);
  if (!(dTokens > 0)) return null;
  const d = k => (num(curM[k]) ?? NaN) - (num(prevM[k]) ?? NaN);
  return {
    speed: speedOf(dTokens, d('tokens_predicted_seconds_total')),
    mtp: mtpOf(d('spec_decode_num_accepted_tokens_total'), d('spec_decode_num_draft_tokens_total')),
  };
}

export function lifetimeStats(m) {
  return {
    speed: speedOf(m?.tokens_predicted_total, m?.tokens_predicted_seconds_total),
    mtp: mtpOf(m?.spec_decode_num_accepted_tokens_total, m?.spec_decode_num_draft_tokens_total),
  };
}

export function contextFill(slot) {
  return {
    used: (num(slot?.n_prompt_tokens) ?? 0) + decoded(slot),
    total: num(slot?.n_ctx) ?? 0,
    cached: num(slot?.n_prompt_tokens_cache) ?? 0,
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

/** Fixed-order list of the launch parameters worth showing; unknown flags ignored. */
export function launchParams(command) {
  if (!Array.isArray(command)) return [];
  const out = [];
  const add = (label, value) => { if (value != null && value !== '') out.push({ label, value }); };
  const pair = (a, b) => (a && b ? (a === b ? a : `${a} / ${b}`) : a || b);

  add('split', flagValue(command, ['-sm', '--split-mode']));
  const spec = flagValue(command, ['--spec-type']);
  if (spec && /mtp/i.test(spec)) {
    const n = flagValue(command, ['--spec-draft-n-max']);
    add('MTP', n ? `×${n}` : 'on');
  }
  add('slots', flagValue(command, ['-np', '--parallel']));
  add('threads', flagValue(command, ['-t', '--threads']));
  add('KV', pair(flagValue(command, ['-ctk', '--cache-type-k']), flagValue(command, ['-ctv', '--cache-type-v'])));
  const b = flagValue(command, ['-b', '--batch-size']);
  const ub = flagValue(command, ['-ub', '--ubatch-size']);
  add('batch', b && ub ? `${b} / ${ub}` : b || ub);
  add('reasoning', flagValue(command, ['--reasoning-budget']));
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
