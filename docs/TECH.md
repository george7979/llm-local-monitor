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
  ├── GET /api/status   → collectors in parallel (cached 2s)
  ├── POST /api/wake    → ipmitool → $IPMI_HOST
  ├── POST /api/sleep   → ipmitool power soft → $IPMI_HOST
  └── POST /api/restart-ollama → SSH → midclt call app.restart
        ↓ SSH (ed25519, decoded from SSH_PRIVATE_KEY_B64)
  $LLM_HOST ($LLM_USER)
```

---

## Key technical decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Ollama data source | REST API `:11434/api/ps` | `ollama` is not in `truenas_admin` PATH; API returns richer data (VRAM, context, quantization) |
| Container stats | SSH → `/sys/fs/cgroup/docker/<id>/` | TrueNAS REST API does not expose cgroup stats; midclt over SSH gives status + cgroups in a single SSH call |
| SSH key in container | Base64 in `SSH_PRIVATE_KEY_B64` | Dockge does not support easy file mounting; base64 in `.env` = full configuration via UI |
| CPU% Ollama App | `usage_usec / (wall_usec × nproc) × 100` | `usage_usec` sums across all cores; without `nproc` values exceed 100% |

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
| `HOST_PORT` | Port on Dockge host (default: 3788) | optional |
| `OLLAMA_BASE_URL` | Ollama API URL (default: `http://$LLM_HOST:11434`) | optional |
| `OLLAMA_APP_NAME` | TrueNAS App name for Ollama (default: `ollama`) | optional |
| `IPMI_INTERFACE` | ipmitool interface (default: `lanplus`, use `lan` for IPMI v1.5) | optional |
| `WAKE_CMD` | Custom wake command — overrides ipmitool default | optional |
| `SLEEP_CMD` | Custom shutdown command — overrides ipmitool default | optional |
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
