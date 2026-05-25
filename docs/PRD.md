# Product Requirements Document — llm-local-monitor

**Version:** 1.2.1
**Date:** 2026-05-25
**Author:** Jerzy Maczewski
**Purpose:** Web dashboard for monitoring a GPU server running Ollama

---

## Executive Summary

The dashboard replaces manual SSH-ing to the GPU server (`$LLM_HOST`) to check the state of loaded LLM models, GPU utilization, and RAM allocation. It also provides power control buttons (wake/shut down) and Ollama service restart — without opening a terminal.

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
- **FR1.2** Display list of actively loaded LLM models with parameters (size, quantization, GPU/CPU usage, context, expiry time)
- **FR1.3** Display GPU stats: utilization, VRAM, temperature, power draw
- **FR1.4** Display RAM breakdown: free / ZFS ARC / services
- **FR1.5** Display Ollama container stats: CPU%, RAM, Block I/O, Network, app status, version, update availability
- **FR1.6** Auto-refresh every N seconds without user interaction (configurable via `POLL_INTERVAL_SEC`)
- **FR1.7** Display IPMI/network reachability status in header — `Reachable / Unreachable` based on TCP probe, independent from OS state
- **FR1.8** Display server uptime in SERVER card
- **FR1.9** Display LAN port throughput as live histograms (optional widget, requires configuration)

### FR2: Server control

- **FR2.1** **Wake** button — remotely powers on the server via BMC
- **FR2.2** **Shut down** button — gracefully shuts down the server
- **FR2.3** **Restart Ollama** button — restarts the Ollama service without rebooting the server
- **FR2.4** Buttons enabled/disabled based on host state
- **FR2.5** **Upgrade Ollama** — clicking the pulsing `⬆ Update` badge in OLLAMA APP card triggers upgrade via TrueNAS midclt

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
- **M3** Wake/Shut down/Restart Ollama works from the dashboard without additional steps

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
- Public exposure
- System log streaming
