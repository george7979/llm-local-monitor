# Plan — llm-local-monitor

**Version:** 1.2
**Date:** 2026-05-16

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

---

## Milestone: v1.1.x — UI polish & fixes

**Status:** ✅ Done (released 2026-05-12)

| # | Task | Status |
|---|------|--------|
| 1 | LAN Ports widget (histogram, duplex) | ✅ Done |
| 2 | App version badge + auto update check from GitHub | ✅ Done |
| 3 | Mobile responsiveness (hide IP on narrow screens) | ✅ Done |

---

## Milestone: v1.2.0 — IPMI monitoring, uptime, Ollama upgrade

**Status:** ✅ Done (released 2026-05-16)

| # | Task | Status |
|---|------|--------|
| 1 | IPMI pill in header — Reachable/Unreachable (TCP probe, independent from SSH) | ✅ Done |
| 2 | Server uptime in SERVER card | ✅ Done |
| 3 | Upgrade Ollama by clicking the ⬆ Update badge in OLLAMA APP card | ✅ Done |
| 4 | Clickable IP in header → TrueNAS web UI (TRUENAS_URL) | ✅ Done |
| 5 | Semver comparison in update check (badge only when latest > current) | ✅ Done |
| 6 | Brighter secondary text (--dim) + hardcoded color fixes in canvas/SVG | ✅ Done |
| 7 | .env.example reorganized into logical sections | ✅ Done |

---

## v2 Backlog (after v1 stabilization)

- [ ] SQLite: per-minute GPU/memory samples, 7-day retention
- [ ] Sparkline charts in UI (GPU%, VRAM, temp history)
- [ ] Alerts: notify when GPU temp > 85°C or VRAM > 90%
- [ ] `/metrics` endpoint for Prometheus (optional)
- [ ] Multi-host support (multiple GPU servers)
