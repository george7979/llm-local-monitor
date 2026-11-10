# Product Requirements Document — llm-local-monitor

**Version:** 1.5.0
**Date:** 2026-08-17
**Author:** Jerzy Maczewski
**Purpose:** Web dashboard for monitoring a GPU server running Ollama or llama.cpp

---

## Executive Summary

The dashboard replaces manual SSH-ing to the GPU server (`$LLM_HOST`) to check the state of loaded LLM models, GPU utilization, and RAM allocation. It also provides power control buttons (wake/shut down) and restart of the active LLM engine (Ollama or llama.cpp), plus a switch between the two — without opening a terminal.

---

## Problem Statement

### Current challenges

- Checking loaded models requires manually logging into the TrueNAS App console
- GPU monitoring requires a dedicated terminal window running `watch -n 2 nvidia-smi`
- Viewing RAM breakdown requires navigating to the TrueNAS UI dashboard
- Waking the server requires knowing the IPMI command and BMC address
- No centralized view of LLM server state

### Context

- The GPU server is often asleep between LLM sessions — woken via IPMI
- Machine is accessible only on the local network
- The sole user is the owner

---

## Target Users

### Primary User

Owner/operator — the only person using the tool. Needs a quick view of server state before and during an LLM session, without opening separate terminals.

---

## Functional Requirements

### FR1: Real-time monitoring

- **FR1.1** Display host status (online/offline)
- **FR1.1a** Detect the active engine (Ollama or llama.cpp) from the state of its TrueNAS app and show that engine's model, app stats and GPU badge. llama.cpp is optional: without `LLAMACPP_APP_NAME` the dashboard is Ollama-only
- **FR1.2** Display list of actively loaded LLM models with parameters. Ollama: size, quantization, GPU/CPU usage, context, expiry time. llama.cpp: alias, parameter count, quantization, VRAM, context, plus generation speed (live while generating, last request when idle) and MTP draft acceptance rate
- **FR1.3** Display GPU stats: utilization, VRAM, temperature, power draw
- **FR1.4** Display RAM breakdown: free / ZFS ARC / services
- **FR1.5** Display the active engine's container stats: CPU%, RAM, Block I/O, Network, app status, version, update availability. With llama.cpp also context fill per slot and the server's launch parameters
- **FR1.6** Auto-refresh every N seconds without user interaction (configurable via `POLL_INTERVAL_SEC`)
- **FR1.7** Display IPMI/network reachability status in header — `Reachable / Unreachable` based on TCP probe, independent from OS state
- **FR1.8** Display server uptime in SERVER card
- **FR1.9** Display LAN port throughput as live histograms (optional widget, requires configuration)
- **FR1.10** Show which workload occupies each GPU: clicking a GPU card opens a modal listing all compute processes on that card with a **meaningful name** (TrueNAS app / container name, e.g. `ollama`, `llama-cpp`) instead of a raw binary path, plus PID and VRAM usage; the list live-refreshes while open

### FR2: Server control

- **FR2.1** **Wake** button — remotely powers on the server via BMC
- **FR2.2** **Shut down** button — gracefully shuts down the server
- **FR2.3** **Restart <engine>** button — restarts the active engine's app (Ollama or llama.cpp) in any state without rebooting the server; disabled when no engine is active
- **FR2.3a** **Engine switch** (`Ollama | llama.cpp`) in the SERVER card — stops the other engine's app and starts the chosen one, so at most one engine holds the GPUs. Shown only when llama.cpp is configured
- **FR2.4** Buttons enabled/disabled based on host state
- **FR2.5** **Update all apps** — triggers an upgrade of *every* TrueNAS app with an update waiting, via midclt, except the engine apps that are not the active one (upgrading a stopped app may start it and put both engines on the same GPUs; both are skipped when none is active, and the action refuses when the engine state cannot be read). Available both as the pulsing `⬆ Update` badge in the engine app card and as an **Update all apps** button in the SERVER card. Both are gated on the *active* engine's own upgrade flag: that engine needing an update is the occasion to sweep the rest, so the button is greyed out when it is current (same pattern as the Wake button). The other apps are enumerated server-side at click time and named back in the result line, together with any skipped engine app that had an update pending

### FR3: Navigation

- **FR3.1** Clickable host IP in header opens TrueNAS web UI (URL configurable via `TRUENAS_URL`)

### FR3: Accessibility

- **FR3.1** No authentication — internal tool, accessed from local network
- **FR3.2** No public exposure — local network only

### FR4: Appearance

- **FR4.1** Dashboard supports light and dark themes
- **FR4.2** Theme auto-detected from OS `prefers-color-scheme` on first visit; no configuration required
- **FR4.3** User can manually toggle theme via a button in the header; preference persisted across sessions

---

## Non-functional Requirements

- **NFR1** Dashboard response time < 1 s when host is online
- **NFR2** When host is offline: panel updated in < 5 s
- **NFR3** Single-page — works in any modern browser without installation
- **NFR4** Docker container — restart: unless-stopped, survives Dockge host restarts

---

## Success Metrics

- **M1** No need to open an SSH terminal to check LLM server state
- **M2** Time to "is the model loaded?" information < 5 s from opening the browser
- **M3** Wake/Shut down/Restart engine/Switch engine works from the dashboard without additional steps

---

## Constraints & Assumptions

- **C1** Availability: monitor works on local network only
- **C2** GPU server must have an authorized SSH key for the admin account
- **A1** GPU server is reachable via SSH when powered on
- **A2** NVIDIA drivers are installed on the TrueNAS CE host

---

## Out of Scope (v1)

- Historical metrics / charts (v2)
- Push notifications (email, Telegram)
- Monitoring other hosts
- Changing the llama.cpp model or start flags, and load / unload for llama.cpp (the model lives as long as its container); engines other than Ollama and llama.cpp
- Public exposure
- System log streaming
