# Plan — llm-local-monitor

**Version:** 1.1
**Date:** 2026-05-10

---

## Milestone: v1 MVP

**Goal:** Live dashboard with 5 panels + 3 actions (Wake/Sleep/Restart Ollama)
**Status:** ✅ Done

### Phases

| # | Task | Status |
|---|------|--------|
| 1 | Brainstorming + plan approved | ✅ Done |
| 2 | Scaffold: dirs, package.json, Dockerfile, compose | ✅ Done |
| 3 | Backend: server, config, middleware, libs | ✅ Done |
| 4 | Collectors: host, ollama (REST API), gpu, memory, ollamaApp | ✅ Done |
| 5 | Actions: wake (IPMI), sleep (IPMI soft), restart-ollama (midclt) | ✅ Done |
| 6 | Frontend: TrueNAS-style dark dashboard, 5 panels, donut chart | ✅ Done |
| 7 | Local test + git init + push GitHub | ✅ Done |
| 8 | Deploy via Dockge | ✅ Done |
| 9 | Refactor: env vars, removal of private names, security audit | ✅ Done |

---

## Key technical decisions

Implementation details in `docs/TECH.md`. Most important architectural choices:

1. **Ollama data source** — Ollama REST API instead of SSH (see TECH.md)
2. **Container stats** — cgroup + midclt over SSH instead of TrueNAS REST API
3. **SSH key in container** — base64 in `.env` instead of volume mount
4. **CPU%** — normalized by nproc

---

## v2 Backlog (after v1 stabilization)

- [ ] SQLite: per-minute GPU/memory samples, 7-day retention
- [ ] Sparkline charts in UI (GPU%, VRAM, temp history)
- [ ] Alerts: notify when GPU temp > 85°C or VRAM > 90%
- [ ] `/metrics` endpoint for Prometheus (optional)
- [ ] Multi-host support (multiple GPU servers)
