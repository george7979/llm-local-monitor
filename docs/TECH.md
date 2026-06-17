# Technical Reference — llm-local-monitor

**Stack:** Node 22-alpine, Express 5 ESM, vanilla HTML/CSS/JS
**Deploy:** Docker container on Dockge host (`<DOCKGE_HOST>`) via Dockge
**Target:** TrueNAS GPU server (`$LLM_HOST`) — GPU server running Ollama

---

## Architecture

```
Browser (local network)
  ↓ HTTP :3788 (HOST_PORT)
Container llm-local-monitor (Dockge, <DOCKGE_HOST>)
  ├── GET /api/config          → version, llmHost, truenasUrl, pollIntervalSec
  ├── GET /api/status          → host + ipmi (parallel) + SSH collectors when alive
  ├── GET /api/check-update    → GitHub API (cached 1h server-side)
  ├── POST /api/wake           → ipmitool → $IPMI_HOST
  ├── POST /api/sleep          → ipmitool power soft → $IPMI_HOST
  ├── POST /api/restart-ollama → SSH → midclt call app.stop/start
  └── POST /api/upgrade-ollama → SSH → midclt call app.upgrade
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
| Upgrade Ollama UI triggers | Badge (OLLAMA APP card) + button (SERVER card) | Button mirrors the badge; `disabled` driven by `ollamaApp.upgradeAvailable` (same greying pattern as Wake); `upgradeOllamaApp(msgId)` routes feedback to the calling card |

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
| `POLL_INTERVAL_SEC` | Polling interval in seconds (default: 5) | optional |
| `IPMI_INTERFACE` | ipmitool interface (default: `lanplus`, use `lan` for IPMI v1.5) | optional |
| `WAKE_CMD` | Custom wake command — overrides ipmitool default | optional |
| `SLEEP_CMD` | Custom shutdown command — overrides ipmitool default | optional |
| `NETWORK_PHYS_IFACES` | Comma-separated physical NIC names — enables LAN Ports widget | optional |
| `NETWORK_HOST_IFACE` | Host/bond interface shown as summary row (e.g. `br0`) | optional |
| `NETWORK_LINK_SPEED_MBIT` | Override auto-detected link speed in Mbit/s | optional |
| `SSH_KEY_PATH` | Key path inside container (default: `/root/.ssh/id_ed25519`) | optional |

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
curl http://localhost:3788/api/ollama
curl http://localhost:3788/api/gpu
curl http://localhost:3788/api/memory
curl http://localhost:3788/api/ollama-app

# Action test (be careful!)
curl -X POST http://localhost:3788/api/wake
```

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

## Troubleshooting

| Problem | Diagnosis | Solution |
|---------|-----------|----------|
| SSH: Permission denied | Public key not added to `authorized_keys` | See _How the SSH key gets into the container_ |
| SSH: key file not accessible | `SSH_PRIVATE_KEY_B64` empty or invalid | Check: `echo $SSH_PRIVATE_KEY_B64 \| base64 -d \| head -1` should start with `-----BEGIN` |
| Ollama panel empty / error | Ollama API unavailable | Check: `curl http://$LLM_HOST:11434/api/ps` — should return JSON with `models` |
| nvidia-smi: not found | No NVIDIA driver on host | Check: `ssh $LLM_USER@$LLM_HOST which nvidia-smi` |
| ipmitool error | Wrong `IPMI_HOST`, user or password | Test: `ipmitool -I lanplus -H $IPMI_HOST -U $IPMI_USER -P $IPMI_PASS chassis status` |
| Memory arc = 0 | `/proc/spl/kstat/zfs/arcstats` unavailable | Check: `ssh $LLM_USER@$LLM_HOST lsmod \| grep zfs` |
| ollamaApp: parse error | `midclt` not installed or no permissions | Test: `ssh $LLM_USER@$LLM_HOST midclt call core.ping` |
