# Model Load / Unload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the dashboard unload a resident Ollama model and load any installed model, without introducing backend state.

**Architecture:** Two new backend actions post to Ollama's `/api/generate` (`keep_alive: 0` to evict, `keep_alive: -1` to load); a new collector exposes `/api/tags` as `GET /api/models`. The frontend never treats the HTTP response as the success signal — residency is read from the existing 5 s `/api/ps` poll, so timeouts, proxies and concurrent external clients need no handling.

**Tech Stack:** Node 20+ ESM, Express 5, undici, vanilla browser JS, `node:test` (built-in) for unit tests.

**Spec:** `docs/superpowers/specs/2026-08-16-model-load-unload-design.md`

## Global Constraints

- **No new npm dependencies.** `undici` and `express` are already present; tests use the built-in `node:test` runner.
- **Do NOT modify** `src/lib/cache.js` or `entrypoint.sh` (project `CLAUDE.md`).
- **Collectors are always cached** via `cached('key', 2000, fn)`; **actions are never cached** (project `CLAUDE.md`).
- **Env access only through `src/config.js`** — never read `process.env` elsewhere.
- **Branch:** `dev`. Never `main`.
- **Commits require explicit user consent** (workspace `CLAUDE.md`). Every "Commit" step below means: show the file list, ask, wait for a yes. Never run `git commit` or `git push` unprompted.
- **Exact values from the spec:**
  - cache key for the new collector: `ollama-models`, TTL `2_000` ms
  - env var: `MODEL_ACTION_TIMEOUT_SEC`, default `1800`, floor `30`
  - `localStorage` key: `pendingModelLoad`, shape `{ model, startedAt }`, expiry 15 min
  - ghost-row warning threshold: 10 min
  - load payload: `{ model, prompt: "", stream: false, keep_alive: -1 }`
  - unload payload: `{ model, stream: false, keep_alive: 0 }`

## Testing Approach — read this before Task 1

The project has **no test framework** and the spec prescribes manual verification. This plan
adds the built-in `node:test` runner (zero dependencies, no `package.json` additions beyond a
`test` script) and unit-tests **only the pure functions** — data mapping and validation.

HTTP calls to Ollama, SSH, and all browser code are verified manually, exactly as the spec
specifies. `public/app.js` is a classic script, not an ES module, so it cannot be imported by
a test runner; restructuring it into modules is out of scope for this change.

The glob in the `test` script is not cosmetic: on Node 24, `node --test test/` treats the
directory as an entry module and dies with `MODULE_NOT_FOUND` before running anything —
a failure that looks deceptively like a missing import in the code under test.

This is a deliberate narrowing of TDD to where it earns its keep in this codebase. If the
reviewer wants broader coverage, that is a separate change.

---

### Task 1: Available-models collector and `GET /api/models`

**Files:**
- Create: `src/collectors/ollamaModels.js`
- Create: `test/ollamaModels.test.js`
- Modify: `package.json` (add `test` script)
- Modify: `src/routes.js` (import + one route)

**Interfaces:**
- Consumes: `cached` from `src/lib/cache.js`, `cfg` from `src/config.js`
- Produces:
  - `mapTags(data) -> { models: [{ name, sizeBytes, parameterSize, quantization }] }` (pure, sorted by name)
  - `findModel(models, name) -> model | null` (pure)
  - `getAvailableModels() -> Promise<{ models: [...] }>` (cached)

- [ ] **Step 1: Write the failing test**

Create `test/ollamaModels.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapTags, findModel } from '../src/collectors/ollamaModels.js';

test('mapTags maps Ollama /api/tags fields and sorts by name', () => {
  const raw = {
    models: [
      { name: 'qwen3:32b', size: 20_000_000_000,
        details: { parameter_size: '32B', quantization_level: 'Q4_K_M' } },
      { name: 'gemma3:27b', size: 17_000_000_000,
        details: { parameter_size: '27B', quantization_level: 'Q4_0' } },
    ],
  };
  assert.deepEqual(mapTags(raw), {
    models: [
      { name: 'gemma3:27b', sizeBytes: 17_000_000_000, parameterSize: '27B', quantization: 'Q4_0' },
      { name: 'qwen3:32b',  sizeBytes: 20_000_000_000, parameterSize: '32B', quantization: 'Q4_K_M' },
    ],
  });
});

test('mapTags tolerates missing models array and missing details', () => {
  assert.deepEqual(mapTags({}), { models: [] });
  assert.deepEqual(mapTags({ models: [{ name: 'x' }] }), {
    models: [{ name: 'x', sizeBytes: 0, parameterSize: '', quantization: '' }],
  });
});

test('findModel matches exactly and rejects junk input', () => {
  const models = [{ name: 'qwen3:32b' }, { name: 'qwen3:32b-200k' }];
  assert.equal(findModel(models, 'qwen3:32b').name, 'qwen3:32b');
  assert.equal(findModel(models, 'qwen3'), null);
  assert.equal(findModel(models, ''), null);
  assert.equal(findModel(models, undefined), null);
  assert.equal(findModel(models, { name: 'qwen3:32b' }), null);
});
```

Add the runner to `package.json` scripts (keep `start` and `dev` unchanged):

```json
"test": "node --test test/*.test.js"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '.../src/collectors/ollamaModels.js'`

- [ ] **Step 3: Write minimal implementation**

Create `src/collectors/ollamaModels.js`:

```js
import { request, Agent } from 'undici';
import { cached } from '../lib/cache.js';
import { cfg } from '../config.js';

const agent = new Agent({ connect: { rejectUnauthorized: false } });

// Pure: shape Ollama's /api/tags payload into what the UI needs.
// `family` and `modified_at` are available but deliberately dropped —
// neither informs a load decision (see spec, Rejected Alternatives).
export function mapTags(data) {
  return {
    models: (data.models || [])
      .map(m => ({
        name: m.name,
        sizeBytes: m.size || 0,
        parameterSize: m.details?.parameter_size || '',
        quantization: m.details?.quantization_level || '',
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// Pure: exact-match lookup used to turn a typo into a clear 400
// instead of Ollama's bare 404.
export function findModel(models, name) {
  if (typeof name !== 'string' || !name.trim()) return null;
  return models.find(m => m.name === name) || null;
}

export function getAvailableModels() {
  return cached('ollama-models', 2_000, async () => {
    const { body, statusCode } = await request(`${cfg.ollamaBaseUrl}/api/tags`, {
      method: 'GET',
      headersTimeout: 8_000,
      bodyTimeout: 8_000,
      dispatcher: agent,
    });
    if (statusCode >= 400) {
      const text = await body.text();
      throw new Error(`Ollama API ${statusCode}: ${text}`);
    }
    return mapTags(await body.json());
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — 3 tests

- [ ] **Step 5: Add the route**

In `src/routes.js`, add the import next to the other collector imports:

```js
import { getAvailableModels } from './collectors/ollamaModels.js';
```

and the route next to `/ollama`:

```js
router.get('/models', async (_req, res) => {
  res.json(await safeCollect(getAvailableModels));
});
```

- [ ] **Step 6: Verify against the live server**

Run: `npm run dev`, then

```bash
curl -s localhost:3000/api/models | head -c 400
```

Expected: JSON with a `models` array, sorted by name, each entry carrying
`name`, `sizeBytes`, `parameterSize`, `quantization`.

- [ ] **Step 7: Commit (ask first)**

```bash
git add package.json test/ollamaModels.test.js src/collectors/ollamaModels.js src/routes.js
git commit -m "feat: expose installed Ollama models via GET /api/models"
```

---

### Task 2: Load and unload actions with validation

**Files:**
- Create: `src/lib/ollamaClient.js`
- Create: `src/actions/loadModel.js`
- Create: `src/actions/unloadModel.js`
- Modify: `src/config.js` (one new key)
- Modify: `src/routes.js` (two POST routes)
- Modify: `.env.example` (document the new var)

**Interfaces:**
- Consumes: `getAvailableModels`, `findModel` from Task 1; `cfg` from `src/config.js`
- Produces:
  - `ollamaGenerate(payload) -> Promise<string>` (raw response text; throws on status >= 400)
  - `loadModel(name) -> Promise<{ ok: true }>`
  - `unloadModel(name) -> Promise<{ ok: true }>`

- [ ] **Step 1: Add the timeout config**

In `src/config.js`, inside the exported `cfg` object, next to `pollIntervalSec`:

```js
  modelActionTimeoutSec: Math.max(30, parseInt(process.env.MODEL_ACTION_TIMEOUT_SEC, 10) || 1800),
```

Append to `.env.example`:

```
# Socket timeout for model load/unload requests to Ollama (seconds, min 30).
# CRITICAL: Ollama CANCELS a load when the client disconnects (verified
# 2026-08-16). Too low a value silently throws away minutes of work.
# Measured: 28 GB model = 303 s cold (ZFS pool) / 127 s warm (ARC).
# Default 1800 leaves headroom for the largest models on a cold cache.
# MODEL_ACTION_TIMEOUT_SEC=1800
```

- [ ] **Step 2: Write the Ollama action client**

Create `src/lib/ollamaClient.js`:

```js
import { request, Agent } from 'undici';
import { cfg } from '../config.js';

// Separate dispatcher from the collectors': collectors poll every 5 s with
// 8 s timeouts, model loads can run for minutes. Sharing one agent would
// force one of the two into the wrong timeout regime.
const actionAgent = new Agent({ connect: { rejectUnauthorized: false } });

export async function ollamaGenerate(payload) {
  const ms = cfg.modelActionTimeoutSec * 1000;
  // stream:false is required — with streaming on, headers return immediately
  // and the timeout would govern an idle gap rather than the operation.
  const { body, statusCode } = await request(`${cfg.ollamaBaseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stream: false, ...payload }),
    headersTimeout: ms,
    bodyTimeout: ms,
    dispatcher: actionAgent,
  });
  const text = await body.text();
  if (statusCode >= 400) throw new Error(`Ollama API ${statusCode}: ${text}`);
  return text;
}
```

- [ ] **Step 3: Write the two actions**

Create `src/actions/loadModel.js`:

```js
import { ollamaGenerate } from '../lib/ollamaClient.js';

// Empty prompt loads the weights into VRAM without generating tokens.
// keep_alive:-1 is passed explicitly rather than relying on the server
// default, so the request stays self-describing.
export async function loadModel(name) {
  await ollamaGenerate({ model: name, prompt: '', keep_alive: -1 });
  return { ok: true };
}
```

Create `src/actions/unloadModel.js`:

```js
import { ollamaGenerate } from '../lib/ollamaClient.js';

// keep_alive:0 evicts immediately, overriding the server-wide -1 for this
// call only. Ollama honours it once any in-flight generation finishes.
export async function unloadModel(name) {
  await ollamaGenerate({ model: name, keep_alive: 0 });
  return { ok: true };
}
```

- [ ] **Step 4: Add the routes**

In `src/routes.js`, extend the Task 1 import and add the action imports:

```js
import { getAvailableModels, findModel } from './collectors/ollamaModels.js';
import { loadModel } from './actions/loadModel.js';
import { unloadModel } from './actions/unloadModel.js';
```

Add below the existing POST routes:

```js
// Validate against the installed-model list so a typo yields a clear 400
// instead of Ollama's bare 404. Not an injection defence — the name travels
// as JSON to an HTTP API, never to a shell.
async function resolveModelName(req, res) {
  const list = await getAvailableModels();
  const found = findModel(list.models, req.body?.model);
  if (!found) {
    res.status(400).json({ error: `Unknown model: ${req.body?.model ?? ''}` });
    return null;
  }
  return found.name;
}

router.post('/load-model', async (req, res) => {
  try {
    const name = await resolveModelName(req, res);
    if (!name) return;
    res.json(await loadModel(name));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/unload-model', async (req, res) => {
  try {
    const name = await resolveModelName(req, res);
    if (!name) return;
    res.json(await unloadModel(name));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 5: Verify against the live server**

Run `npm run dev`, then, substituting a real model name from `/api/models`:

```bash
# rejected before reaching Ollama
curl -s -X POST localhost:3000/api/unload-model \
  -H 'Content-Type: application/json' -d '{"model":"nope"}'
# expect: {"error":"Unknown model: nope"}  with HTTP 400

# missing body field
curl -s -X POST localhost:3000/api/load-model \
  -H 'Content-Type: application/json' -d '{}'
# expect: {"error":"Unknown model: "}  with HTTP 400

# real unload — check /api/status afterwards, the model should be gone
curl -s -X POST localhost:3000/api/unload-model \
  -H 'Content-Type: application/json' -d '{"model":"<resident-model>"}'
# expect: {"ok":true}

# real load — this may take minutes; time it
time curl -s -X POST localhost:3000/api/load-model \
  -H 'Content-Type: application/json' -d '{"model":"<large-model>"}'
# expect: {"ok":true}, and the model present in /api/status afterwards
```

Record the measured load time — it goes into the spec in Task 6.

- [ ] **Step 6: Commit (ask first)**

```bash
git add src/lib/ollamaClient.js src/actions/loadModel.js src/actions/unloadModel.js \
        src/config.js src/routes.js .env.example
git commit -m "feat: add load-model and unload-model actions"
```

---

### Task 3: Unload button and ghost row in the LOADED MODELS card

**Files:**
- Modify: `public/index.html:90-93` (card header row + message line)
- Modify: `public/app.js:116-168` (`renderOllama`) and `public/app.js:35-51` (`pollAll`)
- Modify: `public/styles.css` (three small rules)

**Interfaces:**
- Consumes: `POST /api/unload-model` from Task 2; `el()`, `apiFetch()`, `gb()` from `public/app.js:1-21`
- Produces (used by Tasks 4 and 5):
  - `pendingLoad` module-level variable, `{ model, startedAt } | null`
  - `setPending(model)`, `clearPending()`, `readPending()`
  - `lastLoadedModels` — array of the latest `/api/ps` models
  - `doModelAction(kind, name)` where `kind` is `'load'` or `'unload'`

- [ ] **Step 1: Update the card markup**

In `public/index.html`, replace the `card-ollama` block:

```html
  <div class="card" id="card-ollama">
    <div class="card-label-row">
      <div class="card-label">LOADED MODELS</div>
      <button id="btn-models" class="btn-small" onclick="openModelsModal()">Models&hellip;</button>
    </div>
    <div id="ollama-content"><span class="dim-text">Loading...</span></div>
    <div class="action-msg" id="models-card-msg"></div>
  </div>
```

`card-label-row` already exists — `card-ollama-app` uses it (`index.html:80`).

- [ ] **Step 2: Add styles**

Append to `public/styles.css`:

```css
.btn-small {
  font-size: 12px;
  padding: 3px 10px;
}
tr.ghost-row td {
  opacity: 0.55;
  font-style: italic;
}
td.td-actions {
  text-align: right;
  white-space: nowrap;
}
```

- [ ] **Step 3: Add pending-load state and the action dispatcher**

In `public/app.js`, below the GPU modal state block (`app.js:11-13`):

```js
// ── Model state ──────────────────────────────────────────────────────
const PENDING_KEY = 'pendingModelLoad';
const PENDING_MAX_MS = 15 * 60 * 1000;   // drop a stale marker after 15 min
const PENDING_WARN_MS = 10 * 60 * 1000;  // 10 min: say it is taking unusually long

let pendingLoad = null;       // { model, startedAt } — cosmetic only
let lastLoadedModels = [];    // latest /api/ps snapshot, for the modal markers
let modelsModalOpen = false;  // declared here, used by Task 4's modal

function readPending() {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p?.model || !p?.startedAt) throw new Error('malformed');
    if (Date.now() - p.startedAt > PENDING_MAX_MS) throw new Error('stale');
    return p;
  } catch {
    localStorage.removeItem(PENDING_KEY);
    return null;
  }
}

function setPending(model) {
  pendingLoad = { model, startedAt: Date.now() };
  localStorage.setItem(PENDING_KEY, JSON.stringify(pendingLoad));
}

function clearPending() {
  pendingLoad = null;
  localStorage.removeItem(PENDING_KEY);
}

function ghostLabel(startedAt) {
  const s = Math.floor((Date.now() - startedAt) / 1000);
  const t = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  return (Date.now() - startedAt) >= PENDING_WARN_MS
    ? `loading ${t} — still waiting`
    : `loading… ${t}`;
}

pendingLoad = readPending();
```

Then the dispatcher, placed next to the existing `action()` function
(`app.js:662`) but kept separate from it — `action()` is name-keyed with
hardcoded message maps and takes no arguments:

```js
async function doModelAction(kind, name) {
  if (kind === 'unload' &&
      !confirm(`Unload ${name}?\nVRAM is freed immediately; reloading can take minutes.`)) {
    return;
  }

  const msgId = modelsModalOpen ? 'models-msg' : 'models-card-msg';
  const msg = document.getElementById(msgId);

  if (kind === 'load') setPending(name);
  if (modelsModalOpen) renderModelsModal();
  msg.textContent = kind === 'load' ? `Requested ${name}…` : `Unloading ${name}…`;

  try {
    await apiFetch(`/api/${kind}-model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name }),
    });
    msg.textContent = kind === 'load'
      ? 'Load requested — watching for it to appear.'
      : `Unloaded ${name}`;
  } catch (e) {
    // Any failure is a real failure: Ollama cancels an in-progress load when
    // the client disconnects, so a timeout means the work was thrown away.
    if (kind === 'load') clearPending();
    msg.textContent = /timeout/i.test(e.message)
      ? 'Load aborted — the connection timed out and Ollama cancelled it. Retry.'
      : 'Error: ' + e.message;
  }
  setTimeout(() => { msg.textContent = ''; }, 15000);
  pollAll();
}
```

- [ ] **Step 4: Capture the loaded-model snapshot in the poll loop**

In `pollAll` (`app.js:35-51`), directly after `renderOllama(data.ollama);`:

```js
    lastLoadedModels = data.ollama?.models || [];
    if (modelsModalOpen) renderModelsModal();
```

- [ ] **Step 5: Rewrite `renderOllama`**

Replace `public/app.js:116-168` entirely. The early returns must not swallow
the ghost row, so the pending check comes first:

```js
function renderOllama(data) {
  const wrap = document.getElementById('ollama-content');
  wrap.textContent = '';

  const models = data && !data.error ? (data.models || []) : null;

  // /api/ps is authoritative: the model showing up IS the success signal.
  if (models && pendingLoad && models.some(m => m.name === pendingLoad.model)) {
    clearPending();
  }

  if (!data) { wrap.appendChild(el('span', 'dim-text', 'Host unavailable')); return; }
  if (data.error) { wrap.appendChild(el('span', 'dim-text', 'Temporarily unavailable')); return; }
  if (!models.length && !pendingLoad) {
    wrap.appendChild(el('span', 'dim-text', 'No models loaded'));
    return;
  }

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  ['Model', 'Params', 'Quant', 'Processor', 'VRAM', 'Ctx', 'Expires', ''].forEach(h => {
    hr.appendChild(el('th', null, h));
  });
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');

  if (pendingLoad) {
    const tr = el('tr', 'ghost-row');
    tr.appendChild(el('td', 'td-model', pendingLoad.model));
    const tdMsg = el('td', 'dim-text', ghostLabel(pendingLoad.startedAt));
    tdMsg.colSpan = 7;
    tr.appendChild(tdMsg);
    tbody.appendChild(tr);
  }

  for (const m of models) {
    const tr = document.createElement('tr');
    const expires = m.expiresAt ? new Date(m.expiresAt).toLocaleTimeString() : '—';
    const vram    = m.sizeVram  ? gb(m.sizeVram) + ' GB' : '—';
    const ctx     = m.contextLength ? Math.round(m.contextLength / 1000) + 'k' : '—';

    const procCls = m.processor === '100% GPU' ? 'td-gpu'
      : m.processor?.includes('CPU') && m.processor?.includes('GPU') ? 'td-mix'
      : 'td-cpu';

    const cells = [
      ['td-model', m.name, m.name],
      ['td-mono',  m.parameterSize, null],
      ['td-mono',  m.quantization, null],
      [procCls,    m.processor, null],
      ['td-mono',  vram, null],
      ['td-mono',  ctx, null],
      ['td-mono',  expires, null],
    ];

    cells.forEach(([cls, val, title]) => {
      const td = document.createElement('td');
      td.className = cls;
      td.textContent = val;
      if (title) td.title = title;
      tr.appendChild(td);
    });

    const tdAct = el('td', 'td-actions');
    const btn = el('button', 'btn-small', 'Unload');
    btn.addEventListener('click', () => doModelAction('unload', m.name));
    tdAct.appendChild(btn);
    tr.appendChild(tdAct);

    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  wrap.appendChild(table);
}
```

- [ ] **Step 6: Verify in the browser**

Run `npm run dev`, open the dashboard.

1. The card shows an eighth column with an **Unload** button per row
2. Click Unload → confirm dialog → model disappears within one poll cycle
3. Cancel the dialog → nothing happens, no request in DevTools Network
4. With no models loaded and nothing pending → `No models loaded` as before

`openModelsModal` and `renderModelsModal` do not exist yet, so the
**Models…** button and the modal branch in `doModelAction` will throw until
Task 4. Unload works regardless — verify it now.

- [ ] **Step 7: Commit (ask first)**

```bash
git add public/index.html public/app.js public/styles.css
git commit -m "feat: per-model unload button and pending-load ghost row"
```

---

### Task 4: Model browser modal

**Files:**
- Modify: `public/index.html` (new modal block after the GPU modal, `index.html:103-114`)
- Modify: `public/app.js` (modal state, render, open/close, filter, refresh)
- Modify: `public/styles.css` (toolbar rule)

**Interfaces:**
- Consumes: `GET /api/models` (Task 1), `doModelAction` / `lastLoadedModels` / `pendingLoad` (Task 3)
- Produces: `openModelsModal()`, `closeModelsModal()`, `renderModelsModal()`, `refreshAvailableModels()`, `modelsModalOpen`

- [ ] **Step 1: Add the modal markup**

In `public/index.html`, directly after the closing `</div>` of `gpu-modal`
(`index.html:114`), reusing the same classes:

```html
<div class="modal-backdrop" id="models-modal" style="display:none">
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="models-modal-title">
    <div class="modal-head">
      <div>
        <div class="modal-title" id="models-modal-title">Available models</div>
        <div class="modal-sub" id="models-modal-sub"></div>
      </div>
      <button class="modal-close" id="models-modal-close" aria-label="Close">&#10005;</button>
    </div>
    <div class="models-tools">
      <input type="text" id="models-filter" placeholder="Filter by name…" autocomplete="off">
      <button id="models-refresh" class="btn-small" title="Reload the list from the server">&#8635;</button>
    </div>
    <div class="action-msg" id="models-msg"></div>
    <div id="models-modal-body"></div>
  </div>
</div>
```

- [ ] **Step 2: Add styles**

Append to `public/styles.css`:

```css
.models-tools {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}
.models-tools input {
  flex: 1;
  padding: 4px 8px;
}
tr.row-resident td.td-model::after {
  content: ' • in memory';
  opacity: 0.6;
  font-size: 11px;
}
```

- [ ] **Step 3: Add modal state and rendering**

In `public/app.js`, after the model state block from Task 3:

```js
let availableModels = [];
let modelsFilter = '';
// `modelsModalOpen` is already declared in the Task 3 state block — do not redeclare it.

async function refreshAvailableModels() {
  const msg = document.getElementById('models-msg');
  try {
    const data = await apiFetch('/api/models');
    if (data.error) throw new Error(data.error);
    availableModels = data.models || [];
    msg.textContent = '';
  } catch (e) {
    availableModels = [];
    msg.textContent = 'Could not load model list: ' + e.message;
  }
  if (modelsModalOpen) renderModelsModal();
}

function openModelsModal() {
  modelsModalOpen = true;
  renderModelsModal();
  document.getElementById('models-modal').style.display = 'flex';
  document.getElementById('models-filter').focus();
}

function closeModelsModal() {
  modelsModalOpen = false;
  document.getElementById('models-modal').style.display = 'none';
}

function renderModelsModal() {
  const sub = document.getElementById('models-modal-sub');
  const body = document.getElementById('models-modal-body');
  body.textContent = '';

  // Residency comes from the latest /api/ps snapshot, never from our own
  // actions — an external client can load or evict at any moment.
  const resident = new Set(lastLoadedModels.map(m => m.name));
  const q = modelsFilter.trim().toLowerCase();
  const rows = availableModels.filter(m => !q || m.name.toLowerCase().includes(q));

  sub.textContent = `${availableModels.length} installed · ${resident.size} in memory`;

  if (!availableModels.length) {
    body.appendChild(el('span', 'dim-text', 'No models found — press ↻ to retry'));
    return;
  }
  if (!rows.length) {
    body.appendChild(el('span', 'dim-text', 'No model matches the filter'));
    return;
  }

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  ['Model', 'Size', 'Params', 'Quant', ''].forEach(h => hr.appendChild(el('th', null, h)));
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const m of rows) {
    const isResident = resident.has(m.name);
    const isPending = pendingLoad?.model === m.name;
    const tr = el('tr', isResident ? 'row-resident' : null);

    [['td-model', m.name], ['td-mono', gb(m.sizeBytes) + ' GB'],
     ['td-mono', m.parameterSize], ['td-mono', m.quantization]]
      .forEach(([cls, val]) => tr.appendChild(el('td', cls, val)));

    const tdAct = el('td', 'td-actions');
    const btn = el('button', 'btn-small',
      isPending ? 'Loading…' : isResident ? 'Unload' : 'Load');
    btn.disabled = isPending;
    if (!isPending) {
      btn.addEventListener('click',
        () => doModelAction(isResident ? 'unload' : 'load', m.name));
    }
    tdAct.appendChild(btn);
    tr.appendChild(tdAct);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  body.appendChild(table);
}
```

- [ ] **Step 4: Wire up the controls**

Add next to the GPU modal listeners (`app.js:247-253`):

```js
document.getElementById('models-modal-close').addEventListener('click', closeModelsModal);
document.getElementById('models-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeModelsModal();
});
document.getElementById('models-refresh').addEventListener('click', refreshAvailableModels);
document.getElementById('models-filter').addEventListener('input', (e) => {
  modelsFilter = e.target.value;
  renderModelsModal();
});
```

Extend the existing Escape handler (`app.js:251-253`) so it closes whichever
modal is open:

```js
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (gpuModalBusId) closeGpuModal();
  if (modelsModalOpen) closeModelsModal();
});
```

- [ ] **Step 5: Fetch the list once at startup**

In the `/api/config` bootstrap (`app.js:54-72`), add `refreshAvailableModels();`
next to `pollAll();` — in **both** the success callback and the `.catch()`
fallback, so a failed config fetch does not leave the modal permanently empty.

- [ ] **Step 6: Verify in the browser**

1. **Models…** opens the modal; Escape, ✕ and backdrop click all close it
2. Resident models are marked *in memory* and offer **Unload**; the rest offer **Load**
3. Typing in the filter narrows the list; clearing it restores the full list
4. `ollama pull <something>` on the host → not in the list until **↻** is pressed
5. Load a model from an external client → within one poll cycle the markers flip
   in the open modal, and the catalog itself does not change
6. Stop Ollama and press ↻ → an error message inside the modal, no blank screen

- [ ] **Step 7: Commit (ask first)**

```bash
git add public/index.html public/app.js public/styles.css
git commit -m "feat: model browser modal with filter and manual refresh"
```

---

### Task 5: Load flow end-to-end, including reload persistence

**Files:**
- Modify: `public/app.js` (only if the verification below reveals gaps)

This task writes little code — Tasks 3 and 4 already contain the load path.
Its purpose is to verify the behaviour the spec cares most about, and to fix
whatever the verification breaks.

- [ ] **Step 1: Verify the happy path with a large model**

1. Open the modal, click **Load** on a model that is not resident
2. Immediately: the modal button reads *Loading…* and is disabled; the card
   shows a ghost row with a ticking counter
3. Close the modal → the ghost row is still visible in the card
4. Other cards (GPU, RAM, LAN) keep updating; the network histograms keep filling
5. On arrival: the ghost row is replaced by a real row with VRAM and processor
   split; the modal button becomes **Unload**

The counter advances in 5-second steps because it is redrawn by the poll, not
by a dedicated timer. That is intentional — a separate 1 s interval for
cosmetic text is not worth the extra moving part.

- [ ] **Step 2: Verify persistence across a reload**

While a load is in flight, press F5.

Expected: the ghost row reappears with the elapsed time counted from the
original click (not reset to zero), because `startedAt` came from
`localStorage`. Network histograms restart from empty — that is pre-existing
behaviour and not in scope.

- [ ] **Step 3: Verify the failure paths**

```bash
# 400 before Ollama is touched
curl -s -X POST localhost:3000/api/load-model \
  -H 'Content-Type: application/json' -d '{"model":"nope"}'
```

In the UI: with Ollama stopped, click **Load** → an error message appears
within seconds and the ghost row disappears (a fast failure is a real failure).

- [ ] **Step 4: Verify the stale-marker guard**

In DevTools console:

```js
localStorage.setItem('pendingModelLoad',
  JSON.stringify({ model: 'ghost:test', startedAt: Date.now() - 16 * 60 * 1000 }));
location.reload();
```

Expected: no ghost row — `readPending()` drops entries older than 15 minutes.
Then:

```js
localStorage.setItem('pendingModelLoad', 'not json at all');
location.reload();
```

Expected: no ghost row, no console error, key removed.

- [ ] **Step 5: Verify the eviction race**

Start a load from the dashboard, then immediately request a *different* model
from an external client so Ollama's scheduler evicts.

Expected: our model may never appear. The ghost row must switch to
`loading 10:00 — check Ollama logs` at the 10-minute mark and clear at 15
minutes. The UI must never claim success.

Testing this in real time takes 15 minutes; a compressed check is acceptable —
temporarily lower `PENDING_WARN_MS` and `PENDING_MAX_MS`, verify both
transitions, then restore the constants and confirm they read
`10 * 60 * 1000` and `15 * 60 * 1000` before committing.

- [ ] **Step 6: Commit (ask first)**

Only if Steps 1-5 required fixes:

```bash
git add public/app.js
git commit -m "fix: <what the verification uncovered>"
```

---

### Task 6: Resolve the spec's open questions and update the docs

**Files:**
- Modify: `docs/superpowers/specs/2026-08-16-model-load-unload-design.md`
- Modify: `docs/TECH.md`
- Modify: `docs/PLAN.md`
- Modify: `README.md`
- Possibly modify: `public/app.js` (Expires column)

- [x] **Step 1: Confirm `OLLAMA_KEEP_ALIVE`** — done 2026-08-16 during Task 2.
`/api/ps` reports `expires_at` in the year 2318, which is how Ollama encodes an infinite
`keep_alive`. No SSH needed. Recorded in the spec.

- [x] **Step 2: Determine when `/api/ps` lists a loading model** — done 2026-08-16.
Polled every 3 s across a 303 s load: the list stayed empty the whole time and the model
appeared only once fully resident. No `size_vram > 0` guard needed. Recorded in the spec.

- [ ] **Step 3: Confirm the reverse proxy situation — BLOCKING for deployment**

Ollama cancels a load when the client disconnects, so anything between the browser and the
container must tolerate a request lasting up to ~10 minutes. On the Dockge host:

```bash
docker ps --format '{{.Names}}\t{{.Ports}}' | grep -Ei 'nginx|traefik|caddy|cloudflared'
ss -tlnp | grep -E '3788|:80|:443'
```

If a proxy is in the path, raise its read timeout (`proxy_read_timeout 1800s` in Nginx,
`forwardingTimeouts.responseHeaderTimeout` in Traefik) — no application setting can
compensate. Record the finding in the spec's Timeouts section. Local development connects
directly, so this cannot surface in dev.

- [ ] **Step 4: Decide the Expires column**

Measured 2026-08-16: under `keep_alive: -1` Ollama returns `expires_at` in the **year 2318**,
not a sentinel far enough out for a naive year threshold. Use a horizon test instead:

```js
const expiresMs = m.expiresAt ? new Date(m.expiresAt).getTime() : 0;
const expires = !expiresMs ? '—'
  : expiresMs - Date.now() > 86_400_000 ? '∞'
  : new Date(expiresMs).toLocaleTimeString();
```

Anything more than a day out is effectively never. If the value is
sensible, leave the column untouched and delete the *Incidental Cleanup*
section from the spec.

- [ ] **Step 5: Update the CKM docs**

Per the workspace method: `TECH.md` = HOW, `PLAN.md` = WHEN, no overlap.

`docs/TECH.md` — add to the architecture notes:

```markdown
- `src/collectors/ollamaModels.js` — installed models via Ollama REST `/api/tags` (cached 2 s);
  exports pure `mapTags` / `findModel` (unit-tested in `test/`)
- `src/lib/ollamaClient.js` — POST `/api/generate` with a long-timeout dispatcher, separate
  from the collectors' 8 s one; used only by model actions
- `src/actions/loadModel.js` / `unloadModel.js` — `keep_alive: -1` loads, `keep_alive: 0` evicts
- Model residency is read from `/api/ps` by the 5 s poll and never remembered; the HTTP
  response to a load is not the success signal
```

Add to the env var section: `MODEL_ACTION_TIMEOUT_SEC` (default 300).

Add a Testing section:

```markdown
## Tests

`npm test` runs the built-in Node runner over `test/`. Coverage is limited to pure
functions (payload mapping, model-name validation); I/O and browser code are verified
manually — see the plan in `docs/superpowers/plans/2026-08-16-model-load-unload.md`.
```

`docs/PLAN.md` — mark the feature done with the date, following the file's existing format.

`README.md` — extend the "Loaded models" panel description with the unload button and the
model browser.

- [ ] **Step 6: Commit (ask first)**

```bash
git add docs/ README.md public/app.js
git commit -m "docs: record verified Ollama behaviour and document model actions"
```

---

## Release

Not part of this plan. When the change is ready, follow the Release Procedure in the project
`CLAUDE.md`: bump `package.json`, commit `release: bump to vX.Y.Z`, merge `dev` → `main`,
create the GitHub release. Each step requires user consent.
