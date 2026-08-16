# Plan — llm-local-monitor

**Version:** 1.2.2
**Date:** 2026-06-18

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

## Milestone: v1.2.1 — Light theme & theme toggle

**Status:** ✅ Done (released 2026-05-25)

| # | Task | Status |
|---|------|--------|
| 1 | Light theme — Blue-Gray palette (GitHub-like) via CSS custom properties | ✅ Done |
| 2 | Theme toggle button — round ☀/☽ icon in header | ✅ Done |
| 3 | Auto-detect from OS `prefers-color-scheme` on first visit | ✅ Done |
| 4 | Preference persisted to `localStorage`; live sync when OS changes | ✅ Done |
| 5 | Structural overrides for hardcoded dark colors (SVG, header, bar tracks, table dividers) | ✅ Done |

---

## Milestone: v1.2.2 — Update Ollama button in SERVER card

**Status:** ✅ Done (released 2026-06-18)

| # | Task | Status |
|---|------|--------|
| 1 | "Update Ollama" button in SERVER card, under "Restart Ollama" | ✅ Done |
| 2 | Button enabled only when host online + `ollamaApp.upgradeAvailable`; greyed out otherwise (Wake-button pattern) | ✅ Done |
| 3 | Reuses `/api/upgrade-ollama`; `upgradeOllamaApp(msgId)` routes feedback to the SERVER card while the badge keeps its own | ✅ Done |

---

## Milestone: v1.3.0 — GPU process modal

**Status:** ✅ Done (released 2026-07-04)

| # | Task | Status |
|---|------|--------|
| 1 | `gpuProcs` collector: per-GPU process list via SSH (nvidia-smi + /proc cgroup + midclt app.query name enrichment) | ✅ Done |
| 2 | `/api/gpu-procs` endpoint; `gpuProcs` aggregated into `/api/status`; `hasOllama` derived from it (gpu.js single query) | ✅ Done |
| 3 | Clickable, keyboard-operable GPU cards → live-refreshing modal (Container/Binary/PID/VRAM) | ✅ Done |
| 4 | User acceptance test on target server (Dockge) | ✅ Done |

Spec: `docs/superpowers/specs/2026-07-04-gpu-process-modal-design.md`

---

## Milestone: v1.4.0 — Model load / unload

**Status:** ✅ Done (released 2026-08-17)

| # | Task | Status |
|---|------|--------|
| 1 | `ollamaModels` collector + `GET /api/models` (Ollama `/api/tags`); `npm test` via `node:test` | ✅ Done |
| 2 | `loadModel` / `unloadModel` actions + POST endpoints, validated against the installed list | ✅ Done |
| 3 | Per-row Unload button in LOADED MODELS + pending-load ghost row persisted in `localStorage` | ✅ Done |
| 4 | Model browser modal: catalog, filter, manual ↻, residency markers | ✅ Done |
| 5 | End-to-end verification in browser (load, F5 mid-load, failure paths, external changes) | ✅ Done |
| 6 | Documentation | ✅ Done |
| 7 | Reverse proxy check — Nginx at `ollama-monitor.techgraft.net`; a 504 does **not** cancel the load, only the UI feedback. 502/504 now handled as "still watching" | ✅ Done |
| 8 | Raise `proxy_read_timeout` to 1800 s in Nginx (cosmetic, not required) | ⬜ To do |
| 9 | User acceptance test on target server (Dockge, `#dev` build) | ✅ Done |
| 10 | Fixes found during acceptance: embedding models rejected by `/api/generate`, proxy 502/504 misreported as failure, RAM panel using `MemFree`, `Expires` glyph illegible | ✅ Done |

Spec: `docs/superpowers/specs/2026-08-16-model-load-unload-design.md`
Plan: `docs/superpowers/plans/2026-08-16-model-load-unload.md`

---

## v2 Backlog (after v1 stabilization)

- [ ] SQLite: per-minute GPU/memory samples, 7-day retention
- [ ] Sparkline charts in UI (GPU%, VRAM, temp history)
- [ ] Alerts: notify when GPU temp > 85°C or VRAM > 90%
- [ ] `/metrics` endpoint for Prometheus (optional)
- [ ] Multi-host support (multiple GPU servers)
