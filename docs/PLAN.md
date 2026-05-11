# Plan — llm-local-monitor

**Version:** 1.1
**Date:** 2026-05-10

---

## Milestone: v1 MVP

**Cel:** Dashboard live z 5 panelami + 3 akcje (Wake/Sleep/Restart Ollama)
**Status:** ✅ Done

### Fazy

| # | Zadanie | Status |
|---|---------|--------|
| 1 | Brainstorming + plan zatwierdzony | ✅ Done |
| 2 | Scaffold: dirs, package.json, Dockerfile, compose | ✅ Done |
| 3 | Backend: server, config, middleware, libs | ✅ Done |
| 4 | Collectors: host, ollama (REST API), gpu, memory, ollamaApp | ✅ Done |
| 5 | Actions: wake (IPMI), sleep (IPMI soft), restart-ollama (midclt) | ✅ Done |
| 6 | Frontend: TrueNAS-style dark dashboard, 5 paneli, donut chart | ✅ Done |
| 7 | Local test + git init + push GitHub + Forgejo | ✅ Done |
| 8 | Deploy przez Dockge | ✅ Done |
| 9 | Refactor: env vars, usunięcie prywatnych nazw, security audit | ✅ Done |

---

## Kluczowe decyzje techniczne

Szczegóły implementacji w `docs/TECH.md`. Najważniejsze wybory architektoniczne:

1. **Źródło danych Ollama** — Ollama REST API zamiast SSH (patrz TECH.md)
2. **Statystyki kontenera** — cgroup + midclt przez SSH zamiast TrueNAS REST API
3. **SSH key w kontenerze** — base64 w `.env` zamiast volume mount
4. **CPU%** — normalizacja przez nproc

---

## v2 Backlog (po stabilizacji v1)

- [ ] SQLite: minutowe próbki GPU/memory, retention 7 dni
- [ ] Wykresy sparkline w UI (GPU%, VRAM, temp historia)
- [ ] Notyfikacje: alert gdy GPU temp > 85°C lub VRAM > 90%
- [ ] Endpoint `/metrics` dla Prometheus (opcja)
- [ ] Wsparcie dla wielu serwerów GPU (multi-host)
