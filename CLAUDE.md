# CLAUDE.md — llm-local-monitor

Instrukcje specyficzne dla projektu. Nadpisują reguły workspace gdzie jest konflikt.

## Working Directory

```
(project root)
```

Zawsze weryfikuj `pwd` przed operacjami na plikach.

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

# Po zmianie kodu:
docker compose build && docker compose up -d

# Test API (brak auth — otwarte endpointy)
curl http://localhost:3788/healthz
curl http://localhost:3788/api/status
curl http://localhost:3788/api/gpu
curl http://localhost:3788/api/ollama-app
```

---

## Project Overview

Dashboard do monitorowania serwera TrueNAS z GPU i Ollamą (host z env `LLM_HOST`).

- **Backend:** Express 5 ESM, dane przez SSH (nvidia-smi, cgroups, midclt) i Ollama REST API
- **Frontend:** vanilla HTML/CSS/JS, polling co 5s, brak auth
- **Deploy:** Docker container na hoście Dockge, port 3788

---

## Architecture Notes

- `src/config.js` — ładuje dotenv + waliduje env vars; importuj zamiast bezpośredniego dotenv
- `src/lib/cache.js` — TTL 2s in-memory; cache key per collector/route
- `src/lib/ssh.js` — `sshExec(cmd)` → promisified execFile z SSH args
- `src/collectors/` — zawsze zwracają dane z cache (`cached('key', 2000, fn)`)
- `src/collectors/ollama.js` — używa Ollama REST API (`/api/ps`), NIE SSH
- `src/collectors/ollamaApp.js` — SSH midclt (app status) + cgroup files (CPU/RAM/IO/Net)
- `src/actions/` — NIE cachowane; każde wywołanie = realna akcja
- `src/routes.js` — `/api/status` agreguje collectors przez `Promise.all`; gdy host offline → SSH collectors pominięte

## Ważne gotchas

- **SSH key** — w kontenerze `/root/.ssh/id_ed25519` (dekodowany z `SSH_PRIVATE_KEY_B64` przez `entrypoint.sh`)
- **OLLAMA_APP_NAME** — domyślnie `ollama`; zmień jeśli TrueNAS App ma inną nazwę
- **IPMI_PASS** — wymagany w `.env`; credentials w `.env` NIE w kodzie
- **nvidia-smi** — na hoście TrueNAS Scale; może wymagać weryfikacji dostępności
- **ZFS arcstats** — `/proc/spl/kstat/zfs/arcstats`; jeśli brak → memory.arc = 0
- **CPU%** — podzielone przez `nproc` żeby zgadzało się z wyświetlaniem TrueNAS (% całości CPU)

---

## CKM Documentation

| Dokument | Cel |
|----------|-----|
| `docs/PRD.md` | CO i DLACZEGO — business requirements |
| `docs/PLAN.md` | KIEDY — fazy, status, backlog |
| `docs/TECH.md` | JAK — architektura, komendy, troubleshooting |

---

## Environment Variables

Patrz `.env.example` — zawsze `config({ path: '.env', override: true })` (workspace CLAUDE.md wymóg).

## Do NOT Modify

- `src/lib/cache.js` — prosta implementacja TTL, nie komplikować
- `entrypoint.sh` — dekoduje SSH key przy starcie kontenera
