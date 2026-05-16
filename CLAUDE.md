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

# After code changes:
docker compose build && docker compose up -d

# API test (no auth — open endpoints)
curl http://localhost:3788/healthz
curl http://localhost:3788/api/status
curl http://localhost:3788/api/gpu
curl http://localhost:3788/api/ollama-app
```

---

## Project Overview

Dashboard for monitoring a TrueNAS GPU server running Ollama (host from env `LLM_HOST`).

- **Backend:** Express 5 ESM, data via SSH (nvidia-smi, cgroups, midclt) and Ollama REST API
- **Frontend:** vanilla HTML/CSS/JS, polling every 5s, no auth
- **Deploy:** Docker container on Dockge host, port 3788

---

## Architecture Notes

- `src/config.js` — loads dotenv + validates env vars; import instead of using dotenv directly
- `src/lib/cache.js` — TTL 2s in-memory; cache key per collector/route
- `src/lib/ssh.js` — `sshExec(cmd)` → promisified execFile with SSH args
- `src/collectors/` — always return cached data (`cached('key', 2000, fn)`)
- `src/collectors/ollama.js` — uses Ollama REST API (`/api/ps`), NOT SSH
- `src/collectors/ollamaApp.js` — SSH midclt (app status) + cgroup files (CPU/RAM/IO/Net)
- `src/actions/` — NOT cached; each call = real action
- `src/routes.js` — `/api/status` aggregates collectors via `Promise.all`; when host offline → SSH collectors skipped

## Important gotchas

- **SSH key** — in container at `/root/.ssh/id_ed25519` (decoded from `SSH_PRIVATE_KEY_B64` by `entrypoint.sh`)
- **OLLAMA_APP_NAME** — default `ollama`; change if TrueNAS App has a different name
- **IPMI_PASS** — required in `.env`; credentials in `.env` NOT in code
- **nvidia-smi** — on TrueNAS CE host; may require availability check
- **ZFS arcstats** — `/proc/spl/kstat/zfs/arcstats`; if absent → memory.arc = 0
- **CPU%** — divided by `nproc` to match TrueNAS display (% of total CPU)

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

⚠️ **ZAWSZE przed merge do main:**

1. Zmień `package.json`: `X.Y.Z-dev` → `X.Y.Z` (usuń suffix `-dev`)
2. Commit: `release: bump to vX.Y.Z`
3. Merge dev → main
4. GitHub release `vX.Y.Z`

**Wersjonowanie:**
- `dev` branch: `package.json` zawsze ma suffix `-dev` (np. `1.2.0-dev`)
- `main` branch: czysta wersja bez suffixu (np. `1.2.0`)
- Suffix `-dev` wyłącza badge update check (`checkUpdate.js` pomija wersje z `-`)
- Semver comparison — badge pojawia się tylko gdy `latest > current` (nie przy zwykłej różnicy)

---

## Do NOT Modify

- `src/lib/cache.js` — simple TTL implementation, do not over-engineer
- `entrypoint.sh` — decodes SSH key on container start
