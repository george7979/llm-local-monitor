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
| 8 | Raise `proxy_read_timeout` to 1800 s in Nginx | ❌ Won't do — decided 2026-08-17. Purely cosmetic: loads complete either way, and "The proxy stopped waiting" after ~60 s is acceptable feedback |
| 9 | User acceptance test on target server (Dockge, `#dev` build) | ✅ Done |
| 10 | Fixes found during acceptance: embedding models rejected by `/api/generate`, proxy 502/504 misreported as failure, RAM panel using `MemFree`, `Expires` glyph illegible | ✅ Done |
| 11 | Point the Dockge stack back at `#main` and rebuild on v1.4.0 | 🚧 Operator, 2026-08-17 |

Spec: `docs/superpowers/specs/2026-08-16-model-load-unload-design.md`
Plan: `docs/superpowers/plans/2026-08-16-model-load-unload.md`

---

## Milestone: v1.5.0 — Update all apps, not just Ollama

**Status:** 🚧 In progress (started 2026-08-17)

Same two triggers, same gating on Ollama's flag — only the action widens. Ollama
needing an update is the occasion to sweep every other TrueNAS app that has one,
so updates on `cloudflared`, `portainer` and friends stop going unnoticed.
Monitoring stays Ollama-only by decision: the app list is read inside the action
at click time, not by a polled collector.

| # | Task | Status |
|---|------|--------|
| 1 | `selectPending` — pure split into chart vs image-only upgrades, unit-tested (`test/upgradeApps.test.js`) | ✅ Done |
| 2 | `upgradeApps` action: `app.query` at call time → `app.upgrade_bulk` + `app.pull_images` | ✅ Done |
| 3 | `POST /api/upgrade-ollama` → `POST /api/upgrade-apps`; old route dropped, no alias | ✅ Done |
| 4 | UI: button label, badge tooltip, confirm text, result line naming the apps upgraded | ✅ Done |
| 5 | Documentation (PRD FR2.5, TECH endpoint + decisions, README) | ✅ Done |
| 6 | End-to-end verification against the live server | ⚠️ Partial — see below |
| 7 | Verify the *enabled* path once any app actually has an update waiting | ⬜ Blocked |
| 8 | Release: bump to v1.5.0, merge dev → main, GitHub release | ⬜ |

**Verification status, 2026-08-17.** All 7 apps on the host were current, so the
disabled/no-op path is proven and the upgrade path is not. Confirmed: 13/13 unit
tests; `app.query` + `selectPending` against the live host returning an empty
selection (so `upgradeApps` early-returns before any mutating midclt call);
`POST /api/upgrade-apps` → `{"ok":true,"jobIds":[],"apps":[]}`; the removed
`POST /api/upgrade-ollama` → 404; the page rendering with **Update all apps**
greyed out and the badge reading `✓ Up to date`, no console errors beyond a
pre-existing missing `favicon.ico`. **Not yet exercised:** `app.upgrade_bulk`,
`app.pull_images`, and the result line naming the upgraded apps — all three need
an app with a pending update.

Rejected during design, recorded so it is not re-litigated:

- **A card listing every app's update state** — would fix the blind spot properly,
  but was deliberately deferred; the data already flows through the action, so it
  stays a pure frontend change if it is ever wanted
- **`snapshot_hostpaths: true`** — see the decision row in `TECH.md`

---

## v2 Backlog (after v1 stabilization)

- [ ] Refresh `pics/dashboard-eng-7.png` — predates v1.4.0, so it shows the LOADED MODELS card without the Unload column or the Models… button (README embeds it at the top)

- [ ] SQLite: per-minute GPU/memory samples, 7-day retention
- [ ] Sparkline charts in UI (GPU%, VRAM, temp history)
- [ ] Alerts: notify when GPU temp > 85°C or VRAM > 90%
- [ ] `/metrics` endpoint for Prometheus (optional)
- [ ] Multi-host support (multiple GPU servers)
