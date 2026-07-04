# GPU Process Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clickable GPU cards opening a live-refreshing modal that lists all compute processes on that GPU, enriched with Docker container names.

**Architecture:** One new SSH collector (`gpuProcs.js`) runs a single bash pipeline on the TrueNAS host (nvidia-smi → /proc/PID/cgroup → docker ps) and returns per-process rows. `routes.js` aggregates it into `/api/status` and derives the existing `hasOllama` flag from it; `gpu.js` loses its second nvidia-smi query. Frontend adds a theme-aware modal fed by the existing 5 s polling.

**Tech Stack:** Express 5 ESM, SSH via `sshExec`, vanilla JS/CSS frontend, Docker deploy.

**Spec:** `docs/superpowers/specs/2026-07-04-gpu-process-modal-design.md`

**Testing note:** This project has no automated test framework (per spec, verification is manual: curl + dashboard click-through). Tasks therefore use *verify* steps instead of TDD test steps.

**Git note:** Commit steps require the user's standing consent for this plan's commits (workspace rule: never commit without consent). Ask once before Task 1's commit.

---

### Task 1: Verify the host-side pipeline standalone over SSH

No repo changes — proves the enrichment works on the live host before writing collector code.

**Files:**
- Create (scratchpad only): `$SCRATCH/gpuprocs.sh` (session scratchpad, NOT in repo)

- [x] **Step 1: Write the pipeline script to the scratchpad**

Content of `$SCRATCH/gpuprocs.sh` (POSIX sh, runs on the TrueNAS host as root):

```sh
apps=$(nvidia-smi --query-compute-apps=gpu_bus_id,pid,process_name,used_gpu_memory --format=csv,noheader,nounits 2>/dev/null) || exit 0
[ -z "$apps" ] && exit 0
map=$(docker ps --no-trunc --format "{{.ID}} {{.Names}}" 2>/dev/null)
echo "$apps" | while IFS= read -r line; do
  bus=${line%%,*}
  rest=${line#*, }
  pid=${rest%%,*}
  rest=${rest#*, }
  mem=${rest##*, }
  name=${rest%, *}
  cid=$(grep -oE "[0-9a-f]{64}" "/proc/$pid/cgroup" 2>/dev/null | head -1)
  cname="-"
  [ -n "$cid" ] && cname=$(printf "%s\n" "$map" | awk -v id="$cid" '$1==id{print $2}')
  [ -z "$cname" ] && cname="-"
  printf "%s\t%s\t%s\t%s\t%s\n" "$bus" "$pid" "$cname" "$name" "$mem"
done
```

Parsing notes: nvidia-smi CSV separator is `", "`. Parameter expansion is used instead of `IFS=,` so a `process_name` containing spaces stays intact (`mem` strips the longest prefix `##*, `, `name` strips the shortest suffix `%, *`).

- [x] **Step 2: Run it on the host via SSH using the project's key**

```bash
cd /home/jerzy/cursor/llm-local-monitor
export $(grep -E '^(LLM_HOST|LLM_USER|SSH_PRIVATE_KEY_B64)=' .env | xargs)
KEY="$SCRATCH/llm-key"
printf '%s' "$SSH_PRIVATE_KEY_B64" | base64 -d > "$KEY" && chmod 600 "$KEY"
ssh -i "$KEY" -o StrictHostKeyChecking=no -o BatchMode=yes "$LLM_USER@$LLM_HOST" "$(cat "$SCRATCH/gpuprocs.sh")"
```

Expected (with an Ollama model loaded): one TSV line per process, e.g.

```
00000000:01:00.0	12345	ix-ollama-ollama-1	/usr/bin/ollama	8432
```

Column 3 must be a real container name (not `-`). If every row shows `-`, inspect `ssh ... "cat /proc/<pid>/cgroup"` and adjust the `grep -oE "[0-9a-f]{64}"` extraction before proceeding.

Also verify the empty case: if no models are loaded, output is empty and exit code is 0.

- [x] **Step 3: Clean up the key file**

```bash
rm -f "$SCRATCH/llm-key"
```

No commit (nothing in repo changed).

> **Execution note (2026-07-04):** verified on the live host with two deviations that are
> folded into Task 2 below: (1) local `.env` uses `SSH_KEY_PATH`, not `SSH_PRIVATE_KEY_B64`
> (the latter exists only inside the container); (2) `docker ps` is not accessible to
> `truenas_admin` (no docker.sock access, no passwordless sudo) — the ID→name map is built
> from `midclt call app.query` instead, yielding TrueNAS app names (`ollama`,
> `whisper-asr-whisperx`), which are nicer labels anyway. Cgroup format confirmed:
> `0::/docker/<64-hex>`. Observed live output: 3 processes, all with resolved names.

---

### Task 2: `gpuProcs` collector + debug endpoint

**Files:**
- Create: `src/collectors/gpuProcs.js`
- Modify: `src/routes.js` (imports + new GET route only; `/api/status` aggregation comes in Task 3)

- [ ] **Step 1: Create `src/collectors/gpuProcs.js`**

⚠️ **Gotcha:** the script lives in a JS template literal, so every shell `${...}` parameter expansion MUST be escaped as `\${...}` or Node will try to interpolate it. `$(...)` needs no escaping.

```js
import { sshExec } from '../lib/ssh.js';
import { cached } from '../lib/cache.js';

// nvidia-smi PIDs are host-namespace PIDs; /proc/<pid>/cgroup read on the host
// contains the Docker container id, resolved to a TrueNAS app name via
// `midclt call app.query` (docker.sock is not accessible to truenas_admin).
const SCRIPT = `
apps=$(nvidia-smi --query-compute-apps=gpu_bus_id,pid,process_name,used_gpu_memory --format=csv,noheader,nounits 2>/dev/null) || exit 0
[ -z "$apps" ] && exit 0
map=$(midclt call app.query 2>/dev/null | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for a in data:
    for c in (a.get("active_workloads") or {}).get("container_details") or []:
        cid = c.get("id")
        name = a.get("name")
        if cid and name:
            print(cid, name)
' 2>/dev/null)
echo "$apps" | while IFS= read -r line; do
  bus=\${line%%,*}
  rest=\${line#*, }
  pid=\${rest%%,*}
  rest=\${rest#*, }
  mem=\${rest##*, }
  name=\${rest%, *}
  cid=$(grep -oE "[0-9a-f]{64}" "/proc/$pid/cgroup" 2>/dev/null | head -1)
  cname="-"
  [ -n "$cid" ] && cname=$(printf "%s\\n" "$map" | awk -v id="$cid" '$1==id{print $2}')
  [ -z "$cname" ] && cname="-"
  printf "%s\\t%s\\t%s\\t%s\\t%s\\n" "$bus" "$pid" "$cname" "$name" "$mem"
done
`;

export function getGpuProcs() {
  return cached('gpuProcs', 2_000, async () => {
    const output = await sshExec(SCRIPT);
    const procs = output.split('\n').filter(Boolean).map(line => {
      const [busId, pid, container, binary, vramMb] = line.split('\t');
      return {
        busId,
        pid: parseInt(pid) || 0,
        container: container === '-' ? null : container,
        binary: binary || '',
        vramMb: parseInt(vramMb) || 0,
      };
    });
    return { procs };
  });
}
```

- [ ] **Step 2: Add the debug endpoint in `src/routes.js`**

Add to the imports block (after the `getGpuStatus` import, line 8):

```js
import { getGpuProcs } from './collectors/gpuProcs.js';
```

Add after the `/gpu` route (line 59):

```js
router.get('/gpu-procs', async (_req, res) => {
  res.json(await safeCollect(getGpuProcs));
});
```

- [ ] **Step 3: Rebuild and verify via curl**

```bash
cd /home/jerzy/cursor/llm-local-monitor
docker compose build && docker compose up -d
sleep 3
curl -s http://localhost:3788/api/gpu-procs | python3 -m json.tool
```

Expected (model loaded):

```json
{
    "procs": [
        {
            "busId": "00000000:02:00.0",
            "pid": 45392,
            "container": "ollama",
            "binary": "/usr/lib/ollama/llama-server",
            "vramMb": 770
        }
    ]
}
```

Expected (no processes): `{"procs": []}`. On SSH failure: `{"error": "..."}` (via `safeCollect`).

- [ ] **Step 4: Commit**

```bash
git add src/collectors/gpuProcs.js src/routes.js
git commit -m "feat: add gpuProcs collector — per-GPU process list with container names"
```

---

### Task 3: Refactor `gpu.js`, aggregate into `/api/status`, derive `hasOllama`

**Files:**
- Modify: `src/collectors/gpu.js:17-48`
- Modify: `src/routes.js:27-47` (`/status` handler)

- [ ] **Step 1: Strip the compute-apps query from `src/collectors/gpu.js`**

Replace the body of `getGpuStatus()` — remove the `Promise.all`, the `appsOutput` query, the `ollamaBusIds` set, and the `hasOllama` property:

```js
export function getGpuStatus() {
  return cached('gpu', 2_000, async () => {
    const output = await sshExec(`nvidia-smi --query-gpu=${QUERY} --format=csv,noheader,nounits`);

    const gpus = output.split('\n').filter(Boolean).map(line => {
      const [index, busId, name, utilization, memUsed, memTotal, temperature, powerDraw, pcieGen, pcieWidth] =
        line.split(', ').map(s => s.trim());
      return {
        index: parseInt(index) || 0,
        busId,
        name,
        utilization: parseInt(utilization) || 0,
        memUsed: parseInt(memUsed) || 0,
        memTotal: parseInt(memTotal) || 0,
        temperature: parseInt(temperature) || 0,
        powerDraw: parseFloat(powerDraw) || 0,
        pcieGen: parseInt(pcieGen) || 0,
        pcieWidth: parseInt(pcieWidth) || 0,
      };
    });
    return { gpus };
  });
}
```

Imports: `Promise.all` gone but both imports (`sshExec`, `cached`) are still used — leave them.

- [ ] **Step 2: Aggregate `gpuProcs` in `/api/status` and derive `hasOllama`**

In `src/routes.js`, replace the `/status` handler body (lines 27-47) with:

```js
router.get('/status', async (_req, res) => {
  const [host, ipmi] = await Promise.all([
    safeCollect(getHostStatus),
    safeCollect(getIpmiStatus),
  ]);
  let ollama = null, gpu = null, gpuProcs = null, memory = null, network = null;

  let uptime = null;
  if (host.alive) {
    [ollama, gpu, gpuProcs, memory, network, uptime] = await Promise.all([
      safeCollect(getOllamaStatus),
      safeCollect(getGpuStatus),
      safeCollect(getGpuProcs),
      safeCollect(getMemoryStatus),
      safeCollect(getNetworkStatus),
      safeCollect(getUptime),
    ]);
  }

  // Derive per-GPU ollama badge from the process list (matches old behavior;
  // false when the process collector failed — badge degrades, card still renders)
  if (gpu?.gpus) {
    for (const g of gpu.gpus) {
      g.hasOllama = !!gpuProcs?.procs?.some(p =>
        p.busId === g.busId &&
        `${p.container || ''} ${p.binary || ''}`.toLowerCase().includes('ollama'));
    }
  }

  const ollamaApp = host.alive ? await safeCollect(getOllamaAppStats) : null;
  res.json({ host, ipmi, uptime, ollama, ollamaApp, gpu, gpuProcs, memory, network });
});
```

- [ ] **Step 3: Rebuild and verify `/api/status`**

```bash
docker compose build && docker compose up -d
sleep 3
curl -s http://localhost:3788/api/status | python3 -c "
import json,sys; d=json.load(sys.stdin)
print('gpuProcs:', json.dumps(d.get('gpuProcs'), indent=2))
print('hasOllama per GPU:', [(g['index'], g['hasOllama']) for g in d['gpu']['gpus']])
"
```

Expected: `gpuProcs.procs` array present; `hasOllama` is `true` exactly for GPUs where an ollama container/binary appears in `procs` (compare with the OLLAMA badge on the dashboard before this change).

- [ ] **Step 4: Verify the badge still renders in the browser**

Open `http://localhost:3788` — GPU running Ollama shows the `OLLAMA` badge exactly as before the refactor.

- [ ] **Step 5: Commit**

```bash
git add src/collectors/gpu.js src/routes.js
git commit -m "refactor: derive hasOllama from gpuProcs; drop duplicate nvidia-smi query"
```

---

### Task 4: Modal markup + CSS

**Files:**
- Modify: `public/index.html` (add modal container before `<script src="app.js">`)
- Modify: `public/styles.css` (append modal section; add `cursor: pointer` to `.gpu-card`)

- [ ] **Step 1: Add modal HTML to `public/index.html`**

Insert between `</main>` (line 101) and `<script src="app.js"></script>` (line 103):

```html
<div class="modal-backdrop" id="gpu-modal" style="display:none">
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="gpu-modal-title">
    <div class="modal-head">
      <div>
        <div class="modal-title" id="gpu-modal-title">—</div>
        <div class="modal-sub" id="gpu-modal-sub"></div>
      </div>
      <button class="modal-close" id="gpu-modal-close" aria-label="Close">&#10005;</button>
    </div>
    <div id="gpu-modal-body"></div>
  </div>
</div>
```

(No inline `onclick` — handlers are attached in app.js in Task 5.)

- [ ] **Step 2: Append modal CSS to `public/styles.css`**

Add at the end of the main (dark) section, before the `[data-theme="light"]` overrides block (which starts around line 550):

```css
/* ── GPU PROCESS MODAL ─────────────────────── */

.gpu-card { cursor: pointer; }

.modal-backdrop {
  position: fixed; inset: 0; z-index: 100;
  background: rgba(0, 0, 0, .55);
  display: flex; align-items: center; justify-content: center;
}
.modal {
  background: var(--card);
  border: 1px solid var(--border2);
  border-radius: var(--r);
  padding: 20px 22px;
  min-width: 420px; max-width: 90vw;
  max-height: 80vh; overflow: auto;
}
.modal-head {
  display: flex; justify-content: space-between; align-items: flex-start;
  gap: 16px; margin-bottom: 14px;
}
.modal-title { font-size: 13px; font-weight: 600; letter-spacing: .05em; }
.modal-sub   { font-family: var(--mono); font-size: 10px; color: var(--dim); margin-top: 2px; }
.modal-close {
  background: none; border: none; color: var(--dim);
  font-size: 16px; line-height: 1; padding: 2px 4px; cursor: pointer;
}
.modal-close:hover { color: var(--text); }
```

Theme awareness is free: `--card`, `--border2`, `--dim`, `--text` are already overridden in the `[data-theme="light"]` block, and the modal table reuses the global `table`/`thead th`/`tbody td` styles (including the light-theme row-divider fix at line ~589).

- [ ] **Step 3: Visual sanity check**

```bash
docker compose build && docker compose up -d
```

In browser devtools console: `document.getElementById('gpu-modal').style.display = 'flex'` — empty modal appears centered, correct colors in both themes (toggle ☀/☾). Set back to `'none'`.

- [ ] **Step 4: Commit**

```bash
git add public/index.html public/styles.css
git commit -m "feat: GPU process modal markup and styles"
```

---

### Task 5: Frontend logic — click, render, live refresh

**Files:**
- Modify: `public/app.js` (snapshot state, `pollAll`, `renderGpu` click handler, new modal functions)

- [ ] **Step 1: Add snapshot state and modal wiring near the top of `app.js`**

After the Helpers section (below line 10):

```js
// ── GPU modal state ──────────────────────────────────────────────────
let gpuModalBusId = null;
let lastGpuSnapshot = { gpu: null, procs: null };
```

- [ ] **Step 2: Feed the snapshot from `pollAll` and refresh an open modal**

In `pollAll()` (line 32), after `renderGpu(data.gpu);` add:

```js
    lastGpuSnapshot = { gpu: data.gpu, procs: data.gpuProcs };
    if (gpuModalBusId) renderGpuModal();
```

- [ ] **Step 3: Make cards clickable in `renderGpu`**

In the `data.gpus.forEach((g) => {` loop, right after `const card = el('div', 'gpu-card');` (line 176), add:

```js
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.addEventListener('click', () => openGpuModal(g.busId));
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openGpuModal(g.busId); }
    });
```

(Keyboard access added per Task 4 code review — cards are divs, so they need `role`/`tabindex`/keydown to be operable without a mouse.)

- [ ] **Step 4: Add modal functions (new section after `makeGpuBar`, ~line 220)**

```js
// ── GPU process modal ─────────────────────────────────────────────────

function openGpuModal(busId) {
  gpuModalBusId = busId;
  renderGpuModal();
  document.getElementById('gpu-modal').style.display = 'flex';
  document.getElementById('gpu-modal-close').focus();
}

function closeGpuModal() {
  gpuModalBusId = null;
  document.getElementById('gpu-modal').style.display = 'none';
}

document.getElementById('gpu-modal-close').addEventListener('click', closeGpuModal);
document.getElementById('gpu-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeGpuModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && gpuModalBusId) closeGpuModal();
});

function renderGpuModal() {
  const { gpu, procs } = lastGpuSnapshot;
  const g = gpu?.gpus?.find(x => x.busId === gpuModalBusId);
  document.getElementById('gpu-modal-title').textContent =
    g ? `${g.name} #${g.index} — processes` : 'GPU processes';
  document.getElementById('gpu-modal-sub').textContent = gpuModalBusId || '';

  const body = document.getElementById('gpu-modal-body');
  body.textContent = '';

  if (!gpu) { body.appendChild(el('span', 'dim-text', 'Host unavailable')); return; }
  if (procs?.error) { body.appendChild(el('span', 'dim-text', 'Process list temporarily unavailable')); return; }

  const list = (procs?.procs || []).filter(p => p.busId === gpuModalBusId);
  if (!list.length) { body.appendChild(el('span', 'dim-text', 'No processes')); return; }

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  ['Container', 'Binary', 'PID', 'VRAM'].forEach(h => hr.appendChild(el('th', null, h)));
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const p of list) {
    const tr = document.createElement('tr');
    const basename = (p.binary || '').split('/').pop() || '—';
    const cells = [
      ['td-model', p.container || '—', null],
      ['td-mono',  basename, p.binary || null],
      ['td-mono',  String(p.pid), null],
      ['td-mono',  p.vramMb ? p.vramMb.toLocaleString() + ' MB' : '—', null],
    ];
    cells.forEach(([cls, val, title]) => {
      const td = document.createElement('td');
      td.className = cls;
      td.textContent = val;
      if (title) td.title = title;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  body.appendChild(table);
}
```

Fallback per spec: `container` null → `—` in the Container column; the Binary column always shows the basename with the full path in the tooltip.

- [ ] **Step 5: Rebuild and click-test**

```bash
docker compose build && docker compose up -d
```

Checklist in browser (`http://localhost:3788`):
1. Click a GPU card running Ollama → modal shows app name (e.g. `ollama`), binary basename (e.g. `llama-server`), PID, VRAM in MB
2. Leave modal open ≥10 s → VRAM value updates with polling (load/unload a model to see change)
3. Click a GPU card with no processes → "No processes"
4. Close via ✕, backdrop click, and Escape — all three work
5. Toggle light theme with modal open → colors correct
6. `OLLAMA` badge on cards unchanged

- [ ] **Step 6: Commit**

```bash
git add public/app.js
git commit -m "feat: clickable GPU cards open live process modal"
```

---

### Task 6: Documentation + end-to-end verification

**Files:**
- Modify: `CLAUDE.md` (Architecture Notes)
- Modify: `docs/TECH.md` (architecture section — match its existing structure when editing)

- [ ] **Step 1: Add collector to `CLAUDE.md` Architecture Notes**

After the line describing `src/collectors/ollamaApp.js` add:

```markdown
- `src/collectors/gpuProcs.js` — per-GPU process list via SSH (nvidia-smi + /proc cgroup + docker ps); container name enrichment; `hasOllama` is derived from it in `routes.js`
```

- [ ] **Step 2: Update `docs/TECH.md`** (three spots)

a) In the `## Architecture` endpoint tree, after the `GET /api/status` line add:

```
  ├── GET /api/gpu-procs        → SSH: nvidia-smi compute-apps + /proc/<pid>/cgroup + docker ps
```

b) In the `## Key technical decisions` table add a row:

```markdown
| GPU process names | PID → `/proc/<pid>/cgroup` → `midclt call app.query` on host | nvidia-smi reports only binary paths; TrueNAS app name (e.g. `ollama`) is the meaningful label; `docker ps` not accessible to `truenas_admin`; single SSH round-trip keeps it atomic |
```

c) In the `## Verification (local)` section, after the `curl .../api/gpu` line add:

```bash
curl http://localhost:3788/api/gpu-procs
```

- [ ] **Step 3: Full manual regression per project convention**

```bash
curl -s http://localhost:3788/healthz
curl -s http://localhost:3788/api/status | python3 -m json.tool | head -40
curl -s http://localhost:3788/api/gpu-procs | python3 -m json.tool
```

Expected: all 200, `gpuProcs` present in status. Then one last dashboard click-through (Task 5 checklist, short form). Host-offline case: if practical, test "Host unavailable" in modal (e.g. while host is asleep).

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/TECH.md
git commit -m "docs: document gpuProcs collector and GPU process modal"
```

---

## Follow-up (outside this plan)

- Release: bump `package.json`, merge dev → main, GitHub release — per `CLAUDE.md` "Release Procedure", triggered by the user when ready.
