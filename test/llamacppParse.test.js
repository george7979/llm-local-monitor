import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMetrics, formatParams, mapModelRow, slotSample, liveSpeed, activity,
  requestWindow, lifetimeStats, contextFill, launchParams,
  overallActivity, countersWentBackwards, pickSpeed, pickMtp,
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
  assert.equal(formatParams(26895998464), '26.9B');
  assert.equal(formatParams(7_600_000_000), '7.6B');
  assert.equal(formatParams(350_000_000), '350M');
  assert.equal(formatParams(0), '');
  assert.equal(formatParams(undefined), '');
});
test('lifetimeStats', () => {
  assert.deepEqual(lifetimeStats(parseMetrics(METRICS)), { speed: 20, mtp: 60 });
  assert.deepEqual(lifetimeStats({ tokens_predicted_total: 10, tokens_predicted_seconds_total: 2 }), { speed: 5, mtp: null });
  assert.deepEqual(lifetimeStats({ spec_decode_num_draft_tokens_total: 0 }), { speed: null, mtp: null });
  assert.deepEqual(lifetimeStats(null), { speed: null, mtp: null });
});
test('requestWindow', () => {
  const a = { tokens_predicted_total: 2000, tokens_predicted_seconds_total: 100, spec_decode_num_draft_tokens_total: 500, spec_decode_num_accepted_tokens_total: 300 };
  const b = { tokens_predicted_total: 2300, tokens_predicted_seconds_total: 110, spec_decode_num_draft_tokens_total: 700, spec_decode_num_accepted_tokens_total: 350 };
  assert.deepEqual(requestWindow(a, b), { speed: 30, mtp: 25 });
  assert.equal(requestWindow(a, a), null);          // nothing finished
  assert.equal(requestWindow(b, a), null);          // counters went backwards
  assert.equal(requestWindow(null, b), null);
});
test('requestWindow: no bogus values from partial counters', () => {
  const a = { tokens_predicted_total: 10, tokens_predicted_seconds_total: 1 };
  // no MTP counters, seconds did not move
  assert.deepEqual(requestWindow(a, { tokens_predicted_total: 20, tokens_predicted_seconds_total: 1 }), { speed: null, mtp: null });
  // no MTP counters at all
  assert.deepEqual(requestWindow(a, { tokens_predicted_total: 20, tokens_predicted_seconds_total: 2 }), { speed: 10, mtp: null });
  // draft counter reset while tokens grew: mtp null, never negative
  const c = { ...a, spec_decode_num_draft_tokens_total: 100, spec_decode_num_accepted_tokens_total: 50 };
  const d = { tokens_predicted_total: 20, tokens_predicted_seconds_total: 2, spec_decode_num_draft_tokens_total: 10, spec_decode_num_accepted_tokens_total: 5 };
  assert.deepEqual(requestWindow(c, d), { speed: 10, mtp: null });
  // draft counter unchanged: no division by zero
  const e = { ...c, tokens_predicted_total: 20, tokens_predicted_seconds_total: 2 };
  assert.deepEqual(requestWindow(c, e), { speed: 10, mtp: null });
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
});
const SLOT = { id: 0, n_ctx: 200000, is_processing: true, id_task: 7, n_prompt_tokens: 80000, n_prompt_tokens_cache: 75000,
               next_token: [{ n_decoded: 500, n_remain: 100, has_next_token: true }] };
test('slot helpers', () => {
  assert.deepEqual(slotSample(SLOT, 5), { ts: 5, idTask: 7, nDecoded: 500, processing: true });
  assert.deepEqual(contextFill(SLOT), { used: 80500, total: 200000, cached: 75000 });
  assert.equal(activity(SLOT), 'generating');
  assert.equal(activity({ ...SLOT, next_token: [{ n_decoded: 0 }] }), 'reading');
  assert.equal(activity({ ...SLOT, is_processing: false }), 'idle');
  assert.deepEqual(contextFill({ id: 0, n_ctx: 8192, is_processing: false }), { used: 0, total: 8192, cached: 0 });
});
test('mapModelRow', () => {
  const props  = { model_alias: 'model-a', model_ftype: 'Q8_0', default_generation_settings: { n_ctx: 200000 } };
  const models = { data: [{ id: 'model-a', meta: { n_params: 26895998464, n_ctx: 200000, ftype: 'Q8_0' } }] };
  assert.deepEqual(mapModelRow(props, models, 4096),
    { name: 'model-a', parameterSize: '26.9B', quantization: 'Q8_0', contextLength: 200000, sizeVram: 4096 });
  assert.deepEqual(mapModelRow({}, {}, 0),
    { name: '', parameterSize: '', quantization: '', contextLength: 0, sizeVram: 0 });
});
test('launchParams', () => {
  const cmd = ['-hf', 'org/model-a:Q8_0', '--alias', 'model-a', '-c', '200000', '-np', '1', '-t', '12', '-ub', '2048', '-b', '4096',
               '-ctk', 'q8_0', '-ctv', 'q8_0', '--spec-type', 'draft-mtp', '--spec-draft-n-max', '4',
               '--reasoning-budget', '4096', '-sm', 'tensor', '--metrics', '--some-future-flag', 'x'];
  assert.deepEqual(launchParams(cmd), [
    { label: 'split', value: 'tensor' }, { label: 'MTP', value: '×4' }, { label: 'slots', value: '1' },
    { label: 'threads', value: '12' }, { label: 'KV', value: 'q8_0' }, { label: 'batch', value: '4096 / 2048' },
    { label: 'reasoning', value: '4096' },
  ]);
  assert.deepEqual(launchParams(['-c', '8192']), []);
  assert.deepEqual(launchParams(undefined), []);
  assert.deepEqual(launchParams(['-ctk', 'q8_0', '-ctv', 'q4_0']), [{ label: 'KV', value: 'q8_0 / q4_0' }]);
  assert.deepEqual(launchParams(['-b', '4096']), [{ label: 'batch', value: '4096' }]);
});
test('launchParams: long aliases, MTP without length, non-MTP spec', () => {
  assert.deepEqual(launchParams(['--split-mode', 'row', '--parallel', '2', '--threads', '8',
    '--batch-size', '512', '--ubatch-size', '256', '--cache-type-k', 'f16', '--cache-type-v', 'f16', '--spec-type', 'mtp']), [
    { label: 'split', value: 'row' }, { label: 'MTP', value: 'on' }, { label: 'slots', value: '2' },
    { label: 'threads', value: '8' }, { label: 'KV', value: 'f16' }, { label: 'batch', value: '512 / 256' },
  ]);
  assert.deepEqual(launchParams(['--spec-type', 'ngram', '--spec-draft-n-max', '4']), []);
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
