# CLAUDE.md — llm-local-monitor

Project-specific instructions. Override workspace rules where there is a conflict.

## Working Directory

```
(project root)
```

Always verify `pwd` before file operations.

---

## Key Commands

```bash
# Dev (hot-reload)
npm run dev

# Docker local
docker compose build
docker compose up -d
docker compose logs -f
docker compose down

# After code changes (local Docker only):
docker compose build && docker compose up -d

# API test (no auth — open endpoints)
curl http://localhost:3788/healthz
curl http://localhost:3788/api/status
curl http://localhost:3788/api/gpu
curl http://localhost:3788/api/engine-app
curl http://localhost:3788/api/models-loaded

# Engine actions move the GPUs on the live server — only with the owner's go-ahead
curl -X POST http://localhost:3788/api/switch-engine -H 'Content-Type: application/json' -d '{"target":"llamacpp"}'   # or "ollama"
curl -X POST http://localhost:3788/api/restart-engine
```

---

## Project Overview

Dashboard for monitoring a TrueNAS GPU server running Ollama or llama.cpp, one at a time (host from env `LLM_HOST`).

- **Backend:** Express 5 ESM, data via SSH (nvidia-smi, cgroups, midclt), Ollama REST API and llama-server HTTP
- **Frontend:** vanilla HTML/CSS/JS, polling every 5s, no auth
- **Deploy:** Docker container on Dockge host, port 3788
- **Deploying a change (dev or release):** in Dockge press **Update** on the stack — it rebuilds from GitHub (`no_cache: true` + `pull_policy: build`); **Restart** keeps the old code. The stack builds from the branch in its compose (`#dev` for acceptance tests, `#main` otherwise). Check with `curl http://<DOCKGE_HOST>:3788/api/config`. Details: README → "Updating after code changes"

---

## Architecture Notes

- `src/config.js` — loads dotenv + validates env vars; import instead of using dotenv directly
- `src/lib/cache.js` — TTL 2s in-memory; cache key per collector/route
- `src/lib/ssh.js` — `sshExec(cmd)` → promisified execFile with SSH args
- `src/collectors/` — always return cached data (`cached('key', 2000, fn)`)
- `src/collectors/ollama.js` — uses Ollama REST API (`/api/ps`), NOT SSH
- `src/collectors/engineApps.js` — the single `app.query` per poll, with the pending TrueNAS jobs in the same ssh command (`getAppsAndJobs()`, cached 2 s; `getApps()` = its app list) and `getEngineState` (active engine, conflict, update flag); `getLaunchInfo` reads llama.cpp launch flags from `app.config` (cached 60 s)
- `src/collectors/engineApp.js` — active engine app: state from `getApps()` + cgroup files over SSH (CPU/RAM)
- `src/collectors/llamacpp.js` — llama-server HTTP (`/props`, `/v1/models`, `/slots`, `/metrics`); keeps the between-poll state, transitions in pure `advance()` of `src/lib/llamacppParse.js`
- `src/lib/engine.js` — pure engine logic, no imports: `pickEngine`, `buildEngine`, `switchPlan`, `restartTarget`, `upgradeSkipList`, `modelsSource`, `annotateGpus`, `engineJobsPending` (TrueNAS jobs still WAITING/RUNNING, any `app.*` method, arguments naming an engine app by exact name), `statusBusy` (`engine.busy`); unit-tested
- `src/lib/truenasJobs.js` — appends `core.get_jobs` to an `app.query` command (one ssh round trip; a failed job read does not fail the app list), parses the output, `refuseWhileEngineJobs` (409 pending job / 503 unreadable). Used by the three engine actions and `getAppsAndJobs()` → `engine.busy`
- `src/lib/engineLock.js` — the one in-memory lock shared by switch, restart and upgrade-apps (409 while another holds it); `engine.switching` / `engine.action` report it. It only sees this monitor's requests — TrueNAS jobs are checked separately (above)
- `src/actions/switchEngine.js` / `restartEngine.js` — fresh `app.query` + pending jobs under the lock; switch stops the other app (awaited), waits 3 s, starts the target (awaited); restart stops (awaited), 3 s, starts (awaited). These and `upgradeApps` take an injectable `exec` — tests must always pass a fake, the default reaches the live server
- `src/actions/upgradeApps.js` — fresh `app.query` (with `state`) under the lock; skips every engine app that is not the active one; with llama.cpp configured also the job check, 503 when either list cannot be read
- `src/collectors/gpuProcs.js` — per-GPU process list via SSH (nvidia-smi + /proc cgroup + midclt app.query); container/app name enrichment; per-GPU `engine` is derived from it in `routes.js` (match by app name only, never binary name)
- `src/collectors/ollamaModels.js` — installed models via Ollama REST `/api/tags`; exports pure `mapTags` / `findModel` (unit-tested in `test/`)
- `src/lib/ollamaClient.js` — `POST /api/generate` with a long-timeout dispatcher, separate from the collectors' 8 s one; used only by model actions
- `src/actions/loadModel.js` / `unloadModel.js` — `keep_alive: -1` loads, `keep_alive: 0` evicts
- `src/actions/` — NOT cached; each call = real action
- `src/routes.js` — `/api/status` aggregates collectors via `Promise.all`; when host offline → SSH collectors skipped

## Important gotchas

- **SSH key** — in container at `/root/.ssh/id_ed25519` (decoded from `SSH_PRIVATE_KEY_B64` by `entrypoint.sh`)
- **OLLAMA_APP_NAME** — default `ollama`; change if TrueNAS App has a different name
- **LLAMACPP_APP_NAME** — unset = llama.cpp support off and the dashboard behaves as Ollama-only; with it set, `LLAMACPP_BASE_URL` defaults to `http://$LLM_HOST:8080` and `llama-server` needs `--metrics`
- **Never switch or restart the engine on the live server during development** without the owner's go-ahead — `switch-engine` and `restart-engine` stop real apps and unload models. Test with unit tests and read-only GET calls
- **llama-server counters** — `/metrics` counters move only when a request finishes, while `/slots` (`n_decoded`) moves during generation; live speed comes from `/slots`, idle speed and MTP % from `/metrics`
- **IPMI_PASS** — required in `.env`; credentials in `.env` NOT in code
- **nvidia-smi** — on TrueNAS CE host; may require availability check
- **ZFS arcstats** — `/proc/spl/kstat/zfs/arcstats`; if absent → memory.arc = 0
- **CPU%** — divided by `nproc` to match TrueNAS display (% of total CPU)
- **Model loading** — Ollama **cancels an in-progress load when the HTTP client disconnects**. `MODEL_ACTION_TIMEOUT_SEC` (default 1800) must outlast the slowest load; lowering it silently throws work away. Never treat the HTTP response as the success signal — a model appearing in `/api/ps` is the only reliable one

---

## CKM Documentation

| Document | Purpose |
|----------|---------|
| `docs/PRD.md` | WHAT & WHY — business requirements |
| `docs/PLAN.md` | WHEN — phases, status, backlog |
| `docs/TECH.md` | HOW — architecture, commands, troubleshooting |

---

## Environment Variables

See `.env.example` — always use `config({ path: '.env', override: true })` (workspace CLAUDE.md requirement).

## Release Procedure (dev → main)

1. Bump `package.json` do nowej wersji (np. `1.2.0` → `1.3.0`)
2. Commit: `release: bump to vX.Y.Z`
3. Merge dev → main
4. GitHub release `vX.Y.Z`

**Wersjonowanie:** semver comparison w `checkUpdate.js` — badge pojawia się tylko gdy `latest > current`. Dev może mieć tę samą wersję co ostatni release — nie powoduje fałszywego badge'a.

---

## Do NOT Modify

- `src/lib/cache.js` — simple TTL implementation, do not over-engineer
- `entrypoint.sh` — decodes SSH key on container start
