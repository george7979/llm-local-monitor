# Technical Reference — llm-local-monitor

**Stack:** Node 22-alpine, Express 5 ESM, vanilla HTML/CSS/JS
**Deploy:** Docker container na hoście Dockge (`<DOCKGE_HOST>`) przez Dockge
**Target:** TrueNAS GPU server (`$LLM_HOST`) — GPU server z Ollamą

---

## Architecture

```
Browser (sieć lokalna)
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

## Kluczowe decyzje techniczne

| Decyzja | Wybór | Dlaczego |
|---------|-------|----------|
| Źródło danych Ollama | REST API `:11434/api/ps` | `ollama` nie jest w PATH `truenas_admin`; API zwraca bogatsze dane (VRAM, context, quantization) |
| Statystyki kontenera | SSH → `/sys/fs/cgroup/docker/<id>/` | TrueNAS REST API nie udostępnia cgroup stats; midclt przez SSH daje status + cgroups = jedno SSH |
| SSH key w kontenerze | Base64 w `SSH_PRIVATE_KEY_B64` | Dockge nie umożliwia łatwego montowania plików; base64 w `.env` = pełna konfiguracja przez UI |
| CPU% Ollama App | `usage_usec / (wall_usec × nproc) × 100` | `usage_usec` to suma po wszystkich rdzeniach; bez `nproc` wartości przekraczają 100% |

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

Skopiuj `.env.example` → `.env` i uzupełnij:

| Var | Opis | Wymagany |
|-----|------|---------|
| `LLM_HOST` | IP serwera GPU (TrueNAS) | ✅ |
| `LLM_USER` | SSH user na serwerze | ✅ |
| `SSH_PRIVATE_KEY_B64` | Klucz prywatny SSH zakodowany base64 | ✅ |
| `IPMI_HOST` | IP modułu BMC/IPMI serwera | ✅ |
| `IPMI_USER` | IPMI user | ✅ |
| `IPMI_PASS` | IPMI hasło | ✅ |
| `HOST_PORT` | Port na hoście Dockge (default: 3788) | opcja |
| `OLLAMA_BASE_URL` | Ollama API URL (default: `http://$LLM_HOST:11434`) | opcja |
| `SSH_KEY_PATH` | Ścieżka klucza w kontenerze (default: `/root/.ssh/id_ed25519`) | opcja |

Generuj `SSH_PRIVATE_KEY_B64`:
```bash
cat ~/.ssh/id_ed25519 | base64 -w 0
```

---

## Jak klucz SSH trafia do kontenera

`entrypoint.sh` przy każdym starcie kontenera dekoduje `SSH_PRIVATE_KEY_B64` z `.env`
do pliku `/root/.ssh/id_ed25519` z chmod 600. Kontener może potem SSH-ować do `$LLM_USER@$LLM_HOST`.

Klucz publiczny musi być wcześniej dodany do `$LLM_USER` na serwerze:

```bash
# 1. Sprawdź lub wygeneruj klucz
ls ~/.ssh/id_ed25519 || ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ""

# 2. Dodaj do authorized_keys na serwerze GPU
ssh-copy-id -i ~/.ssh/id_ed25519.pub $LLM_USER@$LLM_HOST
# lub ręcznie:
cat ~/.ssh/id_ed25519.pub | ssh $LLM_USER@$LLM_HOST 'cat >> ~/.ssh/authorized_keys'

# 3. Weryfikacja
ssh -o BatchMode=yes $LLM_USER@$LLM_HOST "echo OK"
```

---

## Deploy przez Dockge

**Dwa pliki — tylko YAML + .env w Dockge UI.** Docker BuildKit buduje obraz z GitHub.

### 1. W Dockge UI: New Stack

Nazwa: `llm-local-monitor`. Wklej YAML:

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

### 2. .env stacka

```
LLM_HOST=<IP serwera GPU>
LLM_USER=truenas_admin
SSH_PRIVATE_KEY_B64=<cat ~/.ssh/id_ed25519 | base64 -w 0>

IPMI_HOST=<IP modułu BMC>
IPMI_USER=ADMIN
IPMI_PASS=<hasło>

# Opcjonalne — domyślnie http://<LLM_HOST>:11434
# OLLAMA_BASE_URL=<http://LLM_HOST:port>

HOST_PORT=3788
PORT=3000
TZ=Europe/Warsaw
```

### 3. Deploy

Kliknij **Deploy**. Dashboard: `http://<DOCKGE_HOST>:3788`

### Aktualizacja po zmianach w kodzie

W Dockge: **Restart** — `no_cache: true` + `pull_policy: build` pobiera świeży kod z GitHub.

---

## Weryfikacja (lokalnie)

```bash
# Healthcheck
curl http://localhost:3788/healthz
# → {"ok":true}

# Status serwera
curl http://localhost:3788/api/status | python3 -m json.tool

# Poszczególne panele
curl http://localhost:3788/api/ollama
curl http://localhost:3788/api/gpu
curl http://localhost:3788/api/memory
curl http://localhost:3788/api/ollama-app

# Test akcji (ostrożnie!)
curl -X POST http://localhost:3788/api/wake
```

---

## Troubleshooting

| Problem | Diagnoza | Rozwiązanie |
|---------|----------|-------------|
| SSH: Permission denied | Klucz publiczny nie dodany do `authorized_keys` | Patrz sekcja _Jak klucz SSH trafia do kontenera_ |
| SSH: key file not accessible | `SSH_PRIVATE_KEY_B64` pusty lub błędny | Sprawdź: `echo $SSH_PRIVATE_KEY_B64 \| base64 -d \| head -1` powinno zaczynać się od `-----BEGIN` |
| Ollama panel pusty / błąd | Ollama API niedostępne | Sprawdź: `curl http://$LLM_HOST:11434/api/ps` — powinno zwrócić JSON z `models` |
| nvidia-smi: not found | Brak sterownika NVIDIA na hoście | Sprawdź: `ssh $LLM_USER@$LLM_HOST which nvidia-smi` |
| ipmitool error | Zły `IPMI_HOST`, user lub pass | Test: `ipmitool -I lanplus -H $IPMI_HOST -U $IPMI_USER -P $IPMI_PASS chassis status` |
| Memory arc = 0 | `/proc/spl/kstat/zfs/arcstats` niedostępne | Sprawdź: `ssh $LLM_USER@$LLM_HOST lsmod \| grep zfs` |
| ollamaApp: parse error | `midclt` nie zainstalowane lub brak uprawnień | Test: `ssh $LLM_USER@$LLM_HOST midclt call core.ping` |
