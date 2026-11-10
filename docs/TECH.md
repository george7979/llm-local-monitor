# Technical Reference — llm-local-monitor

**Stack:** Node 22-alpine, Express 5 ESM, vanilla HTML/CSS/JS
**Deploy:** Docker container on Dockge host (`<DOCKGE_HOST>`) via Dockge
**Target:** TrueNAS GPU server (`$LLM_HOST`) — GPU server running Ollama or llama.cpp (one at a time)

---

## Architecture

```
Browser (local network)
  ↓ HTTP :3788 (HOST_PORT)
Container llm-local-monitor (Dockge, <DOCKGE_HOST>)
  ├── GET /api/config          → version, llmHost, truenasUrl, pollIntervalSec
  ├── GET /api/status          → host + ipmi (parallel) + SSH collectors when alive; `engine`, `models`, `engineApp`
  ├── GET /api/models-loaded   → active engine's loaded models (Ollama /api/ps or llama-server), null when no engine
  ├── GET /api/engine-app      → active engine's app stats (llama.cpp adds `launch`), null when no engine
  ├── GET /api/gpu-procs       → SSH: nvidia-smi compute-apps + /proc/<pid>/cgroup + midclt app.query
  ├── GET /api/check-update    → GitHub API (cached 1h server-side)
  ├── GET /api/models          → Ollama REST :11434/api/tags (installed on disk); 409 with llama.cpp active
  ├── POST /api/wake           → ipmitool → $IPMI_HOST
  ├── POST /api/sleep          → ipmitool power soft → $IPMI_HOST
  ├── POST /api/switch-engine  → SSH → midclt app.query + core.get_jobs, app.stop other (awaited), 3 s, app.start target (awaited); body {"target":"ollama"|"llamacpp"}
  ├── POST /api/restart-engine → SSH → midclt app.query + core.get_jobs, app.stop (awaited), 3 s, app.start (awaited) on the active engine's app (409 when none)
  ├── POST /api/upgrade-apps   → SSH → midclt call app.query (+ core.get_jobs with llama.cpp), then app.upgrade_bulk / app.pull_images; skips non-active engine apps
  │                              (switch, restart and upgrade share one lock: 409 while another runs, or while a TrueNAS job runs on an engine app)
  ├── POST /api/load-model     → Ollama REST /api/generate, keep_alive:-1; 409 with llama.cpp active
  ├── POST /api/unload-model   → Ollama REST /api/generate, keep_alive:0; 409 with llama.cpp active
  └── (llama.cpp) GET :8080 /props /v1/models /slots /metrics   ← polled by the llamacpp collector
        ↓ SSH (ed25519, decoded from SSH_PRIVATE_KEY_B64)
  $LLM_HOST ($LLM_USER)
  ↓ TCP probe :443
  $IPMI_HOST (IPMI availability check — independent from SSH/OS state)
```

---

## Key technical decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Ollama data source | REST API `:11434/api/ps` | `ollama` is not in `truenas_admin` PATH; API returns richer data (VRAM, context, quantization) |
| Container stats | SSH → `/sys/fs/cgroup/docker/<id>/` | TrueNAS REST API does not expose cgroup stats; midclt over SSH gives status + cgroups in a single SSH call |
| SSH key in container | Base64 in `SSH_PRIVATE_KEY_B64` | Dockge does not support easy file mounting; base64 in `.env` = full configuration via UI |
| CPU% Ollama App | `usage_usec / (wall_usec × nproc) × 100` | `usage_usec` sums across all cores; without `nproc` values exceed 100% |
| IPMI status | TCP probe port 443 on `$IPMI_HOST` | IPMI web interface responds even when server is powered off — availability signal independent from SSH/OS |
| Uptime | SSH → `/proc/uptime` (awk) | Instant kernel read, no middleware dependency; cache TTL = `pollIntervalSec - 1s` |
| Update check | GitHub API `/releases/latest`, cached 1h server-side | 60 req/h limit without token — server cache prevents exhaustion; client checks on page load + every 6h |
| Update-all UI triggers | Badge (engine app card) + button (SERVER card) | Button mirrors the badge; `disabled` driven by the active engine's update flag (`engine.updatesWaiting`; `engineApp.upgradeAvailable` when llama.cpp is not configured), same greying pattern as Wake; `upgradeAllApps(msgId)` routes feedback to the calling card |
| App list read in the action | `upgradeApps()` calls `app.query` itself, with `state` | The answer must be fresh at click time, not up to a poll interval old — the active engine and the skip list included. Engine detection for the poll has its own `app.query` (`getApps()`, one per poll, cached 2 s, shared by every consumer, read in parallel with the GPU process list) |
| Active engine | From TrueNAS app state: an app not STOPPED is selected (RUNNING, DEPLOYING and CRASHED all count) | App state, not HTTP reachability: `llama-server` answers nothing useful while it downloads or loads a model, which can take an hour. Both selected = conflict: the engine whose app holds GPU processes wins, a tie goes to llama.cpp. Neither = none |
| Engine matching on GPUs | By TrueNAS app name only (`gpuProcs` `container`), never by binary name | Ollama runs its own `llama-server` binary inside its container |
| Update all apps vs engine apps | Every engine app that is not the active one is skipped (both when none is active, and both on a conflict) | Upgrading a stopped app may start it, putting both engines on the same GPUs. Unreadable app list (llama.cpp configured) → HTTP 503, nothing is upgraded. The result names skipped apps that had an update pending. Not configured, or its app not found → nothing skipped, as v1.5.1 |
| One engine-action lock | `src/lib/engineLock.js`, shared by switch, restart and Update all apps | Any of them can start or stop an engine app; overlapping (e.g. a restart during a switch's stop) could leave both engines on the same GPUs. Taken synchronously before the first await, released in `finally`; a refused request (409) never holds it. In-memory: a monitor restart clears it. `engine.switching` reports it, `engine.action` names the holder |
| TrueNAS jobs checked, not remembered | `src/lib/truenasJobs.js` appends `core.get_jobs` (state WAITING/RUNNING) to the `app.query` command; pure `engineJobsPending` in `src/lib/engine.js` keeps the jobs (`app.start`, `app.stop`, `app.redeploy`, `app.update`, `app.upgrade`, `app.upgrade_bulk`, `app.pull_images`, `app.rollback`, `app.delete`) whose arguments name an engine app | The lock only covers this monitor's requests; an upgrade job left running by Update all apps, or anything started from the TrueNAS UI, can still start an engine. Switch, restart and Update all apps (llama.cpp configured) refuse with 409 while such a job runs, with 503 when the job list cannot be read (fail closed). Matched by exact app name: a string argument, an object's `app_name`, or either inside arrays — never a substring, never other object values (an `app.update` carries the whole compose config). The same read feeds `engine.busy` on the poll, without an extra ssh call; a failed job read there only sets `busy` to null. **Known limit:** a job TrueNAS has not yet created at the moment of the fresh read (two operators clicking in the same instant, one in the TrueNAS UI) cannot be seen |
| Switching engines | `switchEngine`: fresh `app.query` + pending jobs, stop other (`midclt call -j`, 120 s), 3 s, start target if STOPPED (`midclt call -j`, 120 s) | Fresh read, not the 2 s cache. The target still STOPPING → 409 (it would finish stopping and leave no engine). The response arrives when the start job has finished — the container is up, not the model loaded; the target showing up as the active engine in the regular poll is the success signal. A start that outlasts 120 s → 500, no rollback; a target that fails to start shows as the active engine in CRASHED |
| Restarting the engine | `restartEngine`: fresh `app.query` + pending jobs, stop (`midclt call -j`, 120 s), 3 s, start (`midclt call -j`, 120 s) | The lock covers the real stop and start, not just queued ones. The app comes from the fresh read (the cache can still show an engine a switch has just stopped); a STOPPED app is just started. Without llama.cpp the job check covers the Ollama app only. `app.restart` is not used: it skips the 3 s GPU gap |
| Digest-pinned llama.cpp image | Never reports an update | With llama.cpp active the update button stays grey; other apps are updated from TrueNAS or while Ollama is active |
| Two upgrade paths | `app.upgrade_bulk` for charts, `app.pull_images` for image-only | `upgrade_available` is a chart bump and pulls new images with it; `image_updates_available` alone is a fresher tag on the same chart, which `app.upgrade` does not handle. There is no bulk form of `pull_images` |
| `snapshot_hostpaths` left off | Default `false`, as before | Only `ollama` uses `host_path` (463 GB of model blobs on `nvme_pcie`, 303 GB free); ZFS snapshots are free at creation but pin freed blocks afterwards, and nothing here prunes them. The apps with real config-migration risk sit on `ix_volume`, which the option does not cover. `app.rollback` remains the tool for a broken upgrade |
| GPU process names | PID → `/proc/<pid>/cgroup` → `midclt call app.query` on host | nvidia-smi reports only binary paths; TrueNAS app name (e.g. `ollama`) is the meaningful label; `docker ps` not accessible to `truenas_admin`; single SSH round-trip keeps it atomic |
| Load / unload models | `POST /api/generate` with `keep_alive: -1` / `0`, `stream: false` | Ollama has no dedicated load/unload endpoints. `stream: false` keeps the whole operation inside one response, so a single timeout governs it |
| Model-action timeout | Own `undici.Agent`, `MODEL_ACTION_TIMEOUT_SEC` (default 1800) | **Ollama cancels an in-progress load when the client disconnects** (verified 2026-08-16), so the timeout must outlast the slowest load. Measured 28 GB: 303 s cold / 127 s warm. Collectors keep their 8 s agent — a 5 s poll and a 10 min load cannot share timeouts |
| Proxy timeouts (502/504) | Treated as "still watching", not as failure | Nginx's timeout severs browser↔container; the container↔Ollama request is untouched and completes. Verified 2026-08-16 through `ollama-monitor.techgraft.net`: the model loaded despite a 504. Raising `proxy_read_timeout` to 1800 s is still recommended for honest feedback |
| Load success signal | Model appearing in `/api/ps`, not the HTTP response | `/api/ps` stays empty for the whole load and lists the model only once fully resident (verified), so it is authoritative and immune to what any single client does |
| Available-model list | Fetched once at page load + manual ↻ | `/api/tags` changes only on `pull`/`rm` — events outside the dashboard that cannot be detected, and that load/unload never cause |
| Pending-load indicator | `localStorage.pendingModelLoad`, cosmetic only | Survives F5 during a multi-minute load. Truth still comes from `/api/ps`, so a stale entry cannot desynchronise anything; entries older than 15 min are dropped |

---

## Theme System

All colors are defined as CSS custom properties in `:root` (dark by default). A `[data-theme="light"]` block in `styles.css` overrides every variable to the Blue-Gray palette.

**Entry point:** `public/theme.js` — a small IIFE loaded synchronously in `<head>` (no `defer`/`async`) to prevent FOUC. It:

1. Reads `localStorage.getItem('llm-monitor-theme')` — uses it if present
2. Falls back to `window.matchMedia('(prefers-color-scheme: light)')` on first visit
3. Sets `document.documentElement.setAttribute('data-theme', theme)` before first paint
4. Exposes `window.toggleTheme()` for the button's `onclick`
5. Listens for OS color-scheme changes; only applies them when no manual preference is saved

**localStorage key:** `llm-monitor-theme` (`"dark"` | `"light"`)

**Hardcoded color overrides:** Several selectors in `styles.css` use hardcoded hex values instead of CSS variables (SVG `fill` attributes, header background, `#dde8f0` text). These are explicitly overridden in the `[data-theme="light"]` block at the bottom of `styles.css`.

---

## Dev Commands

```bash
# Install
npm install

# Local dev (hot reload)
npm run dev

# Build & run in Docker (local)
docker compose build
docker compose up -d
docker compose logs -f
docker compose down

# After any code change:
docker compose build && docker compose up -d
```

---

## Environment Variables

Copy `.env.example` → `.env` and fill in:

| Var | Description | Required |
|-----|-------------|---------|
| `LLM_HOST` | GPU server IP (TrueNAS) | ✅ |
| `LLM_USER` | SSH user on the server | ✅ |
| `SSH_PRIVATE_KEY_B64` | SSH private key encoded as base64 | ✅ |
| `IPMI_HOST` | BMC/IPMI module IP | ✅ |
| `IPMI_USER` | IPMI user | ✅ |
| `IPMI_PASS` | IPMI password | ✅ |
| `TRUENAS_URL` | TrueNAS web UI URL (default: `https://$LLM_HOST`) — clicking the IP in the header | optional |
| `HOST_PORT` | Port on Dockge host (default: 3788) | optional |
| `PORT` | Internal container port — must match Dockerfile EXPOSE (default: 3000) | optional |
| `OLLAMA_BASE_URL` | Ollama API URL (default: `http://$LLM_HOST:11434`) | optional |
| `OLLAMA_APP_NAME` | TrueNAS App name for Ollama (default: `ollama`) | optional |
| `LLAMACPP_APP_NAME` | TrueNAS App name of the llama.cpp server. Unset = llama.cpp support off (dashboard behaves as Ollama-only) | optional |
| `LLAMACPP_BASE_URL` | llama-server URL (default: `http://$LLM_HOST:8080`) | optional |
| `POLL_INTERVAL_SEC` | Polling interval in seconds (default: 5) | optional |
| `IPMI_INTERFACE` | ipmitool interface (default: `lanplus`, use `lan` for IPMI v1.5) | optional |
| `WAKE_CMD` | Custom wake command — overrides ipmitool default | optional |
| `SLEEP_CMD` | Custom shutdown command — overrides ipmitool default | optional |
| `NETWORK_PHYS_IFACES` | Comma-separated physical NIC names — enables LAN Ports widget | optional |
| `NETWORK_HOST_IFACE` | Host/bond interface shown as summary row (e.g. `br0`) | optional |
| `NETWORK_LINK_SPEED_MBIT` | Override auto-detected link speed in Mbit/s | optional |
| `SSH_KEY_PATH` | Key path inside container (default: `/root/.ssh/id_ed25519`) | optional |
| `MODEL_ACTION_TIMEOUT_SEC` | Socket timeout for load/unload requests to Ollama (default: 1800, min 30). Raise it, never lower it — a timeout makes Ollama cancel the load | optional |

Generate `SSH_PRIVATE_KEY_B64`:
```bash
cat ~/.ssh/id_ed25519 | base64 -w 0
```

---

## How the SSH key gets into the container

`entrypoint.sh` decodes `SSH_PRIVATE_KEY_B64` from `.env` on every container start
into the file `/root/.ssh/id_ed25519` with chmod 600. The container can then SSH to `$LLM_USER@$LLM_HOST`.

The public key must be added to `$LLM_USER` on the server beforehand:

```bash
# 1. Check or generate key
ls ~/.ssh/id_ed25519 || ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ""

# 2. Add to authorized_keys on the GPU server
ssh-copy-id -i ~/.ssh/id_ed25519.pub $LLM_USER@$LLM_HOST
# or manually:
cat ~/.ssh/id_ed25519.pub | ssh $LLM_USER@$LLM_HOST 'cat >> ~/.ssh/authorized_keys'

# 3. Verify
ssh -o BatchMode=yes $LLM_USER@$LLM_HOST "echo OK"
```

---

## Deploy via Dockge

**Two files — only YAML + .env in Dockge UI.** Docker BuildKit builds the image from GitHub.

### 1. In Dockge UI: New Stack

Name: `llm-local-monitor`. Paste YAML:

```yaml
services:
  llm-local-monitor:
    build:
      context: https://github.com/george7979/llm-local-monitor.git#main
      dockerfile: Dockerfile
      no_cache: true
    pull_policy: build
    container_name: llm-local-monitor
    restart: unless-stopped
    ports:
      - "${HOST_PORT:-3788}:3000"
    env_file:
      - .env
```

### 2. Stack .env

```
LLM_HOST=<GPU server IP>
LLM_USER=truenas_admin
SSH_PRIVATE_KEY_B64=<cat ~/.ssh/id_ed25519 | base64 -w 0>

IPMI_HOST=<BMC module IP>
IPMI_USER=ADMIN
IPMI_PASS=<password>

# Optional — default: http://<LLM_HOST>:11434
# OLLAMA_BASE_URL=<http://LLM_HOST:port>

HOST_PORT=3788
PORT=3000
TZ=Europe/Warsaw
```

### 3. Deploy

Click **Deploy**. Dashboard: `http://<DOCKGE_HOST>:3788`

### Updating after code changes

In Dockge: **Restart** — `no_cache: true` + `pull_policy: build` pulls fresh code from GitHub.

---

## Verification (local)

```bash
# Healthcheck
curl http://localhost:3788/healthz
# → {"ok":true}

# Server status
curl http://localhost:3788/api/status | python3 -m json.tool

# Individual panels
curl http://localhost:3788/api/models-loaded
curl http://localhost:3788/api/gpu
curl http://localhost:3788/api/gpu-procs
curl http://localhost:3788/api/memory
curl http://localhost:3788/api/engine-app
curl http://localhost:3788/api/models        # Ollama only

# Action test (be careful!)
curl -X POST http://localhost:3788/api/wake

# Engine actions move the GPUs on the live server — only with the owner's go-ahead
curl -X POST http://localhost:3788/api/switch-engine \
  -H 'Content-Type: application/json' -d '{"target":"llamacpp"}'   # or "ollama"
curl -X POST http://localhost:3788/api/restart-engine

# Model actions (Ollama only) — unload is instant, load can take minutes
curl -X POST http://localhost:3788/api/unload-model \
  -H 'Content-Type: application/json' -d '{"model":"<name>"}'
time curl -X POST http://localhost:3788/api/load-model \
  -H 'Content-Type: application/json' -d '{"model":"<name>"}'
```

---

## Tests

```bash
npm test
```

Runs Node's built-in test runner over `test/`. Coverage is deliberately limited to pure
functions — `mapTags` and `findModel` in `src/collectors/ollamaModels.js`, the engine logic in
`src/lib/engine.js` (active engine, GPU badge, switch plan, pending-update selection), the
llama-server parsing in `src/lib/llamacppParse.js` (metrics text, model row, speed, MTP, context
fill, launch parameters, the between-poll `advance()` state machine) and `switchEngine` with an
injected executor. Everything that
touches HTTP, SSH or the DOM is verified manually with the curl commands above and in the
browser; `public/app.js` is a classic script, not an ES module, so a runner cannot import it.

The `test` script globs `test/*.test.js` rather than passing the directory: on Node 24
`node --test test/` treats the directory as an entry module and fails with `MODULE_NOT_FOUND`
before running anything — a failure easily mistaken for a missing import in the code
under test.

---

## Update Check — how it works

The app checks the GitHub API for new releases using two independent cache layers:

**Layer 1 — server (1h):**
`GET /api/check-update` queries `github.com/repos/.../releases/latest` and caches the result for 1 hour. All requests within that window return the cached response without hitting GitHub. Cache resets on container restart.

**Layer 2 — client (6h):**
The browser calls `/api/check-update` in two situations: on every page load, and every 6 hours if the tab stays open.

```
Page loaded  → /api/check-update → server (GitHub or 1h cache)
Every 6h     → /api/check-update → server (GitHub or 1h cache)
```

**Practical consequence:** after publishing a new release the update badge appears within 1 hour (server cache expiry) + next page load. Restarting the container after a release triggers an immediate cache refresh.

**Version comparison:** badge appears only when `latest > current` (semver). Same version on dev and main never triggers a false badge.

---

## llama.cpp engine

Enabled by `LLAMACPP_APP_NAME` (an app of that name that does not exist behaves as not configured: Ollama-only, plus a "not found" warning). `llama-server` should run with `--metrics`; `/slots` is on by default. Without `/metrics` live speed still works (it comes from `/slots`); only the idle speed shows `—` and MTP is left out.
No API key is used (authenticated llama-server is not supported).

### Payloads (field paths)

- `GET /health` → `{"status":"ok"}` when ready (not used for engine detection)
- `GET /props` → `model_alias`, `model_ftype` (quantization, e.g. `Q8_0`), `total_slots`, `default_generation_settings.n_ctx`
- `GET /v1/models` → `data[0].id` (alias), `data[0].meta.n_params` (integer, shown as `27.0B`), `data[0].meta.n_ctx`, `data[0].meta.ftype`
- `GET /slots` → array of `{ id, n_ctx, is_processing, id_task, n_prompt_tokens, n_prompt_tokens_cache, next_token: [ { n_decoded, n_remain, has_next_token } ] }`
- `GET /metrics` → Prometheus text, prefix `llamacpp:` — `tokens_predicted_total`, `tokens_predicted_seconds_total`, `prompt_tokens_total`, `prompt_seconds_total`, `requests_processing`, `spec_decode_num_draft_tokens_total`, `spec_decode_num_accepted_tokens_total`. Values may be in scientific notation (`3.91362e+06`)

### Counters move only when a request finishes

`/metrics` counters change only when a request finishes; `/slots` → `next_token.n_decoded` grows during generation. So:

- **Live speed** (shown with ▶): change in `n_decoded` ÷ wall-clock time between two consecutive samples of the same `id_task`, at least 1 s apart (overlapping reads share one in-flight request). While a slot is processing but nothing is decoded yet the card reads "reading prompt…"
- **Idle speed**: dimmed, from the change in `tokens_predicted_total` ÷ `tokens_predicted_seconds_total` at the moment the counters last moved; until a finished request has been seen, the ratio over the counters' lifetime
- **MTP %**: `spec_decode_num_accepted_tokens_total` ÷ `spec_decode_num_draft_tokens_total`, same window as idle speed; hidden when the draft counter is absent or zero
- Between-poll state lives in the collector (`llamacpp.js`); the transitions are the pure `advance()` in `llamacppParse.js`, reset whenever the server stops answering

### Cards

- **Model row**: alias, parameters, quantization, context from `/props` + `/v1/models`; VRAM = sum of GPU memory held by the llama.cpp app's container (from the `gpuProcs` list). Server not ready → one dimmed "Loading model…" row while the app is RUNNING or DEPLOYING, otherwise "Not running (<STATE>)". Columns Processor / Expires / actions are dropped and **Models…** hidden
- **App card**: same container stats as Ollama (read from the active app), plus context fill per slot (idle slot keeps the last fill) and the launch parameters from `midclt call app.config <app>` (service `command`, cached 60 s). Only recognised flags are interpreted — split mode, speculative decoding (`MTP ×n` for MTP types, `spec <type> ×n` for others, nothing for `none`), slots, threads, KV cache quantization, batch sizes, reasoning budget; the full command is the block's tooltip
- **GPU badge**: `OLLAMA` / `LLAMA.CPP` per GPU, by the app that has a process on it; at 640 px and below the badge reads `LLAMA`
- **No engine active**: the model card reads "No engine running", the app card lists both apps as stopped; either side of the switch starts that engine. **Conflict** shows "Both engines are running — pick one" in the SERVER card

### `/api/status` shape

`ollama` → `models`, `ollamaApp` → `engineApp`, per-GPU `hasOllama` → `engine` (`'ollama' | 'llamacpp' | null`). `engine` is `{ active, switching, action, busy, conflict, enabled, notFound, updatesWaiting, apps: { ollama: {state, upgradeAvailable}, llamacpp: {…} } }` (`switching` = an engine action of this monitor holds the lock, `action` = `'switch' | 'restart' | 'upgrade' | null`, `busy` = `{ app, method }` of a TrueNAS job still running on an engine app or null — also without llama.cpp, for the Ollama app), plus `error` when the app list could not be read. With llama.cpp active `models` also carries `speed`, `mtp`, `activity`, `loading` and `slots`. Unconfigured: `engine.apps` has only `ollama`, the switch is not rendered and `switch-engine` returns 404. Without llama.cpp (unconfigured or its app not found) `models` always comes from Ollama's `/api/ps`; unconfigured, the model routes do not read the app list at all. Renamed routes have no aliases.

### Switch endpoint

`POST /api/switch-engine` `{ "target": "ollama" | "llamacpp" }` — 404 when llama.cpp is not configured or an engine app is missing, 400 unknown target, 409 another engine action running, a TrueNAS job still running on an engine app or the target app still STOPPING, 503 host down or the job list unreadable. `restart-engine` and `upgrade-apps` also answer 409 while another engine action or a TrueNAS engine-app job runs, and 503 when the job list cannot be read; `upgrade-apps` answers 503 when the app list cannot be read too. Both checks for `upgrade-apps` apply with llama.cpp configured only (v1.5.1 without). The switch and the restart answer when the start job has finished. Target already the only engine not STOPPED → `{ok:true, noop:true}`. A stop/start error or a job outlasting 120 s → 500; the dashboard shows whatever the apps then report.

---

## Troubleshooting

| Problem | Diagnosis | Solution |
|---------|-----------|----------|
| SSH: Permission denied | Public key not added to `authorized_keys` | See _How the SSH key gets into the container_ |
| SSH: key file not accessible | `SSH_PRIVATE_KEY_B64` empty or invalid | Check: `echo $SSH_PRIVATE_KEY_B64 \| base64 -d \| head -1` should start with `-----BEGIN` |
| Ollama panel empty / error | Ollama API unavailable | Check: `curl http://$LLM_HOST:11434/api/ps` — should return JSON with `models` |
| nvidia-smi: not found | No NVIDIA driver on host | Check: `ssh $LLM_USER@$LLM_HOST which nvidia-smi` |
| ipmitool error | Wrong `IPMI_HOST`, user or password | Test: `ipmitool -I lanplus -H $IPMI_HOST -U $IPMI_USER -P $IPMI_PASS chassis status` |
| Memory arc = 0 | `/proc/spl/kstat/zfs/arcstats` unavailable | Check: `ssh $LLM_USER@$LLM_HOST lsmod \| grep zfs` |
| llama.cpp idle speed shows `—`, no MTP figure | `llama-server` started without `--metrics` (live speed still works, from `/slots`) | Add `--metrics` to the app's command |
| llama.cpp shows no live speed while generating | `/slots` disabled | Leave `/slots` enabled (the default) |
| llama.cpp model row stuck on "Loading model…" | `/props` or `/v1/models` not answering yet (model still loading) or `LLAMACPP_BASE_URL` wrong | Check: `curl http://$LLM_HOST:8080/health` — `{"status":"ok"}` when ready |
| Engine app card: parse error | `midclt` not installed or no permissions | Test: `ssh $LLM_USER@$LLM_HOST midclt call core.ping` |
| A model fails instantly with `option "stop" must be of type array` | Its stored parameters keep `stop` as a scalar; Ollama 0.32 requires an array | Rebuild the manifest — see _Repairing a model rejected by parameter validation_ |

### Repairing a model rejected by parameter validation

Ollama 0.32 validates a model's stored parameters on load and rejects a `stop`
saved as a scalar rather than an array. Three properties make this hard to
recognise from the UI:

- **It fails in ~0.1 s with HTTP 500**, before any VRAM is touched, so nothing
  moves on the GPUs and it reads as "nothing happened"
- **Every client fails identically** — the fault is in the model's manifest,
  not in the caller, so a second tool reproducing it is expected, not a clue
- **Overriding `stop` in the request's `options` does not help**: validation
  runs against the model's own parameters before request options are merged

Models built by `ollama create` from a local GGUF are the ones affected —
a Modelfile written for an older Ollama could store the scalar form.

Inspect what the model actually stores:

```bash
curl -s -X POST http://$LLM_HOST:11434/api/show -d '{"model":"<model>"}'
```

Rebuild the manifest under its own name, passing `stop` as an array and
carrying over every other parameter it already had. The GGUF blob is shared,
so this consumes no extra disk and completes in well under a second:

```bash
curl -s -X POST http://$LLM_HOST:11434/api/create -d '{
  "model": "<model>", "from": "<model>",
  "parameters": { "stop": ["<token>"], "num_gpu": 99, "temperature": 0.1 },
  "stream": false }'
```

Verify with a **real** load. `keep_alive:0` is not a test — it returns HTTP 200
without loading anything and passes whether or not the repair worked. Only
residency in `/api/ps` proves it:

```bash
curl -s -X POST http://$LLM_HOST:11434/api/generate \
  -d '{"model":"<model>","prompt":"","keep_alive":-1,"stream":false}'
curl -s http://$LLM_HOST:11434/api/ps    # the model must appear here
```
