# llama.cpp as an alternative engine — design

**Target release:** v1.6.0
**Status:** approved by owner 2026-11-10

## Intent

The GPU server now runs its models through one of two TrueNAS apps: Ollama, or a
llama.cpp server (`llama-server`) deployed as a custom app. llama.cpp is becoming
the main engine; Ollama stays available. The two are never meant to run at the
same time — they compete for the same GPUs.

The dashboard today knows only Ollama: with llama.cpp serving, it shows a stopped
Ollama app and "No models loaded". It should show whichever engine is active and
let the owner switch between them without opening the TrueNAS UI.

This reverses the v1.5.0 decision "monitoring stays Ollama-only".

## Goals

1. The dashboard detects the active engine on its own and shows that engine's
   model, app stats and GPU badge.
2. A switch in the SERVER card changes the engine: it stops one app and starts
   the other. At most one engine is active.
3. With llama.cpp active, the dashboard shows the generation speed and the MTP
   draft acceptance rate.
4. Ollama support loses nothing.
5. An install that does not configure llama.cpp behaves exactly as v1.5.1.

## Non-goals

- Changing the llama.cpp model or its start flags from the dashboard. The model
  is part of the app's command and is managed outside the monitor.
- Load / unload for llama.cpp. The model lives as long as the container.
- llama.cpp router mode (several models behind one server).
- Engines other than these two.
- History or charts of speed.

## Anti-goals

- A manual "which engine am I looking at" selector. The view always follows what
  is actually running; the switch is an action, never a display preference.
- Both engines left running after a switch.
- Host details in the public repo: no IP addresses, model names or aliases from
  the owner's server in docs, fixtures or defaults.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `LLAMACPP_APP_NAME` | unset | TrueNAS app name of the llama.cpp server. **Unset = feature off.** |
| `LLAMACPP_BASE_URL` | `http://<LLM_HOST>:8080` | llama-server HTTP address |

`llama-server` must be started with `--metrics`, and with the `/slots` endpoint
enabled (it is by default). Without them the speed and MTP figures show `—`;
everything else works.

## Detecting the active engine

One `midclt call app.query` for both app names per poll (it replaces today's
single-app query).

| Ollama app | llama.cpp app | Active engine |
|---|---|---|
| not STOPPED | STOPPED | Ollama |
| STOPPED | not STOPPED | llama.cpp |
| STOPPED | STOPPED | none |
| not STOPPED | not STOPPED | conflict — see below |

"Not STOPPED" covers RUNNING, DEPLOYING and CRASHED: an engine that is starting
or has crashed is still the one the owner selected, and its card must show that
state. App state is the signal, not HTTP reachability — `llama-server` does not
answer `/health` with ok while it downloads or loads a model, which can take an
hour.

**Conflict** (both not STOPPED): the active engine is the one whose container
holds GPU processes; if both or neither do, llama.cpp. The SERVER card shows a
warning line: "Both engines are running — pick one". Choosing either side of the
switch resolves it.

**None:** the model card reads "No engine running"; the app card shows both apps
as stopped; either side of the switch starts that engine.

Host powered off: unchanged — SSH collectors are skipped, engine is unknown, the
switch is disabled.

## What each card shows

### SERVER card

A two-segment switch `Ollama | llama.cpp` sits above the action buttons. The
active engine's segment is highlighted.

- Clicking the inactive segment asks for confirmation ("Switch to llama.cpp?
  Ollama will be stopped and its loaded models unloaded.") and then switches.
- Both segments are disabled only while the server is executing the stop/start
  commands (seconds, see Switching). After that the target is simply the active
  engine in whatever state TrueNAS reports — DEPLOYING shows as "Starting…" on
  its cards — and the switch is usable again, so the owner can back out of a
  long model load or a crash at any time.
- **Restart Ollama** becomes **Restart <engine>** and acts on the active engine
  in any state (RUNNING, DEPLOYING, CRASHED); disabled when none is active.
- **Update all apps** never touches the inactive engine's app: upgrading a
  stopped app may start it, which would put both engines on the same GPUs. The
  inactive engine is updated after the owner switches to it. The button (and
  the app card's update badge) is enabled when an update is waiting for any app
  other than the inactive engine — which means the app list is now read on
  every poll, not only at click time as in v1.5.0. The result line names the
  skipped engine when it had an update pending.

### App card

Title follows the engine: `OLLAMA APP` / `LLAMA.CPP APP`. Content is the same
for both — state, version, image, CPU, RAM, I/O, network — read from the active
app's container. The update badge works as today.

With llama.cpp active the card gains two engine-wide blocks below the container
stats (Ollama exposes neither, so its card is unchanged):

```
CONTEXT   ████████░░░░░░░░░░░░  82k / 200k   (cache 77k)

split tensor · MTP ×4 · slots 1 · threads 12
KV q8_0 · batch 4096 / 2048 · reasoning 4096
```

- **Context fill** — live from `/slots`: `n_prompt_tokens` plus decoded tokens
  against `n_ctx`, and how much of the prompt came from cache
  (`n_prompt_tokens_cache`). With several slots, one bar per slot. Idle slot:
  the bar keeps the last request's fill.
- **Launch parameters** — from the app's TrueNAS configuration
  (`midclt call app.config <app>`: the service `command` list). Read-only,
  refreshed rarely (the values change only when the app restarts). Always
  visible, not collapsed. The GPUs assigned to the engine are deliberately not
  listed here — the engine badge on each GPU card already says that. Only
  recognised flags are shown, in plain words: split mode (`-sm`), speculative decoding type and draft length, slots (`-np`),
  threads (`-t`), KV cache quantization (`-ctk`/`-ctv`), batch sizes
  (`-b`/`-ub`), reasoning budget. Unrecognised flags are not interpreted; the
  full command is available as the block's tooltip. A flag that is absent is
  simply not listed.

### Model card (`LOADED MODELS`)

With Ollama active: exactly as today, including **Models…** and **Unload**.

With llama.cpp active:

```
LOADED MODELS                                    ▶ 21.7 tok/s · MTP 61%
Model            Params   Quant   VRAM      Ctx
<alias>          26.9B    Q8_0    38.2 GB   200k
```

- The header's right side — where **Models…** sits for Ollama — carries the
  speed and MTP figures. **Models…** is hidden.
- Columns `Processor`, `Expires` and the action column are dropped: llama.cpp
  has no equivalent.
- Row source: alias, parameter count, quantization and context from
  `/props` and `/v1/models`. VRAM is the sum of GPU memory held by the app's
  container, taken from the GPU process list the dashboard already collects.
- App running but server not ready yet: a single dimmed row "Loading model…".

### GPU cards

The `OLLAMA` badge becomes an engine badge: `OLLAMA` or `LLAMA.CPP`, same style.
A GPU gets the badge of the engine whose **app/container** has a process on it.
Matching is by app name only — never by binary name, because Ollama itself runs
a `llama-server` binary inside its container.

## Speed and MTP

Measured on the live server: `/metrics` counters change only when a request
finishes; `/slots` → `next_token.n_decoded` grows during generation.

**Speed**

- *While generating* (a slot has `is_processing: true` and `n_decoded` growing):
  tokens per second = change in `n_decoded` ÷ wall-clock time between two
  consecutive samples of the same task (`id_task`). Shown with a ▶ marker.
- *While reading the prompt* (`is_processing` true, nothing decoded yet): the
  header shows "reading prompt…" instead of a speed.
- *Idle:* the speed of the last finished request, dimmed, no marker. Computed
  from the change in `tokens_predicted_total` ÷ change in
  `tokens_predicted_seconds_total` at the moment those counters last moved.
  Until the dashboard has seen a request finish: the same ratio over the
  counters' lifetime values.

**MTP acceptance**

`spec_decode_num_accepted_tokens_total` ÷ `spec_decode_num_draft_tokens_total`,
as a whole percent. Same window as idle speed: the last finished request once
one has been observed, lifetime otherwise. If the draft counter is absent or
zero (speculative decoding off), the MTP figure is not shown at all.

Tooltips on both figures say which window they cover.

The between-samples state lives in the collector, the way the app card's CPU%
already keeps its previous sample.

## Switching

`POST /api/switch-engine` with `{ "target": "ollama" | "llamacpp" }`.

1. Reject if the host is down, the target is unknown, the feature is off, or
   another switch is running (HTTP 409).
2. Stop the other engine's app if it is not STOPPED; wait for the stop job.
3. Wait 3 s (GPU release — the same gap the restart action uses).
4. Start the target app.
5. Respond once the start is queued. The UI treats the target app reaching
   RUNNING in the regular poll as the success signal, not the HTTP response.

`engine.switching` is an in-memory server flag, true only between steps 2 and 5.
It is not persisted and has no timeout of its own beyond the SSH command's; a
monitor restart clears it, and the next poll shows the real app states.

If the target is already the only engine not STOPPED, the call is a no-op.
If a stop or start command errors, the call returns 500 and the dashboard shows
whatever the apps then report (possibly no engine). A target that starts and
then crashes is shown as the active engine in state CRASHED. In both cases the
owner picks either side again. No automatic rollback.

## llama-server payloads

Field paths confirmed on the deployed build (values below are illustrative).
No API key is used; authenticated llama-server is out of scope.

- `GET /health` → `{"status":"ok"}` when ready.
- `GET /props` → `model_alias`, `model_ftype` (quantization, e.g. `Q8_0`),
  `total_slots`, `default_generation_settings.n_ctx`.
- `GET /v1/models` → `data[0].id` (alias), `data[0].meta.n_params` (integer;
  shown as `26.9B`), `data[0].meta.n_ctx`, `data[0].meta.ftype`.
- `GET /slots` → array of
  `{ id, n_ctx, is_processing, id_task, n_prompt_tokens, n_prompt_tokens_cache,
  next_token: [ { n_decoded, n_remain, has_next_token } ] }`.
- `GET /metrics` → Prometheus text, prefix `llamacpp:` —
  `tokens_predicted_total`, `tokens_predicted_seconds_total`,
  `prompt_tokens_total`, `prompt_seconds_total`, `requests_processing`,
  `spec_decode_num_draft_tokens_total`, `spec_decode_num_accepted_tokens_total`.
  Values may be in scientific notation (`3.91362e+06`).

Test fixtures use these shapes with made-up values (`model-a`, round numbers).

## API changes

Following the v1.5.0 precedent, renamed routes get no alias.

- `/api/status`: `ollama` → `models`, `ollamaApp` → `engineApp`; new `engine`
  object: `{ active, switching, conflict, apps: { ollama: {state, upgradeAvailable}, llamacpp: {…} } }`;
  per-GPU `hasOllama` → `engine` (`'ollama' | 'llamacpp' | null`). With llama.cpp
  active, `models` also carries `speed` and `mtp`.
- `POST /api/restart-ollama` → `POST /api/restart-engine`.
- `GET /api/ollama`, `GET /api/ollama-app` → `GET /api/models-loaded`,
  `GET /api/engine-app`.
- `POST /api/load-model`, `/api/unload-model`, `GET /api/models`: Ollama only;
  HTTP 409 when llama.cpp is active.
- New: `POST /api/switch-engine`.

With `LLAMACPP_APP_NAME` unset, `engine.apps` has only `ollama`, the switch is
not rendered and `switch-engine` returns 404.

## Tests

`node:test`, pure functions only, as in the existing suite:

- picking the active engine from two app states, including conflict and none
- mapping `/props` + `/v1/models` to a model row
- parsing the Prometheus text of `/metrics`
- live speed from two slot samples; task change between samples; idle fallback
- MTP percent, including the "counter absent" case
- per-GPU engine badge from the process list
- pending-update selection that skips the inactive engine
- launch parameters from a command list: known flags, unknown flags, absent flags
- context fill from a slot sample

## Documents to update with the release

`docs/PRD.md` (purpose, FR1/FR2, the v1.5.0 gating sentence), `docs/PLAN.md`
(v1.6.0 milestone), `docs/TECH.md`, `README.md`, `CLAUDE.md`, `.env.example`.

## Left to the builder

- File layout and names of new collectors and actions.
- Visual styling of the switch and the header figures, within the existing
  look. If `LLAMA.CPP` wraps the badge row on a GPU card at the narrowest
  supported width, shorten it to `LLAMA`.
- Cache keys and timeouts, following the existing collectors.

## Calls made by the author, not by the owner

- Idle speed and MTP use the last finished request, falling back to lifetime
  averages.
- Conflict tie-break favours llama.cpp.
- A crashed or deploying app still counts as the selected engine.
- No rollback when the target fails to start.
- API fields and routes are renamed rather than aliased.
- Launch parameters are always visible rather than collapsed.
