# Design Spec: Model Load / Unload (manage VRAM residency from the dashboard)

**Date:** 2026-08-16
**Status:** Draft — awaiting review

---

## Goal

Extend the `LOADED MODELS` card so the dashboard can not only observe which models occupy
VRAM, but also change it:

1. **Unload** a model that is currently resident, freeing its VRAM without touching the others.
2. **Browse** the models installed on the server (`GET /api/tags`) and **load** any of them
   into VRAM.

Today the only way to free VRAM from the dashboard is the `restart-ollama` button, which
unloads *everything*. This spec adds a precise instrument where there is currently only a
blunt one.

---

## Why this matters here: `OLLAMA_KEEP_ALIVE=-1`

The Ollama server is configured with `keep_alive: -1` (infinite). This single fact drives
most decisions below:

- **Models never auto-evict.** A model loaded once stays in VRAM until Ollama restarts.
  Manual unload is not a convenience — it is the only per-model way to reclaim VRAM.
- **Models accumulate while VRAM allows, then Ollama starts evicting.** Nothing expires on a
  timer, so residency grows until the pool is full. Beyond that point Ollama's scheduler
  evicts resident models to fit a new one — observed in practice on this host: requesting a
  different model from an external client makes the previous one disappear and the new one
  appear. Only when a single model cannot fit even after eviction does it spill onto CPU
  (the collector reports `x% GPU / y% CPU`) instead of failing loudly.
- **Residency changes without our involvement.** Any external client (Open WebUI, an IDE
  plugin, a script) can load or evict models. The dashboard must report what it observes,
  never assume its own actions are the only cause of change.
- **`keep_alive` needs no UI control.** The server default already expresses the intent;
  a per-load selector would duplicate an existing decision.

**Verified 2026-08-16:** `/api/ps` reports `expires_at: "2318-11-26T…"` for a freshly loaded
model — roughly 300 years out, which is how Ollama encodes an infinite `keep_alive`. The
setting is confirmed in effect without needing to inspect the container.

Also observed: `OLLAMA_CONTEXT_LENGTH` is far above Ollama's 4096 default — a 1.1 B model
loaded with `context_length: 131072`, and `gemma4:26b-a4b-it-q8_0` with `262144`. The
practical consequence is that the KV cache dominates VRAM: that 26 GB model occupies
**55.9 GB** of VRAM once resident. With ~76 GB total across the six GPUs, a second large
model rarely fits, so eviction is the normal case rather than an edge case.

---

## Decisions Made

| Topic | Decision |
|-------|----------|
| Load parameters | **None.** Plain warm-up; no `keep_alive` selector (server default is `-1`), no `num_ctx` control |
| Context length | Stays encoded in model names (`…-200k` Modelfile copies). Not settable from the UI |
| Available-model list source | `GET /api/tags` via a new collector, exposed as `GET /api/models` |
| List refresh policy | Fetched **once on page init**, plus a manual **↻** button. Not part of the 5 s poll |
| List placement | **Modal**, reusing the existing `.modal-backdrop` / `.modal` pattern from the GPU process modal |
| Completion signal | **Model appearing in `/api/ps`** (existing 5 s poll) — *not* the HTTP response |
| Confirmations | Unload: yes (native `confirm()`). Load: no |
| In-flight indicator | Ghost row in the `LOADED MODELS` card + spinner in the modal, persisted in `localStorage` |
| Existing card | Unchanged, plus a per-row **Unload** button and a **Models…** button |
| Backend job state | **None.** The application stays stateless |
| External residency changes | Reflected live in the card and in the modal's markers; the catalog itself is unaffected |

---

## Rejected Alternatives

| Rejected | Reason |
|----------|--------|
| `keep_alive` selector per load | Duplicates the server-wide `-1` setting |
| `num_ctx` control in the UI | Changing context forces a full unload+reload; context is already expressed through model naming, which is the only channel OpenAI-compatible clients (`/v1/chat/completions`) can use at all |
| Always-visible model list in the card | Dashboard is a glanceable status grid; a 10+ row catalog would dominate the layout |
| Model list inside `/api/status` | The list changes only on `pull`/`rm`; shipping it every 5 s is pure noise |
| Auto-refreshing the list after load/unload | `/api/tags` (on disk) is unaffected by load/unload (in VRAM) — the refresh would fetch identical data |
| Backend job state + `/api/load-status` | Introduces stateful machinery into a stateless app; the existing poll already carries the answer |
| Showing baked-in `num_ctx` per model | Requires one `POST /api/show` per model; zero value given the naming convention |

---

## Architecture

```
                              ┌── GET  /api/models        → collectors/ollamaModels.js  (/api/tags)
public/app.js ── fetch ───────┼── POST /api/load-model    → actions/loadModel.js        (/api/generate)
      │                       └── POST /api/unload-model  → actions/unloadModel.js      (/api/generate)
      │                                                                    │
      │                                                              Ollama :11434
      │
      └── poll 5 s ── GET /api/status ── collectors/ollama.js (/api/ps) ── source of truth
```

The two paths are deliberately independent. Actions push intent; the poll reports reality.
A failed or timed-out action never contradicts the poll, because the poll wins.

---

## Backend

### `src/collectors/ollamaModels.js` (new)

Modelled directly on `src/collectors/ollama.js`.

```js
export function getAvailableModels() {
  return cached('ollama-models', 2_000, async () => { /* GET /api/tags */ });
}
```

Returns `{ models: [{ name, sizeBytes, parameterSize, quantization }] }`, sorted by name.
`family` and `modified_at` are available from the API but deliberately not surfaced —
neither informs a load decision.

TTL stays at 2 s, matching every other collector. The list is fetched on user action, so
there is no polling traffic to throttle; a longer TTL would only add staleness after a
manual refresh.

### `src/actions/loadModel.js` (new)

```js
POST {ollamaBaseUrl}/api/generate
{ "model": name, "prompt": "", "stream": false, "keep_alive": -1 }
```

`stream: false` is required. With the default `stream: true`, headers return immediately and
the load progress arrives as a chunked body — one timeout would govern the connection idle
gap rather than the operation. With streaming off, Ollama stays silent for the whole load and
answers once, so a single `headersTimeout` covers the real operation.

`keep_alive: -1` is passed explicitly rather than relying on the server default, so the
request is self-describing and survives a change to the server environment.

### `src/actions/unloadModel.js` (new)

```js
POST {ollamaBaseUrl}/api/generate
{ "model": name, "keep_alive": 0, "stream": false }
```

`keep_alive: 0` evicts immediately. It overrides the server-wide `-1` for this call only.
Ollama honours it after any in-flight generation on that model completes; an active request
is not preempted.

Per `CLAUDE.md`, actions are **never cached** — each call is a real operation.

### Timeouts

Actions get their **own `undici.Agent`** instance, separate from the collectors'. The
collector agent in `ollama.js` uses 8 s timeouts, appropriate for a 5 s poll and far too
short for a model load.

```js
modelActionTimeoutSec: Math.max(30, parseInt(process.env.MODEL_ACTION_TIMEOUT_SEC, 10) || 1800)
```

The value **is critical**. An earlier draft of this spec assumed a client-side timeout would
not affect Ollama. **That assumption was wrong** — measured on the live host 2026-08-16:

| Attempt | Client timeout | Result |
|---------|---------------|--------|
| `gemma4:26b-a4b-it-q8_0` | aborted at 20 s | never loaded; absent from `/api/ps` 7 min later |
| same model | 300 s | `Headers Timeout Error`; never loaded |
| same model | 1800 s | `{"ok":true}` after 127 s, resident |

**Ollama cancels an in-progress load when the HTTP client disconnects.** A timeout therefore
destroys minutes of work rather than merely releasing a socket.

Measured load times for a 28 GB model: **303 s cold** (read from the ZFS pool) and **127 s
warm** (served from ARC) — a 2.4× spread, which is why the default cannot be fitted tightly
to a warm-cache measurement. At the observed ~92 MB/s, the largest installed model
(`qwen3-coder-next`, 48 GB) needs roughly 9 minutes cold. The 1800 s default leaves headroom;
the env var exists so it can be raised without rebuilding the image.

**Reverse proxies: resolved 2026-08-16.** The deployment is reached through Nginx at
`https://ollama-monitor.techgraft.net`, and a load exceeding `proxy_read_timeout` was tested
there. **The model still loaded.** The request chain has two independent legs:

```
browser ──①── nginx ──②── container ──③── Ollama
```

Nginx's timeout severs leg ②. Leg ③ — the `undici` request that Ollama actually cares about —
is untouched, because Express does not propagate a client disconnect to outgoing requests.
Only leg ③ expiring makes Ollama cancel.

A proxy timeout is therefore a **feedback problem, not an operational one**: the load
completes, but the browser is told nothing. Raising `proxy_read_timeout` to 1800 s is still
recommended so the UI reports honestly; the frontend meanwhile treats 502/504 as "still
watching" rather than as failure.

### Routes (`src/routes.js`)

```
GET  /api/models        → res.json(await safeCollect(getAvailableModels))
POST /api/load-model    { model }
POST /api/unload-model  { model }
```

POST handlers follow the existing `try / catch / res.status(500).json({error})` shape used by
`/api/wake`, `/api/sleep`, `/api/restart-ollama`.

`express.json()` is **already registered** (`server.js:9`), so JSON bodies work without any
change to the server entry point.

### Validation

The `model` field is checked against the current `/api/tags` list before being forwarded.
This is not an injection defence — the name travels as JSON to an HTTP API, never to a
shell. It exists so a typo produces a clear `400 Unknown model: <name>` instead of Ollama's
bare 404.

---

## Frontend

### `LOADED MODELS` card

The existing table (`public/app.js:130`, columns `Model · Params · Quant · Processor · VRAM ·
Ctx · Expires`) gains:

- An **eighth column** with a per-row **Unload** button. `confirm()` before sending, matching
  the convention in `public/app.js:663` where disruptive actions confirm and benign ones do not.
- A **Models…** button in the card header row (reusing the existing `card-label-row` class,
  as `card-ollama-app` already does), opening the modal.
- Support for **ghost rows** — a pending load renders as a dimmed row showing the model name
  and elapsed time (`loading… 3:42`), before the real rows.

The ghost row lives in the card, not only in the modal, so closing the modal does not hide
in-flight work.

### Model browser modal

A new block in `index.html` reusing the existing `.modal-backdrop` / `.modal` classes and
close handling from the GPU process modal (`index.html:103`).

- Populated **once on page init** from `GET /api/models` into an in-memory `_availableModels`
- **↻** button in the modal header re-fetches on demand — the only event that changes this
  list (`ollama pull` / `ollama rm`) happens outside the dashboard and cannot be detected
- **Name filter** input — with several models carrying context suffixes, filtering is faster
  than scanning
- Row: `name · size · parameters · quantization · action button`
- Models present in the latest `/api/ps` snapshot are marked **in memory** and show
  **Unload** instead of **Load**, so the reclaim-then-load cycle (routine under `keep_alive: -1`)
  never requires closing the window
- Its **own message line inside the modal**; the header's `#action-msg` would be obscured

### Action dispatch

`action(name)` (`public/app.js:662`) is name-keyed with hardcoded message maps and takes no
arguments. Model actions are parameterised by model name and do **not** belong in it. A
separate parameterised function sits alongside it, sharing only `apiFetch`.

### Completion detection

| Signal | Meaning | UI reaction |
|--------|---------|-------------|
| Model appears in `/api/ps` | **Loaded** — the only reliable success signal | ghost row → real row; modal button → Unload |
| Fast HTTP error (404 / 500) | Real failure: unknown model, Ollama down | show error, drop ghost row |
| `500` timeout from our own request | **Failure** — Ollama cancelled the load | drop ghost row, report that the load was aborted and must be retried |
| `502` / `504` from a proxy | **Not a failure** — a different leg was severed; the load continues | keep the ghost row, say the proxy stopped waiting and we are still watching |
| Nothing after 10 min, connection still open | Load is slow but alive | ghost row shows `loading 10:00 — still waiting`; row remains |

**Verified 2026-08-16:** `/api/ps` returns an empty list for the entire duration of a load and
lists the model only once it is fully resident — polled every 3 s across a 303 s load, the
model never appeared early with a partial `size_vram`. Appearance is therefore a reliable
success signal and needs no `size_vram > 0` guard.

### Concurrency with external clients

The dashboard is not the only thing talking to Ollama. Open WebUI, IDE plugins and scripts
load and evict models continuously, and under VRAM pressure one client's load evicts another
client's model.

The design absorbs this without special handling, because residency is **read**, never
remembered:

| Surface | Behaviour under external change |
|---------|--------------------------------|
| `LOADED MODELS` card | reflects eviction and arrival within one 5 s cycle |
| Modal catalog (`/api/tags`) | unchanged — on-disk contents are unaffected by residency |
| Modal "in memory" markers | derived from the latest `/api/ps` snapshot, so they flip live while the modal is open |
| Pending ghost row | unaffected; it is a local annotation, not a claim about server state |

Reflecting external change is correct behaviour for a monitoring tool — the failure mode to
avoid is not *observing* someone else's change, it is *inventing* state of our own. Hence the
single rule: `/api/ps` is authoritative, everything else is annotation.

The consequence in the worst case: we request a load, an external client's load evicts it (or
takes the space first), and our model never appears. The ghost row then persists to its 15 min
limit and clears. The UI says "I never observed it", which is true, rather than reporting a
success or a failure it cannot actually determine.

### Persisting in-flight state

`localStorage` key `pendingModelLoad` = `{ model, startedAt }`, written on click, following
the precedent in `public/theme.js`.

On page init the entry is read back and the ghost row re-rendered with elapsed time computed
from `startedAt`. The entry is cleared when the model appears in `/api/ps`, or after 15 min.

Reloading the page does **not** cancel a load. The connection that Ollama requires to stay
open runs between the backend and Ollama; the browser's `fetch` dying does not abort the
`undici` request, because no `AbortSignal` is wired to client disconnect. Restarting the
backend, however, does kill it.

This is cosmetic state only. Truth always comes from `/api/ps`, so a stale or corrupt entry
cannot desynchronise anything — the worst case is a ghost row lingering for 15 minutes
beside a fully correct card.

**Known limitation:** the indicator is per-browser. Opening the dashboard on another device
mid-load shows no ghost row. Cross-client visibility would require backend job state, which
this design deliberately rejects.

---

## Error Handling

| Condition | Backend | UI |
|-----------|---------|-----|
| Model not in `/api/tags` | `400 Unknown model` | `No such model` |
| Load of an embedding-only model | `500` with a plain-language message | `<name> is an embedding model — clients load it on demand, it cannot be warmed from here`. Verified 2026-08-16: `/api/generate` rejects these outright, but **unloading them works**, because the `keep_alive: 0` path returns before the capability check. Warming them from the dashboard has no value anyway — they are small and the clients that need them load them on demand |
| Ollama unreachable | `500` + message | error text, ghost row dropped |
| Load exceeds timeout | `500` timeout | shown as failure — Ollama cancelled the load, it must be retried |
| VRAM pressure | Ollama evicts other resident models to fit | card shows the eviction within one poll cycle — expected behaviour, not an app error |
| Model too large even after eviction | Ollama succeeds, spills to CPU | card shows `x% GPU / y% CPU` — expected Ollama behaviour, not an app error |
| Unload during active generation | succeeds | eviction occurs after the in-flight request finishes |
| Our pending model evicted / never arrives (e.g. an external client loaded something else first) | n/a | ghost row persists to the 15 min limit, then clears — the UI reports "did not observe it", never invents success |

---

## Testing

The project has no test framework (`package.json` defines only `start` and `dev`).
Verification is manual.

```bash
curl localhost:3788/api/models
curl -X POST localhost:3788/api/unload-model -H 'Content-Type: application/json' -d '{"model":"<name>"}'
curl -X POST localhost:3788/api/load-model   -H 'Content-Type: application/json' -d '{"model":"<name>"}'
curl -X POST localhost:3788/api/load-model   -H 'Content-Type: application/json' -d '{"model":"nope"}'   # expect 400
```

UI checklist:

1. Unload a resident model → disappears from the card within one poll cycle
2. Load a large model from cold start → ghost row with ticking counter, then a real row at `100% GPU`
3. Reload the page mid-load → ghost row reappears with correct elapsed time
4. Close the modal mid-load → ghost row still visible in the card
5. Load a nonexistent name → error within seconds, ghost row dropped
6. Load against full VRAM → Ollama evicts a resident model; the card shows both the departure
   and the arrival. A model too large to fit even after eviction appears with a mixed GPU/CPU split
7. Trigger a load from an external client (e.g. Open WebUI) → the card reflects it without any
   dashboard action; the modal catalog stays unchanged and its markers flip
8. `ollama pull` on the host → model appears in the modal only after pressing ↻

Also measure and record the worst-case cold-start load time:

```bash
time curl -s http://<host>:11434/api/generate \
  -d '{"model":"<largest>","prompt":"","stream":false,"keep_alive":-1}'
```

---

## Out of Scope

- **Authentication.** The dashboard has none. After this change, anyone on the LAN can unload
  a model out from under a running session. This is a conscious acceptance, not an oversight;
  adding auth is a separate change.
- **`pull` / `rm`.** The dashboard manages VRAM residency, not disk contents.
- **`num_ctx` from the UI** — see Rejected Alternatives.
- **Cross-client in-flight visibility** — requires backend state.

---

## Incidental Cleanup

The **Expires** column (`public/app.js:139`) renders `expires_at` as a local time. Under
`keep_alive: -1` that value is meaningless. Check what `/api/ps` actually returns and either
display `∞` or leave it unchanged — a small fix, not a reason to expand scope.
