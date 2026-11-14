import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMetrics, formatParams, mapModelRow, slotSample, liveSpeed, activity,
  requestWindow, lifetimeStats, contextFill, launchParams,
  overallActivity, countersWentBackwards, pickSpeed, pickMtp, formatCacheRam, pickPrefill, contextPeak,
  cacheOf, liveCache, pickCache,
  initialState, advance, modelPayloadsOk,
} from '../src/lib/llamacppParse.js';

const METRICS = `# HELP llamacpp:prompt_tokens_total x
llamacpp:prompt_tokens_total 1000
llamacpp:prompt_tokens_cached_total 3.5e+06
llamacpp:tokens_predicted_total 2000
llamacpp:tokens_predicted_seconds_total 100
llamacpp:spec_decode_num_draft_tokens_total 500
llamacpp:spec_decode_num_accepted_tokens_total 300
llamacpp:spec_decode_num_accepted_tokens_per_pos_total{position="0"} 7
`;
test('parseMetrics', () => {
  const m = parseMetrics(METRICS);
  assert.equal(m.prompt_tokens_total, 1000);
  assert.equal(m.prompt_tokens_cached_total, 3500000);
  assert.equal('spec_decode_num_accepted_tokens_per_pos_total' in m, false);
  assert.deepEqual(parseMetrics(''), {});
});
test('formatParams', () => {
  assert.equal(formatParams(27_000_000_000), '27.0B');
  assert.equal(formatParams(7_600_000_000), '7.6B');
  assert.equal(formatParams(350_000_000), '350M');
  assert.equal(formatParams(0), '');
  assert.equal(formatParams(undefined), '');
});
test('lifetimeStats', () => {
  assert.deepEqual(lifetimeStats(parseMetrics(METRICS)), { speed: 20, mtp: 60, cache: 100, prefill: null });
  assert.deepEqual(lifetimeStats({ tokens_predicted_total: 10, tokens_predicted_seconds_total: 2 }), { speed: 5, mtp: null, cache: null, prefill: null });
  assert.deepEqual(lifetimeStats({ spec_decode_num_draft_tokens_total: 0 }), { speed: null, mtp: null, cache: null, prefill: null });
  assert.deepEqual(lifetimeStats(null), { speed: null, mtp: null, cache: null, prefill: null });
});
test('requestWindow', () => {
  const a = { tokens_predicted_total: 2000, tokens_predicted_seconds_total: 100, spec_decode_num_draft_tokens_total: 500, spec_decode_num_accepted_tokens_total: 300 };
  const b = { tokens_predicted_total: 2300, tokens_predicted_seconds_total: 110, spec_decode_num_draft_tokens_total: 700, spec_decode_num_accepted_tokens_total: 350 };
  assert.deepEqual(requestWindow(a, b), { speed: 30, mtp: 25, cache: null, prefill: null });
  assert.equal(requestWindow(a, a), null);          // nothing finished
  assert.equal(requestWindow(b, a), null);          // counters went backwards
  assert.equal(requestWindow(null, b), null);
});
test('requestWindow: no bogus values from partial counters', () => {
  const a = { tokens_predicted_total: 10, tokens_predicted_seconds_total: 1 };
  // no MTP counters, seconds did not move
  assert.deepEqual(requestWindow(a, { tokens_predicted_total: 20, tokens_predicted_seconds_total: 1 }), { speed: null, mtp: null, cache: null, prefill: null });
  // no MTP counters at all
  assert.deepEqual(requestWindow(a, { tokens_predicted_total: 20, tokens_predicted_seconds_total: 2 }), { speed: 10, mtp: null, cache: null, prefill: null });
  // draft counter reset while tokens grew: mtp null, never negative
  const c = { ...a, spec_decode_num_draft_tokens_total: 100, spec_decode_num_accepted_tokens_total: 50 };
  const d = { tokens_predicted_total: 20, tokens_predicted_seconds_total: 2, spec_decode_num_draft_tokens_total: 10, spec_decode_num_accepted_tokens_total: 5 };
  assert.deepEqual(requestWindow(c, d), { speed: 10, mtp: null, cache: null, prefill: null });
  // draft counter unchanged: no division by zero
  const e = { ...c, tokens_predicted_total: 20, tokens_predicted_seconds_total: 2 };
  assert.deepEqual(requestWindow(c, e), { speed: 10, mtp: null, cache: null, prefill: null });
});
test('liveSpeed', () => {
  const p = { ts: 1000, idTask: 7, nDecoded: 100, processing: true };
  assert.equal(liveSpeed(p, { ts: 7000, idTask: 7, nDecoded: 232, processing: true }), 22);
  assert.equal(liveSpeed(p, { ts: 7000, idTask: 8, nDecoded: 232, processing: true }), null); // other task
  assert.equal(liveSpeed(p, { ts: 7000, idTask: 7, nDecoded: 50,  processing: true }), null); // went back
  assert.equal(liveSpeed(p, { ts: 1000, idTask: 7, nDecoded: 232, processing: true }), null); // no time
  assert.equal(liveSpeed(p, { ts: 7000, idTask: 7, nDecoded: 100, processing: true }), null); // nothing decoded
  assert.equal(liveSpeed(p, { ts: 500, idTask: 7, nDecoded: 232, processing: true }), null);  // clock went back
  assert.equal(liveSpeed(null, p), null);
  // overlapping reads milliseconds apart must not yield a spike (4 tokens / 10 ms = 400 tok/s)
  assert.equal(liveSpeed(p, { ts: 1010, idTask: 7, nDecoded: 104, processing: true }), null);
  assert.equal(liveSpeed(p, { ts: 1999, idTask: 7, nDecoded: 120, processing: true }), null);
  assert.equal(liveSpeed(p, { ts: 2000, idTask: 7, nDecoded: 120, processing: true }), 20); // 1 s is enough
});
const SLOT = { id: 0, n_ctx: 131072, is_processing: true, id_task: 7, n_prompt_tokens: 80000, n_prompt_tokens_cache: 75000,
               next_token: [{ n_decoded: 500, n_remain: 100, has_next_token: true }] };
test('slot helpers', () => {
  assert.deepEqual(slotSample(SLOT, 5), { ts: 5, idTask: 7, nDecoded: 500, processing: true });
  assert.deepEqual(contextFill(SLOT), { used: 80000, total: 131072 });
  assert.equal(activity(SLOT), 'generating');
  assert.equal(activity({ ...SLOT, next_token: [{ n_decoded: 0 }] }), 'reading');
  assert.equal(activity({ ...SLOT, is_processing: false }), 'idle');
  assert.deepEqual(contextFill({ id: 0, n_ctx: 8192, is_processing: false }), { used: 0, total: 8192 });
});
test('mapModelRow', () => {
  const props  = { model_alias: 'model-a', model_ftype: 'Q8_0', default_generation_settings: { n_ctx: 131072 } };
  const models = { data: [{ id: 'model-a', meta: { n_params: 27_000_000_000, n_ctx: 131072, ftype: 'Q8_0' } }] };
  assert.deepEqual(mapModelRow(props, models, 4096),
    { name: 'model-a', parameterSize: '27.0B', quantization: 'Q8_0', contextLength: 131072, sizeVram: 4096 });
  assert.deepEqual(mapModelRow({}, {}, 0),
    { name: '', parameterSize: '', quantization: '', contextLength: 0, sizeVram: 0 });
});
test('launchParams', () => {
  const cmd = ['-hf', 'org/model-a:Q8_0', '--alias', 'model-a', '-c', '131072', '-np', '1', '-t', '8', '-ub', '512', '-b', '2048',
               '-ctk', 'q8_0', '-ctv', 'q8_0', '--spec-type', 'draft-mtp', '--spec-draft-n-max', '3',
               '--reasoning-budget', '2048', '-sm', 'tensor', '--metrics', '--some-future-flag', 'x'];
  assert.deepEqual(launchParams(cmd), [
    { label: 'split', value: 'tensor' }, { label: 'MTP', value: '×3' }, { label: 'slots', value: '1' },
    { label: 'threads', value: '8' }, { label: 'KV', value: 'q8_0' }, { label: 'batch', value: '2048 / 512' },
    { label: 'reasoning', value: '2048' },
  ]);
  assert.deepEqual(launchParams(['-c', '8192']), []);
  assert.deepEqual(launchParams(undefined), []);
  assert.deepEqual(launchParams(['-ctk', 'q8_0', '-ctv', 'q4_0']), [{ label: 'KV', value: 'q8_0 / q4_0' }]);
  assert.deepEqual(launchParams(['-b', '4096']), [{ label: 'batch', value: '4096' }]);
});
test('launchParams: long aliases, MTP without length, other spec types, none', () => {
  assert.deepEqual(launchParams(['--split-mode', 'row', '--parallel', '2', '--threads', '8',
    '--batch-size', '512', '--ubatch-size', '256', '--cache-type-k', 'f16', '--cache-type-v', 'f16', '--spec-type', 'mtp']), [
    { label: 'split', value: 'row' }, { label: 'MTP', value: 'on' }, { label: 'slots', value: '2' },
    { label: 'threads', value: '8' }, { label: 'KV', value: 'f16' }, { label: 'batch', value: '512 / 256' },
  ]);
  assert.deepEqual(launchParams(['--spec-type', 'ngram', '--spec-draft-n-max', '3']), [{ label: 'spec', value: 'ngram ×3' }]);
  assert.deepEqual(launchParams(['--spec-type', 'ngram']), [{ label: 'spec', value: 'ngram' }]);
  assert.deepEqual(launchParams(['--spec-type', 'none', '--spec-draft-n-max', '3']), []);
  assert.deepEqual(launchParams(['-t']), []); // flag without value
});

test('overallActivity: generating beats reading beats idle; null without slots', () => {
  const gen = { is_processing: true, next_token: [{ n_decoded: 5 }] };
  const read = { is_processing: true, next_token: [{ n_decoded: 0 }] };
  const idle = { is_processing: false };
  assert.equal(overallActivity([idle, read, gen]), 'generating');
  assert.equal(overallActivity([idle, read]), 'reading');
  assert.equal(overallActivity([idle]), 'idle');
  assert.equal(overallActivity([]), null);
  assert.equal(overallActivity(undefined), null);
});
test('countersWentBackwards', () => {
  const a = { tokens_predicted_total: 100, tokens_predicted_seconds_total: 10 };
  assert.equal(countersWentBackwards(a, { tokens_predicted_total: 120, tokens_predicted_seconds_total: 12 }), false);
  assert.equal(countersWentBackwards(a, a), false);
  assert.equal(countersWentBackwards(a, { tokens_predicted_total: 5, tokens_predicted_seconds_total: 1 }), true);
  assert.equal(countersWentBackwards(null, a), false);
  assert.equal(countersWentBackwards(a, {}), false);
});
test('pickSpeed: live sum, then last, then lifetime, then null', () => {
  assert.deepEqual(pickSpeed([10.5, null, 20], { speed: 5 }, { speed: 1 }), { value: 30.5, window: 'live' });
  assert.deepEqual(pickSpeed([null], { speed: 5 }, { speed: 1 }), { value: 5, window: 'last' });
  assert.deepEqual(pickSpeed([], { speed: null }, { speed: 1 }), { value: 1, window: 'lifetime' });
  assert.deepEqual(pickSpeed([], null, { speed: 2 }), { value: 2, window: 'lifetime' });
  assert.equal(pickSpeed([], null, { speed: null }), null);
  assert.equal(pickSpeed([], null, null), null);
});
test('pickMtp: last, then lifetime, then null', () => {
  assert.deepEqual(pickMtp({ mtp: 60 }, { mtp: 50 }), { pct: 60, window: 'last' });
  assert.deepEqual(pickMtp({ mtp: null }, { mtp: 50 }), { pct: 50, window: 'lifetime' });
  assert.deepEqual(pickMtp(null, { mtp: 0 }), { pct: 0, window: 'lifetime' });
  assert.equal(pickMtp(null, { mtp: null }), null);
});

const gen = (n, task = 1) => ({ id: 0, id_task: task, is_processing: true, next_token: [{ n_decoded: n }] });
const met = (t, s, d = 0, a = 0) => ({
  tokens_predicted_total: t, tokens_predicted_seconds_total: s,
  spec_decode_num_draft_tokens_total: d, spec_decode_num_accepted_tokens_total: a,
});
test('advance: first poll has no live speed or window, only lifetime', () => {
  const r = advance(initialState(), { slots: [gen(10)], metrics: met(100, 10), now: 1000 });
  assert.deepEqual(r.lives, [null]);
  assert.equal(r.lastWindow, null);
  assert.equal(r.lifetime.speed, 10);
  assert.equal(r.state.slots.size, 1);
});
test('advance: second poll gives live speed and a window', () => {
  const s1 = advance(initialState(), { slots: [gen(10)], metrics: met(100, 10), now: 1000 }).state;
  const r = advance(s1, { slots: [gen(40)], metrics: met(200, 15, 10, 5), now: 2000 });
  assert.deepEqual(r.lives, [30]);
  assert.equal(r.lastWindow.speed, 20);
  assert.equal(r.lastWindow.mtp, 50);
});
test('advance: last window survives polls without new tokens', () => {
  let r = advance(initialState(), { slots: [], metrics: met(100, 10), now: 1 });
  r = advance(r.state, { slots: [], metrics: met(200, 15), now: 2 });
  r = advance(r.state, { slots: [], metrics: met(200, 15), now: 3 });
  assert.equal(r.lastWindow.speed, 20);
});
test('advance: counters backwards drops slots, window and live speed, no negatives', () => {
  let r = advance(initialState(), { slots: [gen(10)], metrics: met(100, 10), now: 1000 });
  r = advance(r.state, { slots: [gen(40)], metrics: met(200, 15), now: 2000 });
  const back = advance(r.state, { slots: [gen(50)], metrics: met(5, 1), now: 3000 });
  assert.deepEqual(back.lives, [null]);
  assert.equal(back.lastWindow, null);
  assert.equal(back.state.slots.size, 0);
  assert.equal(back.state.lastWindow, null);
  assert.equal(back.state.metrics.tokens_predicted_total, 5);
  assert.equal(back.lifetime.speed, 5);
});
test('advance: metrics failed keeps old metrics/window in state, reports none', () => {
  let r = advance(initialState(), { slots: [], metrics: met(100, 10), now: 1 });
  r = advance(r.state, { slots: [], metrics: met(200, 15), now: 2 });
  const f = advance(r.state, { slots: [gen(5)], metrics: null, now: 3 });
  assert.equal(f.lastWindow, null);
  assert.equal(f.lifetime, null);
  assert.equal(f.state.metrics.tokens_predicted_total, 200);
  assert.equal(f.state.lastWindow.speed, 20);
  assert.equal(f.state.slots.size, 1);
});
test('advance: slots failed clears slot samples', () => {
  const s1 = advance(initialState(), { slots: [gen(10)], metrics: null, now: 1 }).state;
  const r = advance(s1, { slots: null, metrics: null, now: 2 });
  assert.deepEqual(r.lives, []);
  assert.equal(r.state.slots.size, 0);
});
test('modelPayloadsOk', () => {
  assert.equal(modelPayloadsOk({}, { data: [] }), true);
  assert.equal(modelPayloadsOk(null, { data: [] }), false);
  assert.equal(modelPayloadsOk([], { data: [] }), false);
  assert.equal(modelPayloadsOk({}, {}), false);
  assert.equal(modelPayloadsOk({}, null), false);
});

test('cacheOf: cached share of all prompt tokens', () => {
  assert.equal(cacheOf(11_700_900, 528_782), 96);
  assert.equal(cacheOf(0, 100), 0);
  assert.equal(cacheOf(100, 0), 100);
  assert.equal(cacheOf(0, 0), null);           // nothing processed
  assert.equal(cacheOf(-5, 10), null);         // counter reset mid-window
  assert.equal(cacheOf(undefined, 10), null);  // older build without the counter
});
test('requestWindow: cache from counter deltas', () => {
  const a = { tokens_predicted_total: 10, tokens_predicted_seconds_total: 1, prompt_tokens_total: 1000, prompt_tokens_cached_total: 5000 };
  const b = { tokens_predicted_total: 20, tokens_predicted_seconds_total: 2, prompt_tokens_total: 1100, prompt_tokens_cached_total: 5900 };
  assert.equal(requestWindow(a, b).cache, 90);
});
test('liveCache: busy slots only, summed', () => {
  assert.deepEqual(liveCache([SLOT]), { pct: 94, cached: 75000, total: 79500 }); // 80000 - 500 decoded
  assert.deepEqual(liveCache([SLOT, { ...SLOT, id: 1, n_prompt_tokens: 20000, n_prompt_tokens_cache: 0 }]),
    { pct: 76, cached: 75000, total: 99000 });
  assert.equal(liveCache([{ ...SLOT, is_processing: false }]), null);
  assert.equal(liveCache([{ ...SLOT, n_prompt_tokens: 0 }]), null);
  assert.equal(liveCache([{ ...SLOT, n_prompt_tokens_cache: undefined }]), null);
  assert.equal(liveCache(null), null);
});
test('pickCache: live, then last, then lifetime, then null', () => {
  assert.deepEqual(pickCache({ pct: 96, cached: 96, total: 100 }, { cache: 50 }, { cache: 40 }),
    { pct: 96, window: 'live', cached: 96, total: 100 });
  assert.deepEqual(pickCache(null, { cache: 50 }, { cache: 40 }), { pct: 50, window: 'last' });
  assert.deepEqual(pickCache(null, { cache: null }, { cache: 0 }), { pct: 0, window: 'lifetime' });
  assert.equal(pickCache(null, null, { cache: null }), null);
});

test('launchParams: --cache-ram after KV, with its own tooltip', () => {
  const r = launchParams(['-ctk', 'q8_0', '-ctv', 'q8_0', '-b', '4096', '--cache-ram', '32768']);
  assert.deepEqual(r.map(p => p.label), ['KV', 'cache', 'batch']);
  assert.equal(r[1].value, '32 GiB');
  assert.match(r[1].title, /not report/);
  assert.equal(launchParams(['-cram', '-1'])[0].value, 'no limit');
  assert.equal(launchParams(['--cache-ram=0'])[0].value, 'off');
  assert.deepEqual(launchParams(['-c', '8192']), []); // default 8 GiB not shown, as other absent flags
});
test('formatCacheRam', () => {
  assert.equal(formatCacheRam('32768'), '32 GiB');
  assert.equal(formatCacheRam('12288'), '12 GiB');
  assert.equal(formatCacheRam('1536'), '1.5 GiB');
  assert.equal(formatCacheRam('512'), '512 MiB');
  assert.equal(formatCacheRam('-1'), 'no limit');
  assert.equal(formatCacheRam('0'), 'off');
  assert.equal(formatCacheRam('abc'), 'abc');
});

test('prefill: tok/s of prompt reading, window then lifetime', () => {
  assert.equal(lifetimeStats({ prompt_tokens_total: 528782, prompt_seconds_total: 1793.14 }).prefill, 294.9);
  const a = { tokens_predicted_total: 10, tokens_predicted_seconds_total: 1, prompt_tokens_total: 1000, prompt_seconds_total: 4 };
  const b = { tokens_predicted_total: 20, tokens_predicted_seconds_total: 2, prompt_tokens_total: 1600, prompt_seconds_total: 6 };
  assert.equal(requestWindow(a, b).prefill, 300);
  assert.deepEqual(pickPrefill({ prefill: 300 }, { prefill: 250 }), { value: 300, window: 'last' });
  assert.deepEqual(pickPrefill({ prefill: null }, { prefill: 250 }), { value: 250, window: 'lifetime' });
  assert.equal(pickPrefill(null, null), null);
});
test('contextPeak: n_tokens_max against the largest slot context', () => {
  assert.deepEqual(contextPeak({ n_tokens_max: 179366 }, [{ n_ctx: 200192 }]), { tokens: 179366, total: 200192 });
  assert.deepEqual(contextPeak({ n_tokens_max: 10 }, [{ n_ctx: 100 }, { n_ctx: 200 }]), { tokens: 10, total: 200 });
  assert.equal(contextPeak({ n_tokens_max: 0 }, [{ n_ctx: 100 }]), null);
  assert.equal(contextPeak(null, [{ n_ctx: 100 }]), null);
  assert.equal(contextPeak({ n_tokens_max: 10 }, null), null);
});

test('n_prompt_tokens counts generated tokens: live sample from b12359', () => {
  const slot = { id: 0, n_ctx: 200192, is_processing: true, id_task: 80644, n_prompt_tokens: 56007,
                 n_prompt_tokens_cache: 45920, n_prompt_tokens_processed: 6275, next_token: [{ n_decoded: 3808 }] };
  assert.equal(contextFill(slot).used, 56007);
  assert.deepEqual(liveCache([slot]), { pct: 88, cached: 45920, total: 52199 });
});
