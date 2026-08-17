# Design Spec: GPU Process Modal (per-card process list with container names)

**Date:** 2026-07-04
**Status:** Approved

---

## Goal

Make each GPU card in the dashboard clickable. Clicking opens a modal listing all compute
processes running on that GPU, enriched with **container names** instead of only the raw
executable path that `nvidia-smi` reports (e.g. `/usr/bin/python3`). Names are resolved to
**TrueNAS app names** (e.g. `ollama`) via `midclt call app.query` —
verified on the live host 2026-07-04 (`docker ps` is not accessible to `truenas_admin`).
Raw binary name remains as fallback for processes that are not in a container or when
enrichment fails.

---

## Decisions Made

| Topic | Decision |
|-------|----------|
| Workload environment | All GPU workloads run in Docker containers (TrueNAS Apps / Dockge) — container name is the primary display name |
| Data freshness | Live — process data joins the existing `/api/status` 5 s polling; modal refreshes while open |
| GPU card visuals | Unchanged — `OLLAMA` badge stays as-is; card only gains `cursor: pointer` + subtle hover |
| Enrichment strategy | **Approach A** — single SSH round-trip running a small bash pipeline on the host |
| Fallback | `container: null` → frontend shows basename of the binary path |

---

## Architecture

```
[TrueNAS host]                                [llm-local-monitor container]
nvidia-smi compute-apps ─┐
/proc/<pid>/cgroup       ├─ one bash script ──SSH──▶ collectors/gpuProcs.js ──▶ routes.js
midclt app.query (ID→name)┘                          (cached 2 s)               /api/status
                                                                                   │
                                              public/app.js ◀── polling 5 s ──────┘
                                              GPU card (click) → modal with process table
```

### Host-side pipeline (single `sshExec` call)

1. `nvidia-smi --query-compute-apps=gpu_bus_id,pid,process_name,used_gpu_memory --format=csv,noheader,nounits`
2. For each PID: read `/proc/<PID>/cgroup`, extract the 64-hex Docker container ID
   (verified live format: `0::/docker/<64-hex-id>`)
3. `midclt call app.query` → JSON with `active_workloads.container_details[].id` per app →
   ID→app-name map (built with a small embedded python3 snippet; `docker ps` is NOT usable —
   `truenas_admin` has no access to `/var/run/docker.sock` and no passwordless sudo)
4. Emit one TSV line per process: `bus_id \t pid \t container_name \t binary_path \t vram_mb`
   (`container_name` = `-` when unresolved)

Note: multi-container apps map all their containers to the app name (per-service granularity
via `service_name` exists in `container_details` but is YAGNI for now). `midclt call app.query`
takes ~1-2 s on the host — acceptable within the 2 s collector cache.

PIDs reported by nvidia-smi are host-namespace PIDs, and `/proc/<PID>/cgroup` read on the
host contains the container's cgroup path — this is why the whole mapping must happen
host-side in one session.

### New collector — `src/collectors/gpuProcs.js`

- `cached('gpuProcs', 2_000, fn)` like other collectors
- Returns `{ procs: [{ busId, pid, container, binary, vramMb }] }`
- `container` is a string or `null`

### Changes to existing code

- **`src/collectors/gpu.js`** — remove the second `nvidia-smi --query-compute-apps` call
  and the `hasOllama` computation. Collector returns hardware data only.
- **`src/routes.js`** — add `gpuProcs` to the `/api/status` `Promise.all` aggregate
  (skipped when host is offline, like other SSH collectors). Derive `hasOllama` per GPU by
  matching `gpuProcs` entries on `busId` where `container` or `binary` contains `ollama`
  (case-insensitive). Net SSH calls per cycle: unchanged (one query replaced by another).

### Frontend — `public/app.js`, `public/index.html`, `public/styles.css`

- GPU card: `cursor: pointer`, subtle hover style, click handler opens modal
- Modal: styled like the existing dashboard (dark/light theme aware), title = GPU name + index,
  table columns: **CONTAINER | BINARY | PID | VRAM**
- Binary shown as basename (`/usr/bin/ollama` → `ollama`); full path in `title` attribute
- Modal reads from the latest polling snapshot → auto-refreshes every 5 s while open
- Empty list → "No processes"; closes on ✕, backdrop click, and Escape

---

## Error Handling

| Failure | Behavior |
|---------|----------|
| PID→container mapping fails (host process, unknown cgroup) | `container: null`, frontend falls back to binary basename |
| `midclt call app.query` fails/unavailable | All entries keep `container: null`; list still renders (degradation, not failure) |
| Process exits between nvidia-smi and cgroup read | Script skips that PID, continues |
| Host offline | Collector skipped; card not clickable data-wise → modal shows "Host unavailable" |
| GPU with no processes | Modal shows "No processes" |

---

## Testing

No automated test framework in this project; manual verification per existing convention:

1. Test the bash pipeline standalone over SSH on the live host first
2. `curl http://localhost:3788/api/status` → verify new `gpuProcs` section and `hasOllama` still correct
3. Dashboard click-through: GPU with a loaded Ollama model (container name visible),
   GPU with no processes, host offline case
4. Verify `OLLAMA` badge behavior is unchanged after the `gpu.js` refactor
