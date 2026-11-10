# Plan — llm-local-monitor

**Version:** 1.5.0
**Date:** 2026-08-17

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
| 11 | Point the Dockge stack back at `#main` and rebuild on v1.4.0 | ✅ Done — later moved to `#dev` again for the v1.5.0 acceptance test |

Spec: `docs/superpowers/specs/2026-08-16-model-load-unload-design.md`
Plan: `docs/superpowers/plans/2026-08-16-model-load-unload.md`

---

## Milestone: v1.5.0 — Update all apps, not just Ollama

**Status:** ✅ Done (released 2026-08-17)

Same two triggers, same gating on Ollama's flag — only the action widens. Ollama
needing an update is the occasion to sweep every other TrueNAS app that has one,
so pending updates elsewhere on the host stop going unnoticed. Whichever apps the
host happens to run are picked up as they are — nothing is named or configured.
At v1.5.0 monitoring was Ollama-only by decision, and the app list was read inside
the action at click time rather than by a polled collector. From v1.6.0 the gating
follows the active engine and the polled `app.query` is shared; the action still
reads the list fresh at click time.

| # | Task | Status |
|---|------|--------|
| 1 | `selectPending` — pure split into chart vs image-only upgrades, unit-tested (`test/upgradeApps.test.js`) | ✅ Done |
| 2 | `upgradeApps` action: `app.query` at call time → `app.upgrade_bulk` + `app.pull_images` | ✅ Done |
| 3 | `POST /api/upgrade-ollama` → `POST /api/upgrade-apps`; old route dropped, no alias | ✅ Done |
| 4 | UI: button label, badge tooltip, confirm text, result line naming the apps upgraded | ✅ Done |
| 5 | Documentation (PRD FR2.5, TECH endpoint + decisions, README) | ✅ Done |
| 6 | End-to-end verification against the live server | ✅ Done |
| 7 | Verify the *enabled* path once any app actually has an update waiting | ✅ Done — user acceptance test on the `#dev` build, 2026-08-17 |
| 8 | Release: bump to v1.5.0, merge dev → main, GitHub release | ✅ Done |
| 9 | Point the Dockge stack back at `#main` and rebuild on v1.5.0 | ✅ Done — `/api/config` reports `1.5.0`, all 9 collectors error-free |

**Verification status, 2026-08-17.** Both paths are proven. The no-op path was
confirmed first, on a host where all 7 apps were current: 13/13 unit tests;
`app.query` + `selectPending` returning an empty selection (so `upgradeApps`
early-returns before any mutating midclt call); `POST /api/upgrade-apps` →
`{"ok":true,"jobIds":[],"apps":[]}`; the removed `POST /api/upgrade-ollama` →
404; the page rendering with **Update all apps** greyed out and the badge
reading `✓ Up to date`, no console errors beyond a pre-existing missing
`favicon.ico`. The upgrade path was then exercised in the user acceptance test
on the `#dev` build once an app had a pending update — `app.upgrade_bulk` /
`app.pull_images` ran and the result line named the apps upgraded.

Rejected during design, recorded so it is not re-litigated:

- **A card listing every app's update state** — would fix the blind spot properly,
  but was deliberately deferred; the data already flows through the action, so it
  stays a pure frontend change if it is ever wanted
- **`snapshot_hostpaths: true`** — see the decision row in `TECH.md`

---

## Milestone: v1.5.1 — UI fixes

**Status:** ✅ Done (released 2026-10-04)

| # | Task | Status |
|---|------|--------|
| 1 | Models modal: scroll on the list, so action messages stay in view; errors in the error colour | ✅ Done |
| 2 | OLLAMA APP card: TrueNAS reports the image pinned by digest (`repo:tag@sha256:…`) — the label shows `repo:tag`, the full reference stays in the tooltip | ✅ Done |
| 3 | Top-row cards get `min-width: 0` — a `1fr` track is `minmax(auto, 1fr)`, so any long nowrap label widened its column and ignored the ellipsis | ✅ Done |
| 4 | Release: bump to v1.5.1, merge dev → main, GitHub release | ✅ Done |
| 5 | Rebuild the Dockge stack on `#main` | ✅ Done — `/api/config` reports `1.5.1`, all 9 collectors error-free |

---

## Milestone: v1.6.0 — llama.cpp as an alternative engine

**Status:** 🔄 Code on `dev`; owner acceptance on the live server open

**Current step.** The owner is testing the `#dev` build on the production
dashboard (the Dockge stack builds `#dev`, see item 15) and will come back with
remarks. Work resumes from those remarks; after them, the acceptance items
below (7–13a), then the release (14–15). The engine app card was reshaped during
this review: no Block I/O / Network, and `KEY  value` entries in two columns
instead of CPU/RAM tiles. Nobody has yet run a real switch, restart or Update
all apps from the dashboard — the first real one is part of the acceptance.
Development rule: no switch or restart of the engine on the live server without
the owner's go-ahead (`CLAUDE.md`).

The dashboard follows whichever engine is active — Ollama or a llama.cpp server
(`llama-server`) run as a second TrueNAS app — and a switch in the SERVER card moves
the GPUs between them. Optional: without `LLAMACPP_APP_NAME` the dashboard behaves as
v1.5.1. Update all apps skips every engine app that is not the active one.

| # | Task | Status |
|---|------|--------|
| 1 | Engine selection from app state (`pickEngine`, conflict tie-break by GPU holder), per-GPU engine badge | ✅ Done |
| 2 | llama-server collector: `/props`, `/v1/models`, `/slots`, `/metrics`; live and last-request speed, MTP %, context fill | ✅ Done |
| 3 | `POST /api/switch-engine`, `POST /api/restart-engine`; engine-aware `/api/status`; renamed routes, no aliases | ✅ Done |
| 4 | Update all apps skips non-active engine apps, refuses (503) when the engine state is unreadable | ✅ Done |
| 5 | UI: engine switch, engine-titled app card (two columns of entries: context, CPU, RAM, slots, threads / split, MTP, KV, batch, reasoning), llama.cpp model card, `LLAMA` badge on narrow screens | ✅ Done |
| 6 | Documentation (PRD, TECH, README, CLAUDE.md) | ✅ Done |
| 7 | Acceptance: switch llama.cpp → Ollama — llama.cpp app STOPPED, Ollama RUNNING, cards and badges follow, Load / Unload work | ⬜ Open |
| 8 | Acceptance: switch back — model row returns after load; switch stays usable while the app is DEPLOYING | ⬜ Open |
| 9 | Acceptance: during a generation live speed with ▶; after it dimmed last-request speed and MTP % | ⬜ Open |
| 10 | Acceptance: with Ollama active and updates pending, Update all apps lights up and works as in v1.5.1; with llama.cpp active the button is grey; an update pending on the stopped engine is named as skipped and the app stays STOPPED | ⬜ Open |
| 11 | Acceptance: restart of the llama.cpp app from the dashboard (stop is awaited, up to ~2 min); launch-parameter line matches the flags the app really runs with | ⬜ Open |
| 12 | Engine actions respect TrueNAS jobs: switch and restart await the start job; switch, restart and Update all apps refuse (409) while a TrueNAS job runs on an engine app, 503 when the job list is unreadable; `engine.busy` in status and UI | ✅ Done |
| 13 | README and PRD FR2.3 describe the refusal rule (in-monitor lock plus TrueNAS jobs) instead of "never overlap" | ✅ Done |
| 13a | Acceptance: an engine action refused while TrueNAS runs a job on an engine app (e.g. restart from the TrueNAS UI, then Switch → 409 naming the job; SERVER card shows `TrueNAS: … on …`). Also confirm on the server what could not be read from job history: the `arguments` of `app.upgrade` / `app.upgrade_bulk` / `app.pull_images` jobs name the app, and `midclt call -j app.start` exits non-zero when the start job fails | ⬜ Open |
| 14 | Release: bump to v1.6.0, merge dev → main, GitHub release (owner's decision) | ⬜ Open |
| 15 | Point the Dockge stack back at `#main` and rebuild on v1.6.0 (since 2026-11-10 it builds `#dev` for the acceptance test, with `LLAMACPP_APP_NAME` / `LLAMACPP_BASE_URL` set in the stack `.env`) | ⬜ Open |

Spec: `docs/superpowers/specs/2026-11-10-llamacpp-engine-design.md`
Plan: `docs/superpowers/plans/2026-11-10-llamacpp-engine.md`

---

## v2 Backlog (after v1 stabilization)

- [ ] SQLite: per-minute GPU/memory samples, 7-day retention
- [ ] Sparkline charts in UI (GPU%, VRAM, temp history)
- [ ] Alerts: notify when GPU temp > 85°C or VRAM > 90%
- [ ] `/metrics` endpoint for Prometheus (optional)
- [ ] Multi-host support (multiple GPU servers)
- [ ] TLS verification for engine HTTP: the Ollama and llama.cpp collectors accept any certificate (`rejectUnauthorized: false`). Verify by default; optional env var with a CA file for a private certificate. No effect on plain `http://` base URLs
