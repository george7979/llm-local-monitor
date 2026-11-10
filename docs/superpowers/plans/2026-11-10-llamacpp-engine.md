# llama.cpp Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The dashboard shows whichever engine app (Ollama or llama.cpp) is running, lets the owner switch between them, and shows speed, MTP acceptance, context fill and launch parameters for llama.cpp.

**Architecture:** All decisions live in two import-free pure modules (`src/lib/engine.js`, `src/lib/llamacppParse.js`) covered by `node:test`. Thin collectors fetch over SSH/HTTP and call them; `routes.js` assembles `/api/status` in the new shape; the vanilla-JS frontend renders by `engine.active`.

**Tech Stack:** Node 20 ESM, Express 5, undici, `node:test`, vanilla HTML/CSS/JS. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-10-llamacpp-engine-design.md` — read it first; this plan does not repeat its tables.

## Global Constraints

- `LLAMACPP_APP_NAME` unset → behaviour identical to v1.5.1 from the user's side (no switch, no new cards content, `POST /api/switch-engine` → 404). API field renames still apply.
- Public repo: no host IPs, model names or aliases from the owner's server in code, docs, fixtures or defaults. Fixtures use `model-a`, `app-a`, round numbers.
- Engine matching on GPU processes is by app name equality — never by binary name, never by substring.
- No write to TrueNAS other than `app.stop`, `app.start` and the existing upgrade calls. `app.config` and `app.query` are read-only.
- Do not modify `src/lib/cache.js` or `entrypoint.sh`.
- Collectors go through `cached(key, ttl, fn)`; actions are never cached.
- Renamed routes and fields get no alias.
- **Do not stop, start, restart or switch an engine on the live server during development or verification without the owner's explicit "start"** — the engine is in daily use and a model reload is slow. Read-only GETs are fine.

## Review Focus

1. `/slots` or `/metrics` missing or erroring (server started without `--metrics`) → speed and MTP show `—`, context bar absent, model row and app card still render.
2. Metrics counters going backwards (engine restarted between polls) → no negative speed or percent; fall back to lifetime values of the new counters.
3. Slot sample pair that is not comparable (different `id_task`, `n_decoded` lower than before, zero elapsed time) → no live speed from that pair.
4. Two switch requests at once (double click, two browsers) → second gets 409; the first completes untouched.
5. `LLAMACPP_APP_NAME` set but no such app in TrueNAS → treated as feature off for display (no switch), with one line in the SERVER card: "llama.cpp app '<name>' not found".

---

### Task 1: Engine selection logic and config

**Files:**
- Create: `src/lib/engine.js`, `test/engine.test.js`
- Modify: `src/config.js`, `.env.example`, `src/actions/upgradeApps.js` (move `selectPending` out), `test/upgradeApps.test.js`

**Interfaces — Produces:**
- `cfg.llamacppAppName: string|null` (from `LLAMACPP_APP_NAME`), `cfg.llamacppBaseUrl: string` (default `` `http://${LLM_HOST}:8080` ``).
- `pickEngine(apps, procs, names) → { active: 'ollama'|'llamacpp'|null, conflict: boolean }`
  - `apps`: `{ ollama: {state}|null, llamacpp: {state}|null }` — `null` = app not configured or not found
  - `procs`: array of `{ container }` (GPU process list rows); `names`: `{ ollama, llamacpp }` app names
- `gpuEngine(procsOnGpu, names) → 'ollama'|'llamacpp'|null` — llama.cpp wins if both present.
- `selectPending(apps, skipName = null) → { charts: string[], images: string[], skipped: boolean }` — `skipped` is true when `skipName` had an update pending. Re-exported from `upgradeApps.js` so the existing test import keeps working.

- [ ] **Step 1: Write failing tests** in `test/engine.test.js`:

```js
const N = { ollama: 'ollama', llamacpp: 'llama-cpp' };
const S = s => ({ state: s });
test('one engine not stopped is active', () => {
  assert.deepEqual(pickEngine({ ollama: S('STOPPED'), llamacpp: S('RUNNING') }, [], N), { active: 'llamacpp', conflict: false });
  assert.deepEqual(pickEngine({ ollama: S('RUNNING'), llamacpp: S('STOPPED') }, [], N), { active: 'ollama', conflict: false });
});
test('deploying and crashed count as selected', () => {
  assert.equal(pickEngine({ ollama: S('STOPPED'), llamacpp: S('DEPLOYING') }, [], N).active, 'llamacpp');
  assert.equal(pickEngine({ ollama: S('CRASHED'), llamacpp: S('STOPPED') }, [], N).active, 'ollama');
});
test('both stopped → none', () => {
  assert.deepEqual(pickEngine({ ollama: S('STOPPED'), llamacpp: S('STOPPED') }, [], N), { active: null, conflict: false });
});
test('conflict: GPU holder wins, tie → llamacpp', () => {
  const both = { ollama: S('RUNNING'), llamacpp: S('RUNNING') };
  assert.deepEqual(pickEngine(both, [{ container: 'ollama' }], N), { active: 'ollama', conflict: true });
  assert.deepEqual(pickEngine(both, [], N), { active: 'llamacpp', conflict: true });
  assert.deepEqual(pickEngine(both, [{ container: 'ollama' }, { container: 'llama-cpp' }], N), { active: 'llamacpp', conflict: true });
});
test('llamacpp not configured → ollama rules alone', () => {
  assert.deepEqual(pickEngine({ ollama: S('RUNNING'), llamacpp: null }, [], N), { active: 'ollama', conflict: false });
  assert.deepEqual(pickEngine({ ollama: S('STOPPED'), llamacpp: null }, [], N), { active: null, conflict: false });
});
test('gpuEngine matches app name exactly', () => {
  assert.equal(gpuEngine([{ container: 'llama-cpp', binary: '/app/llama-server' }], N), 'llamacpp');
  assert.equal(gpuEngine([{ container: 'ollama', binary: '/usr/lib/ollama/llama-server' }], N), 'ollama');
  assert.equal(gpuEngine([{ container: 'app-a', binary: '/usr/bin/ollama' }], N), null);
  assert.equal(gpuEngine([{ container: null }], N), null);
  assert.equal(gpuEngine([{ container: 'ollama' }], { ollama: 'ollama', llamacpp: 'llama' }), 'ollama'); // no substring match
});
test('selectPending skips the inactive engine', () => {
  const apps = [
    { name: 'ollama', upgrade_available: true,  image_updates_available: false },
    { name: 'app-a',  upgrade_available: false, image_updates_available: true  },
  ];
  assert.deepEqual(selectPending(apps, 'ollama'), { charts: [], images: ['app-a'], skipped: true });
  assert.deepEqual(selectPending(apps, 'app-b'),  { charts: ['ollama'], images: ['app-a'], skipped: false });
});
```

  Existing `test/upgradeApps.test.js` assertions use `deepEqual` on `{charts, images}` — add `skipped: false` to each expected object.

- [ ] **Step 2:** `npm test` → new tests FAIL (module not found).
- [ ] **Step 3:** Implement `src/lib/engine.js` (no imports). Before relying on `p.container`, read `src/collectors/gpuProcs.js` and confirm that field carries the TrueNAS app name; if it carries a raw container name instead, expose the app name there and use that field in `gpuEngine`/`pickEngine` (adjust the tests' key accordingly).
- [ ] **Step 4:** Add the two config entries and an `.env.example` block ("llama.cpp (optional)"; note `--metrics` is needed for speed/MTP).
- [ ] **Step 5:** `npm test` → all PASS.
- [ ] **Step 6:** Commit `feat: engine selection logic and llama.cpp config`.

---

### Task 2: llama.cpp payload parsing

**Files:**
- Create: `src/lib/llamacppParse.js`, `test/llamacppParse.test.js`

**Interfaces — Produces** (all pure, no imports; payload field paths are in the spec, section "llama-server payloads"):
- `parseMetrics(text) → Record<string, number>` — keys without the `llamacpp:` prefix; comment lines and labelled series (`name{…}`) skipped.
- `formatParams(n) → string` — `26895998464 → '26.9B'`, `7_600_000_000 → '7.6B'`, `350_000_000 → '350M'`, falsy → `''`.
- `mapModelRow(props, models, vramBytes) → { name, parameterSize, quantization, contextLength, sizeVram }`
- `slotSample(slot, ts) → { ts, idTask, nDecoded, processing }`
- `liveSpeed(prev, cur) → number|null` — tok/s, one decimal.
- `activity(slot) → 'generating'|'reading'|'idle'` — reading = processing with `n_decoded` 0.
- `requestWindow(prevM, curM) → { speed: number|null, mtp: number|null } | null` — `null` unless `tokens_predicted_total` grew.
- `lifetimeStats(m) → { speed: number|null, mtp: number|null }`
- `contextFill(slot) → { used, total, cached }` — used = `n_prompt_tokens` + `n_decoded`.
- `launchParams(command) → Array<{ label, value }>` — fixed order: split, MTP, slots, threads, KV, batch, reasoning.

- [ ] **Step 1: Write failing tests:**

```js
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
test('lifetimeStats', () => {
  assert.deepEqual(lifetimeStats(parseMetrics(METRICS)), { speed: 20, mtp: 60 });
  assert.deepEqual(lifetimeStats({ tokens_predicted_total: 10, tokens_predicted_seconds_total: 2 }), { speed: 5, mtp: null });
  assert.deepEqual(lifetimeStats({ spec_decode_num_draft_tokens_total: 0 }), { speed: null, mtp: null });
});
test('requestWindow', () => {
  const a = { tokens_predicted_total: 2000, tokens_predicted_seconds_total: 100, spec_decode_num_draft_tokens_total: 500, spec_decode_num_accepted_tokens_total: 300 };
  const b = { tokens_predicted_total: 2300, tokens_predicted_seconds_total: 110, spec_decode_num_draft_tokens_total: 700, spec_decode_num_accepted_tokens_total: 350 };
  assert.deepEqual(requestWindow(a, b), { speed: 30, mtp: 25 });
  assert.equal(requestWindow(a, a), null);          // nothing finished
  assert.equal(requestWindow(b, a), null);          // counters went backwards
  assert.equal(requestWindow(null, b), null);
});
test('liveSpeed', () => {
  const p = { ts: 1000, idTask: 7, nDecoded: 100, processing: true };
  assert.equal(liveSpeed(p, { ts: 7000, idTask: 7, nDecoded: 232, processing: true }), 22);
  assert.equal(liveSpeed(p, { ts: 7000, idTask: 8, nDecoded: 232, processing: true }), null); // other task
  assert.equal(liveSpeed(p, { ts: 7000, idTask: 7, nDecoded: 50,  processing: true }), null); // went back
  assert.equal(liveSpeed(p, { ts: 1000, idTask: 7, nDecoded: 232, processing: true }), null); // no time
  assert.equal(liveSpeed(p, { ts: 7000, idTask: 7, nDecoded: 100, processing: true }), null); // nothing decoded
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
```

- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Implement. Rounding: speed to one decimal, MTP to whole percent. `MTP` param appears only when `--spec-type` contains `mtp`; value is `×<--spec-draft-n-max>` or `on` when the length flag is absent. Long-form aliases to accept: `--split-mode`, `--parallel`, `--threads`, `--batch-size`, `--ubatch-size`, `--cache-type-k`, `--cache-type-v`.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `feat: llama.cpp payload parsing`.

---

### Task 3: Collectors

**Files:**
- Create: `src/collectors/engineApps.js`, `src/collectors/llamacpp.js`
- Rename: `src/collectors/ollamaApp.js` → `src/collectors/engineApp.js`

**Interfaces — Consumes:** everything from Tasks 1–2, `cfg.llamacppAppName`, `cfg.llamacppBaseUrl`.

**Interfaces — Produces:**
- `getApps() → Array<app>` — one `midclt call app.query '[]'` with a `select` covering `name, state, version, human_version, metadata, upgrade_available, image_updates_available, active_workloads`; cached 2 s under one key. Every other consumer of app state reads from here (no second `app.query` per poll).
- `getEngineState(procs) → { active, conflict, notFound: string|null, apps: { ollama: {state, upgradeAvailable}|null, llamacpp: {…}|null }, updatesWaiting: boolean }` — `notFound` is the configured llama.cpp app name when TrueNAS has no such app (then `apps.llamacpp` is `null`). `updatesWaiting` is the **active** engine app's own flag (`upgrade_available || image_updates_available`); `false` when no engine is active.
- `getEngineAppStats(appName) → same object as today's `getOllamaAppStats()`` — app taken from `getApps()`; cache key and the previous-CPU sample are per app name. `upgradeAvailable` stays the app's own flag.
- `getLaunchInfo(appName) → { params: Array<{label,value}>, command: string }` — `midclt call app.config <name>`, first service's `command`; cached 60 s; `command` is the list joined by spaces.
- `getLlamacppStatus(vramBytes) → { models: [row] | [], loading: boolean, activity: 'generating'|'reading'|'idle'|null, speed: { value: number, window: 'live'|'last'|'lifetime' }|null, mtp: { pct: number, window: 'last'|'lifetime' }|null, slots: Array<{used,total,cached}> }`

- [ ] **Step 1:** `engineApps.js` and the `engineApp.js` rename. Behaviour of the stats collector for Ollama must not change — only where the app object comes from.
- [ ] **Step 2:** `llamacpp.js`. Four GETs with the collectors' 8 s undici timeouts, each independently tolerant:
  - `/props` or `/v1/models` failing → `{ models: [], loading: true, … nulls, slots: [] }` (app is up, server is not ready).
  - `/slots` failing → `activity: null`, `slots: []`, no live speed.
  - `/metrics` failing → no `last`/`lifetime` figures.
  - Module state between polls: previous slot sample per slot id, previous metrics, last `requestWindow` result. On counters going backwards, drop all three.
  - `speed` precedence: live (any slot) → last window → lifetime → `null`. With several slots generating, live speed is the sum.
  - `mtp` precedence: last window → lifetime → `null`.
- [ ] **Step 3:** `npm test` → still PASS (no new pure logic here; if you find yourself writing branching logic in a collector, move it to `llamacppParse.js` with a test).
- [ ] **Step 4:** Read-only check against the live server with llama.cpp vars in `.env`: a throwaway `node -e` that imports the collector and prints two results 6 s apart. Expected: a model row; `speed.window` is `live` while a request runs, otherwise `lifetime` or `last`.
- [ ] **Step 5:** Commit `feat: engine app and llama.cpp collectors`.

---

### Task 4: Actions and routes

**Files:**
- Create: `src/actions/switchEngine.js`
- Rename: `src/actions/restartOllama.js` → `src/actions/restartEngine.js`
- Modify: `src/actions/upgradeApps.js`, `src/routes.js`

**Interfaces — Produces (HTTP):**
- `GET /api/status` → `{ host, ipmi, uptime, engine, models, engineApp, gpu, gpuProcs, memory, network }`
  - `engine`: `getEngineState` result plus `switching: boolean` and `enabled: boolean` (llama.cpp configured **and** found).
  - `models`: Ollama's `{ models }` or `getLlamacppStatus` result, by `engine.active`; `null` when no engine is active.
  - `engineApp`: stats of the active engine's app, plus `launch` (`getLaunchInfo`) when llama.cpp is active; `null` when none.
  - `gpu.gpus[].engine`: `gpuEngine` result (replaces `hasOllama`). `/api/gpu` stays free of it.
  - llama.cpp VRAM for the model row: sum of the GPU process rows whose app is the llama.cpp app, in bytes.
- `GET /api/models-loaded`, `GET /api/engine-app` replace `/api/ollama`, `/api/ollama-app`.
- `POST /api/restart-engine` → restarts the active engine's app (stop, 3 s, start — as today); 409 when none active.
- `POST /api/switch-engine` `{ target }` → `{ ok: true, target, noop: boolean }`; 404 when `engine.enabled` is false; 400 unknown target; 409 switch in progress; 503 host down; 500 on SSH error.
- `POST /api/load-model`, `/api/unload-model`, `GET /api/models` → 409 `{ error: 'Not available with llama.cpp' }` when llama.cpp is active.
- `POST /api/upgrade-apps` → `{ ok, jobIds, apps, skipped: string|null }` — `skipped` names the inactive engine's app when it had an update pending.

- [ ] **Step 1:** `switchEngine(target)`: module-level in-progress flag exposed as `isSwitching()`; `try/finally` clears it. Sequence per spec "Switching". Use `midclt call -j app.stop <name>` so the stop is awaited. The stop of a slow container can outlast `sshExec`'s 10 s timeout — give `sshExec` an optional `timeoutMs` second argument (default unchanged) and use 120 s here.
- [ ] **Step 2:** `restartEngine(appName)`, `upgradeApps(skipName)` using `selectPending(apps, skipName)`.
- [ ] **Step 3:** Rewrite the `/status` handler and the routes. Collector order matters: `getGpuProcs` before `getEngineState` (conflict tie-break needs the process list); a failed process collector degrades to "no GPU holders", it does not fail the status call.
- [ ] **Step 4:** `npm test` → PASS. `npm run dev`, then:
  - `curl -s localhost:3788/api/status | jq '.engine, .models, .engineApp.launch, [.gpu.gpus[].engine]'` → active `llamacpp`, a model row, launch params, per-GPU engines.
  - `curl -s -X POST localhost:3788/api/switch-engine -H 'content-type: application/json' -d '{"target":"nope"}'` → 400.
  - With `LLAMACPP_APP_NAME` commented out: `engine.enabled` false, switch → 404, `/api/status` otherwise as with Ollama alone.
  - **Do not POST a valid switch or restart** — see Global Constraints.
- [ ] **Step 5:** Commit `feat: engine switch, restart and status API`.

---

### Task 5: Frontend

**Files:**
- Modify: `public/index.html`, `public/app.js`, `public/styles.css`

**Interfaces — Consumes:** the `/api/status` shape from Task 4.

Read the spec section "What each card shows" — it fixes the copy and the layout. Element ids and class names containing `ollama` that now serve both engines are renamed to `engine-…`.

- [ ] **Step 1: SERVER card.** Two-segment switch above the action list, rendered only when `engine.enabled`. Active segment highlighted; both disabled while `engine.switching` or host is down. Confirmation text per spec (symmetrical for both directions; when no engine is active: "Start <engine>?"). Warning lines: conflict ("Both engines are running — pick one") and not-found (Review Focus 5). Restart button label follows the active engine; disabled when none. Update button enabled from `engine.updatesWaiting`.
- [ ] **Step 2: App card.** Title by engine. Update badge from `engine.updatesWaiting` (the active engine's own flag). With llama.cpp: context bar(s) from `models.slots` (reuse `makeGpuBar`; label `82k / 200k`, cache figure beside it) and the launch-parameter lines from `engineApp.launch.params` joined with ` · `, wrapping naturally, `title` = full command. No engine: both apps listed as stopped.
- [ ] **Step 3: Model card.** By `engine.active`: Ollama → untouched code path. llama.cpp → columns `Model, Params, Quant, VRAM, Ctx`, no action column, **Models…** hidden, header right side shows speed and MTP:
  - `window: 'live'` → `▶ 21.7 tok/s`; `'last'`/`'lifetime'` → dimmed, no marker; `activity: 'reading'` with no live speed → `reading prompt…`; `null` → `—`.
  - MTP: ` · MTP 61%`, omitted entirely when `mtp` is `null`.
  - Tooltips: "live", "last finished request", "average since engine start".
  - `loading: true` → single dimmed row "Loading model…". No engine → "No engine running".
- [ ] **Step 4: GPU cards.** Badge from `g.engine`: `OLLAMA` / `LLAMA.CPP`, class renamed to `badge-engine`. Check the narrowest layout; if the badge row wraps, use `LLAMA`.
- [ ] **Step 5: Model actions.** `openModelsModal` and `doModelAction` are unreachable with llama.cpp active (button hidden); if a pending load is on screen when the engine changes, clear it.
- [ ] **Step 6: Verify in a browser** (`npm run dev`, local server only): llama.cpp view against the live server in light and dark theme, at desktop and phone width; then with `LLAMACPP_APP_NAME` unset — the page must look like v1.5.1. The Ollama-active view and the switch itself are verified with the owner (Task 6).
- [ ] **Step 7:** Commit `feat: engine-aware dashboard UI`.

---

### Task 6: Documentation and owner acceptance

**Files:**
- Modify: `docs/PRD.md`, `docs/PLAN.md`, `docs/TECH.md`, `README.md`, `CLAUDE.md`

- [ ] **Step 1:** Update the documents to describe the product as it now is (no chronicle): PRD purpose, FR1/FR2 and the "Update all apps" requirement; PLAN v1.6.0 milestone with acceptance below as open items; TECH architecture, endpoints, the llama-server payload notes and the "counters move only when a request finishes" finding; README configuration; CLAUDE.md architecture notes, curl examples, and a gotcha: "never switch or restart the engine during development without the owner's go-ahead".
- [ ] **Step 2:** Commit `docs: llama.cpp engine`.
- [ ] **Step 3: Owner acceptance on the live server** — ask for "start" first; each item is run by or with the owner:
  1. Switch llama.cpp → Ollama: llama.cpp app STOPPED, Ollama RUNNING, cards and badges follow, Load/Unload work.
  2. Switch back: model row returns after load; switch stays usable while the app is DEPLOYING.
  3. During a generation: live speed with ▶; after it: dimmed last-request speed and MTP %.
  4. With Ollama active and updates pending on it: "Update all apps" lights up and works as in v1.5.1. With llama.cpp active the button is grey (expected — see spec). If an update is pending on the stopped engine when the action runs, the result line names it as skipped and it stays STOPPED.
- [ ] **Step 4:** Record acceptance in `docs/PLAN.md`; release (version bump, merge, tag) follows the procedure in `CLAUDE.md` on the owner's decision.
