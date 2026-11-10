// ── Helpers ───────────────────────────────────────────────────────────

function gb(bytes) { return (bytes / 1073741824).toFixed(1); }
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// Text and error styling are set together: an action message that stays in the
// dim progress colour after a failure reads as no feedback at all.
function setMsg(node, text, isError = false) {
  node.textContent = text;
  node.classList.toggle('is-error', isError);
}

// ── Engine state ─────────────────────────────────────────────────────
const ENGINE_NAMES = { ollama: 'Ollama', llamacpp: 'llama.cpp' };
const ENGINE_TITLES = { ollama: 'OLLAMA', llamacpp: 'LLAMA.CPP' };
const SWITCH_GIVE_UP_MS = 2 * 60 * 1000;

let lastEngine = {};          // engine object of the latest poll
let switchingTo = null;       // target of a switch we sent, until a poll shows it active
let switchSentAt = 0;
let switchLine = false;       // the action line currently shows a switching message

// Old Ollama view (v1.5.1) when llama.cpp is not configured.
const ollamaView = eng => !eng.enabled || eng.active === 'ollama';

// An engine action (switch, restart, update all apps) holds the server lock,
// TrueNAS still runs a job on an engine app (`busy`), or a switch we sent has
// not shown up yet: no other engine action may start.
function engineBusy(eng) {
  return !!eng?.switching || !!eng?.busy || !!switchingTo;
}

// The active engine's own update flag; without the feature, the Ollama app's.
function updatesWaiting(eng, app) {
  return eng.enabled ? !!eng.updatesWaiting : !!app?.upgradeAvailable;
}

// 82000 -> "82k", 1500 -> "1.5k"
function fmtK(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  return n < 10000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : Math.round(n / 1000) + 'k';
}

// ── GPU modal state ──────────────────────────────────────────────────
let gpuModalBusId = null;
let lastGpuSnapshot = { gpu: null, procs: null };

// ── Model state ──────────────────────────────────────────────────────
const PENDING_KEY = 'pendingModelLoad';
const PENDING_MAX_MS = 15 * 60 * 1000;   // drop a stale marker after 15 min
const PENDING_WARN_MS = 10 * 60 * 1000;  // 10 min: say it is taking unusually long

let pendingLoad = null;       // { model, startedAt } — cosmetic only
let lastLoadedModels = [];    // latest /api/ps snapshot, for the modal markers
let modelsModalOpen = false;
let modelListRequested = false;  // installed-model list fetched once Ollama is seen; reset on failure

function readPending() {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p?.model || !p?.startedAt) throw new Error('malformed');
    if (Date.now() - p.startedAt > PENDING_MAX_MS) throw new Error('stale');
    return p;
  } catch {
    localStorage.removeItem(PENDING_KEY);
    return null;
  }
}

function setPending(model) {
  pendingLoad = { model, startedAt: Date.now() };
  localStorage.setItem(PENDING_KEY, JSON.stringify(pendingLoad));
}

function clearPending() {
  pendingLoad = null;
  localStorage.removeItem(PENDING_KEY);
}

function ghostLabel(startedAt) {
  const s = Math.floor((Date.now() - startedAt) / 1000);
  const t = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  return (Date.now() - startedAt) >= PENDING_WARN_MS
    ? `loading ${t} — still waiting`
    : `loading… ${t}`;
}

pendingLoad = readPending();

// ── Model browser modal ──────────────────────────────────────────────
let availableModels = [];
let modelsFilter = '';

async function refreshAvailableModels() {
  const msg = document.getElementById('models-msg');
  try {
    const data = await apiFetch('/api/models');
    if (data.error) throw new Error(data.error);
    availableModels = data.models || [];
    setMsg(msg, '');
    if (modelsModalOpen) renderModelsModal();
    return true;
  } catch (e) {
    availableModels = [];
    setMsg(msg, 'Could not load model list: ' + e.message, true);
    if (modelsModalOpen) renderModelsModal();
    return false;
  }
}

function openModelsModal() {
  modelsModalOpen = true;
  renderModelsModal();
  document.getElementById('models-modal').style.display = 'flex';
  document.getElementById('models-filter').focus();
}

function closeModelsModal() {
  modelsModalOpen = false;
  document.getElementById('models-modal').style.display = 'none';
}

function renderModelsModal() {
  const sub = document.getElementById('models-modal-sub');
  const body = document.getElementById('models-modal-body');
  body.textContent = '';

  // Residency comes from the latest /api/ps snapshot, never from our own
  // actions — an external client can load or evict at any moment.
  const resident = new Set(lastLoadedModels.map(m => m.name));
  const q = modelsFilter.trim().toLowerCase();
  const rows = availableModels.filter(m => !q || m.name.toLowerCase().includes(q));

  sub.textContent = `${availableModels.length} installed · ${resident.size} in memory`;

  if (!availableModels.length) {
    body.appendChild(el('span', 'dim-text', 'No models found — press ↻ to retry'));
    return;
  }
  if (!rows.length) {
    body.appendChild(el('span', 'dim-text', 'No model matches the filter'));
    return;
  }

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  ['Model', 'Size', 'Params', 'Quant', ''].forEach(h => hr.appendChild(el('th', null, h)));
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const m of rows) {
    const isResident = resident.has(m.name);
    const isPending = pendingLoad?.model === m.name;
    const tr = el('tr', isResident ? 'row-resident' : null);

    [['td-model', m.name], ['td-mono', gb(m.sizeBytes) + ' GB'],
     ['td-mono', m.parameterSize], ['td-mono', m.quantization]]
      .forEach(([cls, val]) => tr.appendChild(el('td', cls, val)));

    const tdAct = el('td', 'td-actions');
    const btn = el('button', 'btn-small',
      isPending ? 'Loading…' : isResident ? 'Unload' : 'Load');
    btn.disabled = isPending;
    if (!isPending) {
      btn.addEventListener('click',
        () => doModelAction(isResident ? 'unload' : 'load', m.name));
    }
    tdAct.appendChild(btn);
    tr.appendChild(tdAct);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  body.appendChild(table);
}

// ── API ───────────────────────────────────────────────────────────────

async function apiFetch(path, opts = {}) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    // Our own errors carry {error: "..."}; a proxy in the path answers with an
    // HTML page instead, which must never be dumped into the UI.
    const text = await res.text();
    let message;
    try { message = JSON.parse(text).error || text; } catch { message = `HTTP ${res.status}`; }
    const err = new Error(message);
    err.status = res.status;   // callers distinguish proxy timeouts from ours
    throw err;
  }
  return res.json();
}

// ── Polling ───────────────────────────────────────────────────────────

function fmtUptime(sec) {
  if (!sec || sec < 0) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `up ${d}d ${h}h`;
  if (h > 0) return `up ${h}h ${m}m`;
  return `up ${m}m`;
}

async function pollAll() {
  try {
    const data = await apiFetch('/api/status');
    const eng = data.engine || {};
    lastEngine = eng;
    if (modelsModalOpen && data.host?.alive && eng.enabled && !eng.error && eng.active !== 'ollama') closeModelsModal();
    // A pending Ollama load means nothing once another engine (or none) runs.
    if (data.host?.alive && eng.enabled && !eng.error && eng.active !== 'ollama') clearPending();
    // /api/models is Ollama-only (409 with llama.cpp), so it waits for an Ollama view.
    if (data.host?.alive && !modelListRequested && ollamaView(eng)) {
      modelListRequested = true;
      refreshAvailableModels().then(ok => { if (!ok) modelListRequested = false; });
    }
    renderStatus(data.host, data.ipmi, eng, data.engineApp);
    renderEngineSwitch(data.host, eng);
    renderModels(data.models, eng, data.host);
    lastLoadedModels = eng.active === 'ollama' || !eng.enabled ? (data.models?.models || []) : [];
    if (modelsModalOpen) renderModelsModal();
    renderEngineApp(data.engineApp, eng, data.host, data.models?.slots);
    renderGpu(data.gpu);
    lastGpuSnapshot = { gpu: data.gpu, procs: data.gpuProcs };
    if (gpuModalBusId) renderGpuModal();
    renderMemory(data.memory);
    renderNetwork(data.network);
    document.getElementById('server-uptime').textContent =
      fmtUptime(data.uptime?.seconds);
  } catch (e) {
    document.getElementById('server-uptime').textContent = '—';
  }
}

// Load server config, then start polling
fetch('/api/config').then(r => r.json()).then(c => {
  const h = c.llmHost || '—';
  const el = document.getElementById('brand-host');
  if (el) {
    el.textContent = h;
    if (c.llmHost) el.href = c.truenasUrl || `https://${c.llmHost}`;
  }
  document.title = `LLM Monitor — ${h}`;
  const vEl = document.getElementById('app-version');
  if (vEl && c.version) vEl.textContent = `v${c.version}`;
  checkForUpdate();
  setInterval(checkForUpdate, 6 * 60 * 60 * 1000);
  const intervalMs = ((c.pollIntervalSec || 5) * 1000);
  setInterval(pollAll, intervalMs);
  pollAll();
}).catch(() => {
  setInterval(pollAll, 5000);
  pollAll();
});

// ── Status ────────────────────────────────────────────────────────────

function renderStatus(host, ipmi, eng, engineApp) {
  if (!host) return;
  const ring  = document.getElementById('status-ring');
  const dot   = document.getElementById('pill-dot');
  const label = document.getElementById('pill-label');
  const text  = document.getElementById('status-text');
  const sub   = document.getElementById('status-checked');
  const wake  = document.getElementById('btn-wake');
  const sleep = document.getElementById('btn-sleep');
  const rst   = document.getElementById('btn-restart');
  const upg   = document.getElementById('btn-upgrade');
  const rstLabel = document.getElementById('btn-restart-label');

  // Header pill = IPMI availability
  if (ipmi?.alive) {
    dot.className  = 'pill-dot alive';
    label.textContent = 'Reachable';
  } else {
    dot.className  = 'pill-dot dead';
    label.textContent = 'Unreachable';
  }

  // SERVER card = SSH host availability
  if (host.alive) {
    ring.className  = 'status-ring alive';
    text.textContent  = 'Online';
    wake.disabled = true; sleep.disabled = false;
    rst.disabled = (!!eng.enabled && !eng.active) || engineBusy(eng);
    upg.disabled = !updatesWaiting(eng, engineApp) || engineBusy(eng);
  } else {
    ring.className  = 'status-ring dead';
    text.textContent  = 'Powered off';
    wake.disabled = false; sleep.disabled = true; rst.disabled = true;
    upg.disabled = true;
  }

  rstLabel.textContent = !eng.enabled ? 'Restart Ollama'
    : eng.active ? `Restart ${ENGINE_NAMES[eng.active]}` : 'Restart engine';

  sub.textContent = host.checkedAt
    ? 'checked ' + new Date(host.checkedAt).toLocaleTimeString() : '—';
}

// ── Engine switch ─────────────────────────────────────────────────────

function renderEngineSwitch(host, eng) {
  const box = document.getElementById('engine-switch');
  const warn = document.getElementById('engine-warn');
  const line = document.getElementById('action-msg');
  const alive = !!host?.alive;

  box.hidden = !eng.enabled;
  for (const b of box.querySelectorAll('button')) {
    const on = eng.active === b.dataset.engine;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-pressed', String(on));
    // An unreadable engine state leaves `active` unknown: the confirm text
    // would not match what the server's fresh plan does.
    b.disabled = !alive || engineBusy(eng) || !!eng.error;
  }

  warn.textContent = '';
  if (alive && eng.conflict) warn.appendChild(el('div', null, 'Both engines are running — pick one'));
  if (alive && eng.notFound) {
    warn.appendChild(el('div', null, `llama.cpp app '${eng.notFound}' not found`));
  }
  warn.hidden = !warn.firstChild;

  // The switch POST answers once the start job has finished (container up,
  // model possibly still loading); the success signal is the target showing
  // up as the active engine.
  if (switchingTo && Date.now() - switchSentAt > SWITCH_GIVE_UP_MS) switchingTo = null;
  if (switchingTo && eng.active === switchingTo && !eng.switching && !eng.conflict) switchingTo = null;
  if (switchingTo) {
    setMsg(line, `Switching to ${ENGINE_NAMES[switchingTo]}…`);
    switchLine = true;
  } else if (eng.switching && eng.action !== 'upgrade') {
    // "Update all apps" reports on its own line; switch and restart use this one.
    setMsg(line, eng.action === 'restart' ? 'Restarting engine…' : 'Switching engine…');
    switchLine = true;
  } else if (eng.busy) {
    // A TrueNAS job on an engine app (an upgrade, or one started in the TrueNAS UI).
    setMsg(line, `TrueNAS: ${eng.busy.method} on ${eng.busy.app}…`);
    switchLine = true;
  } else if (switchLine) {
    setMsg(line, '');
    switchLine = false;
  }
}

async function switchEngine(target) {
  const eng = lastEngine;
  const to = ENGINE_NAMES[target];
  const other = ENGINE_NAMES[target === 'ollama' ? 'llamacpp' : 'ollama'];
  let question;
  if (!eng.active) question = `Start ${to}?`;
  else if (eng.active !== target) question = `Switch to ${to}? ${other} will be stopped and its loaded models unloaded.`;
  else if (eng.conflict) question = `Both engines are running. Stop ${other} and keep ${to}?`;
  else return;
  if (!confirm(question)) return;

  const msg = document.getElementById('action-msg');
  switchingTo = target;
  switchSentAt = Date.now();
  switchLine = true;
  clearPending();
  setMsg(msg, `Switching to ${to}…`);
  for (const b of document.querySelectorAll('#engine-switch button')) b.disabled = true;
  try {
    await apiFetch('/api/switch-engine', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target }),
    });
  } catch (e) {
    switchingTo = null;
    setMsg(msg, 'Error: ' + e.message, true);
    switchLine = false;
    setTimeout(() => { if (!switchLine) setMsg(msg, ''); }, 8000);
  }
  pollAll();
}

for (const b of document.querySelectorAll('#engine-switch button')) {
  b.addEventListener('click', () => switchEngine(b.dataset.engine));
}

// ── Loaded models ─────────────────────────────────────────────────────

function renderModels(data, eng, host) {
  const wrap = document.getElementById('engine-content');
  const speed = document.getElementById('models-speed');
  const llama = eng.active === 'llamacpp';
  document.getElementById('btn-models').hidden = eng.enabled && eng.active !== 'ollama';
  speed.hidden = true;

  if (llama && host?.alive) {
    if (data && !data.error) { renderLlamacppModels(data, wrap, speed, eng); return; }
    wrap.textContent = '';
    if (data?.error) wrap.appendChild(el('span', 'dim-text', 'Temporarily unavailable'));
    return;
  }
  if (!host?.alive || !data && eng.error) {
    wrap.textContent = '';
    wrap.appendChild(el('span', 'dim-text', host?.alive ? 'Temporarily unavailable' : 'Host unavailable'));
    return;
  }
  if (!data && !eng.active) {
    wrap.textContent = '';
    wrap.appendChild(el('span', 'dim-text', 'No engine running'));
    return;
  }
  renderOllama(data);
}

// Latest Ollama table redraw for doModelAction; a no-op once another engine owns the card.
function redrawOllama() {
  if (ollamaView(lastEngine)) renderOllama({ models: lastLoadedModels });
}

function renderLlamacppModels(data, wrap, speed, eng) {
  wrap.textContent = '';
  if (data.loading) {
    // "Loading model…" only while the app is up or coming up; a CRASHED or
    // STOPPING app is not going to finish loading.
    const state = eng.apps?.llamacpp?.state;
    const starting = state === 'RUNNING' || state === 'DEPLOYING';
    wrap.appendChild(el('span', 'dim-text', starting ? 'Loading model…' : `Not running (${state || '—'})`));
    return;
  }

  renderSpeed(data, speed);

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  ['Model', 'Params', 'Quant', 'VRAM', 'Ctx'].forEach(h => hr.appendChild(el('th', null, h)));
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const m of data.models || []) {
    const tr = document.createElement('tr');
    [['td-model', m.name, m.name],
     ['td-mono', m.parameterSize || '—', null],
     ['td-mono', m.quantization || '—', null],
     ['td-mono', m.sizeVram ? gb(m.sizeVram) + ' GB' : '—', null],
     ['td-mono', m.contextLength ? fmtK(m.contextLength) : '—', null]]
      .forEach(([cls, val, title]) => {
        const td = el('td', cls, val);
        if (title) td.title = title;
        tr.appendChild(td);
      });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
}

const WINDOW_TITLES = {
  live: 'live',
  last: 'last finished request',
  lifetime: 'average since engine start',
};

// Header right side: ▶ 21.7 tok/s · MTP 61%. Only a live figure gets the marker.
function renderSpeed(data, node) {
  node.textContent = '';
  node.hidden = false;
  const sp = data.speed;
  let part;
  if (sp && sp.window === 'live') {
    part = el('span', 'speed-live', `▶ ${Number(sp.value).toFixed(1)} tok/s`);
  } else if (data.activity === 'reading') {
    part = el('span', 'speed-dim', 'reading prompt…');
    part.title = 'processing the prompt';
  } else if (sp) {
    part = el('span', 'speed-dim', `${Number(sp.value).toFixed(1)} tok/s`);
  } else {
    part = el('span', 'speed-dim', '—');
  }
  if (sp && part.title === '') part.title = WINDOW_TITLES[sp.window] || '';
  node.appendChild(part);

  if (data.mtp) {
    node.appendChild(el('span', 'speed-dim', ' · '));
    const mtp = el('span', 'speed-dim', `MTP ${data.mtp.pct}%`);
    mtp.title = WINDOW_TITLES[data.mtp.window] || '';
    node.appendChild(mtp);
  }
}

// ── Ollama ────────────────────────────────────────────────────────────

function renderOllama(data) {
  const wrap = document.getElementById('engine-content');
  wrap.textContent = '';

  const models = data && !data.error ? (data.models || []) : null;

  // /api/ps is authoritative: the model showing up IS the success signal.
  if (models && pendingLoad && models.some(m => m.name === pendingLoad.model)) {
    clearPending();
  }

  if (!data) { wrap.appendChild(el('span', 'dim-text', 'Host unavailable')); return; }
  if (data.error) { wrap.appendChild(el('span', 'dim-text', 'Temporarily unavailable')); return; }
  if (!models.length && !pendingLoad) {
    wrap.appendChild(el('span', 'dim-text', 'No models loaded'));
    return;
  }

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  ['Model', 'Params', 'Quant', 'Processor', 'VRAM', 'Ctx', 'Expires', ''].forEach(h => {
    hr.appendChild(el('th', null, h));
  });
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');

  if (pendingLoad) {
    const tr = el('tr', 'ghost-row');
    tr.appendChild(el('td', 'td-model', pendingLoad.model));
    const tdMsg = el('td', 'dim-text', ghostLabel(pendingLoad.startedAt));
    tdMsg.colSpan = 7;
    tr.appendChild(tdMsg);
    tbody.appendChild(tr);
  }

  for (const m of models) {
    const tr = document.createElement('tr');
    // keep_alive:-1 lands ~300 years out; anything past a day is effectively never
    const expiresMs = m.expiresAt ? new Date(m.expiresAt).getTime() : 0;
    // "never" rather than ∞ — the glyph has no ascenders and disappears at
    // this font size, reading as an empty cell.
    const expires = !expiresMs ? '—'
      : expiresMs - Date.now() > 86_400_000 ? 'never'
      : new Date(expiresMs).toLocaleTimeString();
    const vram    = m.sizeVram  ? gb(m.sizeVram) + ' GB' : '—';
    const ctx     = m.contextLength ? Math.round(m.contextLength / 1000) + 'k' : '—';

    const procCls = m.processor === '100% GPU' ? 'td-gpu'
      : m.processor?.includes('CPU') && m.processor?.includes('GPU') ? 'td-mix'
      : 'td-cpu';

    const cells = [
      ['td-model', m.name, m.name],
      ['td-mono',  m.parameterSize, null],
      ['td-mono',  m.quantization, null],
      [procCls,    m.processor, null],
      ['td-mono',  vram, null],
      ['td-mono',  ctx, null],
      ['td-mono',  expires, null],
    ];

    cells.forEach(([cls, val, title]) => {
      const td = document.createElement('td');
      td.className = cls;
      td.textContent = val;
      if (title) td.title = title;
      tr.appendChild(td);
    });

    const tdAct = el('td', 'td-actions');
    const btn = el('button', 'btn-small', 'Unload');
    btn.addEventListener('click', () => doModelAction('unload', m.name));
    tdAct.appendChild(btn);
    tr.appendChild(tdAct);

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
}

// ── GPU ───────────────────────────────────────────────────────────────

function renderGpu(data) {
  const wrap = document.getElementById('gpu-content');
  wrap.textContent = '';

  if (!data) { wrap.appendChild(el('span', 'dim-text', 'Host unavailable')); return; }
  if (data.error) { wrap.appendChild(el('span', 'dim-text', 'Temporarily unavailable')); return; }
  if (!data.gpus?.length) { wrap.appendChild(el('span', 'dim-text', 'No GPUs found')); return; }

  data.gpus.forEach((g) => {
    const card = el('div', 'gpu-card');
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.addEventListener('click', () => openGpuModal(g.busId));
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openGpuModal(g.busId); }
    });

    // Header row
    const top = el('div', 'gpu-card-top');
    top.appendChild(el('span', 'gpu-card-name', g.name));
    top.appendChild(el('span', 'gpu-idx', `#${g.index}`));
    card.appendChild(top);

    // Util bar
    const utilPct = Math.min(100, Math.max(0, g.utilization));
    const utilCls = utilPct > 80 ? 'fill-high' : utilPct > 50 ? 'fill-mid' : 'fill-low';
    card.appendChild(makeGpuBar('UTIL', `${utilPct}%`, utilPct, utilCls));

    // VRAM bar
    const memPct = g.memTotal > 0 ? Math.round(g.memUsed / g.memTotal * 100) : 0;
    const vramLabel = `${g.memUsed.toLocaleString()} / ${g.memTotal.toLocaleString()} MB`;
    card.appendChild(makeGpuBar('VRAM', vramLabel, memPct, 'fill-vram'));

    // Badges
    const badges = el('div', 'gpu-badges');
    const tempCls = g.temperature >= 85 ? 'badge hot' : g.temperature >= 75 ? 'badge warn' : 'badge';
    badges.appendChild(el('span', tempCls, `${g.temperature}°C`));
    badges.appendChild(el('span', 'badge', `${g.powerDraw}W`));
    if (g.engine) {
      // "LLAMA.CPP" wraps the badge row on phone-width cards; CSS drops the suffix there.
      const full = ENGINE_TITLES[g.engine] || g.engine.toUpperCase();
      const dot = full.indexOf('.');
      const badge = el('span', 'badge-engine', dot > 0 ? full.slice(0, dot) : full);
      if (dot > 0) badge.appendChild(el('span', 'badge-suffix', full.slice(dot)));
      badge.title = ENGINE_NAMES[g.engine] || g.engine;
      badges.appendChild(badge);
    }
    if (g.pcieGen && g.pcieWidth) badges.appendChild(el('span', g.pcieGen === 1 ? 'badge warn' : 'badge badge-bus', `PCIe ${g.pcieGen}×${g.pcieWidth}`));
    if (g.busId) badges.appendChild(el('span', 'badge badge-bus', g.busId));
    card.appendChild(badges);

    wrap.appendChild(card);
  });
}

function makeGpuBar(label, valText, pct, fillCls) {
  const row = el('div', 'gpu-row');
  const head = el('div', 'gpu-row-head');
  head.appendChild(el('span', 'gpu-row-label', label));
  head.appendChild(el('span', 'gpu-row-val', valText));
  const track = el('div', 'bar-track');
  const fill  = el('div', `bar-fill ${fillCls}`);
  fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  track.appendChild(fill);
  row.appendChild(head);
  row.appendChild(track);
  return row;
}

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
  if (e.key !== 'Escape') return;
  if (gpuModalBusId) closeGpuModal();
  if (modelsModalOpen) closeModelsModal();
});

document.getElementById('models-modal-close').addEventListener('click', closeModelsModal);
document.getElementById('models-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeModelsModal();
});
document.getElementById('models-refresh').addEventListener('click', refreshAvailableModels);
document.getElementById('models-filter').addEventListener('input', (e) => {
  modelsFilter = e.target.value;
  renderModelsModal();
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
  if (gpu.error || !procs || procs.error) { body.appendChild(el('span', 'dim-text', 'Process list temporarily unavailable')); return; }

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
      ['td-mono',  p.vramMb != null ? p.vramMb.toLocaleString() + ' MB' : '—', null],
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

// ── Engine app ────────────────────────────────────────────────────────

function fmt(bytes) {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
  if (bytes >= 1048576)    return (bytes / 1048576).toFixed(0) + ' MB';
  if (bytes >= 1024)       return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}

// State badge; DEPLOYING reads as "Starting…" only when engines can be switched.
function stateBadge(state, eng) {
  const text = (state || '').toUpperCase();
  if (eng.enabled && text === 'DEPLOYING') return el('span', 'app-state-badge starting', 'STARTING…');
  return el('span', `app-state-badge ${text === 'RUNNING' ? 'running' : 'stopped'}`, text || '—');
}

// No engine active: both apps with the state TrueNAS reports.
function renderNoEngineApps(eng, wrap) {
  const names = Object.keys(eng.apps || {});
  if (!names.length) { wrap.appendChild(el('span', 'dim-text', 'Temporarily unavailable')); return; }
  for (const key of names) {
    const row = el('div', 'app-status-row');
    row.appendChild(el('span', 'engine-app-name', ENGINE_NAMES[key]));
    row.appendChild(stateBadge(eng.apps[key]?.state, eng));
    wrap.appendChild(row);
  }
}

// CONTEXT bar(s) from the slots, one per slot; cache figure beside the label.
function renderContext(slots, wrap) {
  if (!slots?.length) return;
  const box = el('div', 'engine-block');
  slots.forEach((sl, i) => {
    const pct = sl.total > 0 ? Math.round(sl.used / sl.total * 100) : 0;
    const cls = pct > 90 ? 'fill-high' : pct > 70 ? 'fill-mid' : 'fill-low';
    const label = slots.length > 1 ? `CONTEXT ${i + 1}` : 'CONTEXT';
    const bar = makeGpuBar(label, `${fmtK(sl.used)} / ${fmtK(sl.total)}${sl.cached ? ` (cache ${fmtK(sl.cached)})` : ''}`, pct, cls);
    bar.title = `${sl.used.toLocaleString()} / ${sl.total.toLocaleString()} tokens`;
    box.appendChild(bar);
  });
  wrap.appendChild(box);
}

// Launch parameters, read-only; the full command is the tooltip.
function renderLaunch(launch, wrap) {
  if (!launch?.params?.length) return;
  const box = el('div', 'engine-launch',
    launch.params.map(p => `${p.label} ${p.value}`.trim()).join(' · '));
  if (launch.command) box.title = launch.command;
  wrap.appendChild(box);
}

function renderEngineApp(data, eng, host, slots) {
  const wrap = document.getElementById('engine-app-content');
  const title = document.getElementById('engine-app-title');
  const imageEl = document.getElementById('engine-app-image');
  wrap.textContent = '';

  title.textContent = !eng.enabled ? 'OLLAMA APP'
    : eng.active ? `${ENGINE_TITLES[eng.active]} APP` : 'ENGINE APPS';
  if (imageEl) { imageEl.textContent = ''; imageEl.title = ''; }

  if (!host?.alive) { wrap.appendChild(el('span', 'dim-text', 'Host unavailable')); return; }
  if (!data && eng.enabled && !eng.active) { renderNoEngineApps(eng, wrap); return; }
  if (!data) { wrap.appendChild(el('span', 'dim-text', 'Host unavailable')); return; }
  if (data.error) { wrap.appendChild(el('span', 'dim-text', 'Temporarily unavailable')); return; }

  // Status row
  const statusRow = el('div', 'app-status-row');
  const stateEl = stateBadge(data.state, eng);
  const hasUpdate = updatesWaiting(eng, data);
  const canUpdate = hasUpdate && !engineBusy(eng);
  const updateBadge = el('span', `app-update-badge ${canUpdate ? 'update clickable' : hasUpdate ? 'update' : 'ok'}`,
    hasUpdate ? '⬆ Update' : '✓ Up to date');
  if (canUpdate) {
    updateBadge.title = 'Click to update every TrueNAS app that has an update waiting';
    updateBadge.onclick = () => upgradeAllApps();
  }
  statusRow.appendChild(stateEl);
  statusRow.appendChild(updateBadge);

  // TrueNAS pins the image by digest — show only repo:tag, keep the full reference in the tooltip
  const image = data.image || '';
  if (imageEl) { imageEl.textContent = image.split('@')[0]; imageEl.title = image; }
  wrap.appendChild(statusRow);

  // Stats grid
  const grid = el('div', 'app-stat-grid');

  // CPU
  const cpuPct = data.cpu?.pct ?? 0;
  const cpuCard = el('div', 'app-stat');
  cpuCard.appendChild(el('div', 'app-stat-label', 'CPU'));
  cpuCard.appendChild(el('div', 'app-stat-val', `${cpuPct}%`));
  cpuCard.appendChild(el('div', 'app-stat-sub', data.cpu?.cores ? `${data.cpu.cores} cores` : ''));
  const cpuBarRow = el('div', 'app-bar-row');
  cpuBarRow.appendChild(makeGpuBar('', '', cpuPct,
    cpuPct > 80 ? 'fill-high' : cpuPct > 40 ? 'fill-mid' : 'fill-low'));
  cpuCard.appendChild(cpuBarRow);
  grid.appendChild(cpuCard);

  // RAM
  const memCard = el('div', 'app-stat');
  memCard.appendChild(el('div', 'app-stat-label', 'RAM'));
  const memUsed = data.memory?.used ?? 0;
  const memMax  = data.memory?.max  ?? 0;
  memCard.appendChild(el('div', 'app-stat-val', fmt(memUsed)));
  memCard.appendChild(el('div', 'app-stat-sub', memMax > 0 ? `limit ${fmt(memMax)}` : 'no limit'));
  const memPct = memMax > 0 ? Math.round(memUsed / memMax * 100) : 0;
  const memBarRow = el('div', 'app-bar-row');
  memBarRow.appendChild(makeGpuBar('', '', memPct, 'fill-vram'));
  memCard.appendChild(memBarRow);
  grid.appendChild(memCard);

  // Block I/O
  const ioCard = el('div', 'app-stat');
  ioCard.appendChild(el('div', 'app-stat-label', 'BLOCK I/O'));
  ioCard.appendChild(el('div', 'app-stat-val', `↑ ${fmt(data.io?.write ?? 0)}`));
  ioCard.appendChild(el('div', 'app-stat-sub', `↓ ${fmt(data.io?.read ?? 0)}`));
  grid.appendChild(ioCard);

  // Network
  const netCard = el('div', 'app-stat');
  netCard.appendChild(el('div', 'app-stat-label', 'NETWORK'));
  netCard.appendChild(el('div', 'app-stat-val', `↑ ${fmt(data.network?.tx ?? 0)}`));
  netCard.appendChild(el('div', 'app-stat-sub', `↓ ${fmt(data.network?.rx ?? 0)}`));
  grid.appendChild(netCard);

  wrap.appendChild(grid);

  if (eng.active === 'llamacpp') {
    renderContext(slots, wrap);
    renderLaunch(data.launch, wrap);
  }
}

// ── Memory ────────────────────────────────────────────────────────────

function svgEl(tag, attrs = {}) {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
  return e;
}

function renderMemory(data) {
  const wrap = document.getElementById('memory-content');
  wrap.textContent = '';

  if (!data) { wrap.appendChild(el('span', 'dim-text', 'Host unavailable')); return; }
  if (data.error) { wrap.appendChild(el('span', 'dim-text', 'Temporarily unavailable')); return; }

  const { total, free, arc, services } = data;
  const R    = 80;
  const CIRC = 2 * Math.PI * R;

  const segments = [
    { label: 'SERVICES', bytes: services, color: '#2e88ff' },
    { label: 'ZFS ARC',  bytes: arc,      color: '#f59e0b' },
    { label: 'FREE',     bytes: free,     color: '#00c896' },
  ];

  // ── SVG donut ──
  const svg = svgEl('svg', { viewBox: '0 0 200 200', class: 'mem-donut-svg' });

  // Track
  svg.appendChild(svgEl('circle', { cx: 100, cy: 100, r: R, fill: 'none', stroke: 'rgba(255,255,255,.05)', 'stroke-width': 38 }));

  // Counter-clockwise: mirror horizontally around x=100
  const ccw = svgEl('g', { transform: 'translate(200,0) scale(-1,1)' });
  let offset = 0;
  segments.forEach(({ bytes, color }) => {
    const len = total > 0 ? (bytes / total) * CIRC : 0;
    if (len < 0.5) return;
    const circle = svgEl('circle', {
      cx: 100, cy: 100, r: R,
      fill: 'none', stroke: color, 'stroke-width': 36,
      'stroke-dasharray': `${len} ${CIRC}`,
      'stroke-dashoffset': -offset,
      'stroke-linecap': 'butt',
      transform: 'rotate(-90 100 100)',
    });
    ccw.appendChild(circle);
    offset += len;
  });
  svg.appendChild(ccw);

  // Center labels
  const totalGb = gb(total);
  const centerVal = svgEl('text', { x: 100, y: 97, 'text-anchor': 'middle', fill: '#dde8f0', 'font-size': 20, 'font-family': 'JetBrains Mono', 'font-weight': 600, class: 'mem-center-val' });
  centerVal.textContent = totalGb;
  const centerUnit = svgEl('text', { x: 100, y: 115, 'text-anchor': 'middle', fill: '#6a8aaa', 'font-size': 11, 'font-family': 'JetBrains Mono' });
  centerUnit.textContent = 'GB';
  svg.appendChild(centerVal);
  svg.appendChild(centerUnit);

  // ── Legend ──
  const legend = el('div', 'mem-legend');
  segments.forEach(({ label, bytes, color }) => {
    const pct = total > 0 ? (bytes / total * 100) : 0;
    const item = el('div', 'mem-legend-item');
    const dot = el('div', 'mem-legend-dot');
    dot.style.background = color;
    const info = el('div', null);
    info.appendChild(el('span', 'mem-legend-label', label));
    const vals = el('div', 'mem-legend-vals');
    vals.appendChild(el('span', 'mem-legend-gb', `${gb(bytes)} GB`));
    vals.appendChild(el('span', 'mem-legend-pct', `${pct.toFixed(1)}%`));
    info.appendChild(vals);
    item.appendChild(dot);
    item.appendChild(info);
    legend.appendChild(item);
  });

  const container = el('div', 'mem-donut-wrap');
  container.appendChild(svg);
  container.appendChild(legend);
  wrap.appendChild(container);
}

// ── Network ───────────────────────────────────────────────────────────

const NET_HIST_LEN = 40;
const _netHistory  = {};
const _netCanvases = {};
let   _netBuilt    = false;
let   _netLastTs   = 0;
let   _netPortKey  = '';

function fmtMbps(v) {
  if (v >= 1000) return `${(v / 1000).toFixed(1)} Gbit/s`;
  if (v >= 1)    return `${(v % 1 === 0 ? v : v.toFixed(1))} Mbit/s`;
  const k = Math.round(v * 1000);
  return k < 1 ? '< 1 kBit/s' : `${k} kBit/s`;
}

function _pushNetHistory(ports) {
  for (const p of ports) {
    if (!_netHistory[p.name]) _netHistory[p.name] = [];
    _netHistory[p.name].push({ rx: p.rxMbps ?? 0, tx: p.txMbps ?? 0 });
    if (_netHistory[p.name].length > NET_HIST_LEN) _netHistory[p.name].shift();
  }
}

function _drawHistogram(canvas, history) {
  const dpr  = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (!cssW || !cssH) return;

  canvas.width  = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx  = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const W = cssW, H = cssH, midY = Math.floor(H / 2);

  const padded = [
    ...Array(Math.max(0, NET_HIST_LEN - history.length)).fill({ rx: 0, tx: 0 }),
    ...history,
  ];

  const maxMbps = Math.max(...padded.flatMap(h => [h.rx, h.tx]), 0.0001);
  const useMbit = maxMbps >= 1;
  const toU     = v => useMbit ? v : v * 1000;
  const axisMax = toU(maxMbps);
  const unit    = useMbit ? 'Mbit/s' : 'kBit/s';

  ctx.clearRect(0, 0, W, H);

  // center divider
  ctx.fillStyle = 'rgba(255,255,255,0.07)';
  ctx.fillRect(0, midY, W, 1);

  const gap  = 1;
  const barW = Math.max(2, Math.floor((W - gap * (NET_HIST_LEN - 1)) / NET_HIST_LEN));
  const step = barW + gap;
  const maxH = midY - 3;

  padded.forEach((pt, i) => {
    const x   = i * step;
    const rxH = Math.round((toU(pt.rx) / axisMax) * maxH);
    const txH = Math.round((toU(pt.tx) / axisMax) * maxH);
    if (rxH > 0) { ctx.fillStyle = '#2e88ff'; ctx.fillRect(x, midY - rxH, barW, rxH); }
    if (txH > 0) { ctx.fillStyle = '#f59e0b'; ctx.fillRect(x, midY + 1, barW, txH); }
  });

  const axisLabel = axisMax < 10
    ? `${axisMax.toFixed(1)} ${unit}` : `${Math.round(axisMax)} ${unit}`;
  ctx.font      = `9px JetBrains Mono, monospace`;
  ctx.fillStyle = 'rgba(106,138,170,0.85)';
  ctx.textAlign = 'right';
  ctx.fillText(axisLabel, W - 2, 10);
}

function _buildNetworkDOM(physPorts, bond, wrap) {
  wrap.textContent = '';
  physPorts.forEach((port, i) => {
    if (i > 0) wrap.appendChild(el('div', 'net-divider'));
    const div = el('div', 'net-port');
    const hdr = el('div', 'net-port-header');
    hdr.appendChild(el('span', 'net-port-name', port.name));
    const pv = el('div', 'net-port-vals');
    pv.appendChild(el('span', 'net-val-rx', ''));
    pv.appendChild(el('span', 'net-val-tx', ''));
    hdr.appendChild(pv);
    div.appendChild(hdr);
    const canvas = document.createElement('canvas');
    canvas.className = 'net-histogram';
    _netCanvases[port.name] = canvas;
    div.appendChild(canvas);
    wrap.appendChild(div);
  });

  if (bond) {
    wrap.appendChild(el('div', 'net-divider'));
    const row = el('div', 'net-bond');
    row.appendChild(el('span', 'net-bond-label', `${bond.name} (host)`));
    const bv = el('div', 'net-bond-vals');
    bv.appendChild(el('span', 'net-bond-val', ''));
    bv.appendChild(el('span', 'net-bond-val', ''));
    row.appendChild(bv);
    wrap.appendChild(row);
  }
}

function renderNetwork(data) {
  const card   = document.getElementById('card-network');
  const wrap   = document.getElementById('network-content');
  const topRow = document.querySelector('.top-row');

  if (data === null) {
    card.style.display = 'none';
    topRow.classList.add('no-network');
    _netBuilt = false;
    return;
  }
  card.style.display = '';
  topRow.classList.remove('no-network');

  if (!data || data.error) {
    if (!_netBuilt) { wrap.textContent = ''; wrap.appendChild(el('span', 'dim-text', data?.error ? 'Temporarily unavailable' : 'Host unavailable')); }
    return;
  }

  const physPorts = (data.ports || []).filter(p => !p.isHost);
  const bond      = (data.ports || []).find(p => p.isHost);

  const portKey = physPorts.map(p => p.name).join(',');
  if (_netBuilt && portKey !== _netPortKey) _netBuilt = false;

  if (data.ts && data.ts !== _netLastTs) {
    _pushNetHistory(physPorts);
    _netLastTs = data.ts;
  }

  if (!_netBuilt) {
    _buildNetworkDOM(physPorts, bond, wrap);
    _netBuilt   = true;
    _netPortKey = portKey;
  }

  physPorts.forEach(port => {
    const canvas = _netCanvases[port.name];
    if (!canvas) return;
    const div = canvas.closest('.net-port');
    if (div) {
      const rxEl = div.querySelector('.net-val-rx');
      const txEl = div.querySelector('.net-val-tx');
      if (rxEl) rxEl.textContent = `↓ ${fmtMbps(port.rxMbps)}`;
      if (txEl) txEl.textContent = `↑ ${fmtMbps(port.txMbps)}`;
    }
    _drawHistogram(canvas, _netHistory[port.name] || []);
  });

  if (bond) {
    const bv = wrap.querySelector('.net-bond-vals');
    if (bv) {
      const [rxEl, txEl] = bv.querySelectorAll('.net-bond-val');
      if (rxEl) rxEl.textContent = `↓ ${fmtMbps(bond.rxMbps)}`;
      if (txEl) txEl.textContent = `↑ ${fmtMbps(bond.txMbps)}`;
    }
  }
}

// ── Update check ─────────────────────────────────────────────────────

async function checkForUpdate() {
  try {
    const data = await apiFetch('/api/check-update');
    const vBadge = document.getElementById('app-version');
    const uBadge = document.getElementById('update-badge');
    if (!vBadge || !uBadge) return;
    if (data.updateAvailable && data.latest) {
      uBadge.textContent = `v${data.current} → v${data.latest}`;
      uBadge.href = data.releaseUrl || '#';
      uBadge.style.display = '';
      vBadge.style.display = 'none';
    } else {
      uBadge.style.display = 'none';
      vBadge.style.display = '';
    }
  } catch {}
}

// ── Actions ───────────────────────────────────────────────────────────

// Triggered from Ollama's update badge, but not limited to Ollama: the list of
// apps is resolved server-side at call time, so the names are only known once
// the response comes back — hence the generic confirm and the specific result.
async function upgradeAllApps(msgId = 'engine-upgrade-msg') {
  // Buttons re-render only on a poll; the server lock answers 409 anyway.
  if (engineBusy(lastEngine)) return;
  if (!confirm('Update every TrueNAS app that has an update waiting?\n' +
               'Each one restarts as it upgrades — ' + (lastEngine.enabled ? 'the active engine' : 'Ollama') + ' will be unavailable for a few minutes.')) return;
  const msg = document.getElementById(msgId);
  setMsg(msg, 'Upgrade started — apps will restart automatically...');
  try {
    const res = await apiFetch('/api/upgrade-apps', { method: 'POST' });
    if (!res.ok) {
      setMsg(msg, 'Error: ' + (res.error || '?'), true);
    } else if (!res.apps.length) {
      setMsg(msg, 'Nothing to upgrade — every app is already current.' +
        (res.skipped ? ` — skipped ${res.skipped} (inactive engine)` : ''));
    } else {
      setMsg(msg, `Upgrading ${res.apps.length} app(s): ${res.apps.join(', ')} — check back in a few minutes.` +
        (res.skipped ? ` — skipped ${res.skipped} (inactive engine)` : ''));
    }
  } catch (e) {
    setMsg(msg, 'Error: ' + e.message, true);
  }
  setTimeout(() => { setMsg(msg, ''); }, 15000);
}

// Kept separate from action() below: that one is name-keyed with hardcoded
// message maps and takes no arguments; these are parameterised by model name.
async function doModelAction(kind, name) {
  if (kind === 'unload' &&
      !confirm(`Unload ${name}?\nVRAM is freed immediately; reloading can take minutes.`)) {
    return;
  }

  const msg = document.getElementById(modelsModalOpen ? 'models-msg' : 'models-card-msg');

  if (kind === 'load') {
    setPending(name);
    // Redraw the card now instead of waiting up to a full poll interval —
    // otherwise closing the modal right after clicking shows no feedback.
    redrawOllama();
  }
  if (modelsModalOpen) renderModelsModal();
  setMsg(msg, kind === 'load' ? `Requested ${name}…` : `Unloading ${name}…`);

  try {
    await apiFetch(`/api/${kind}-model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name }),
    });
    setMsg(msg, kind === 'load'
      ? 'Load requested — watching for it to appear.'
      : `Unloaded ${name}`);
  } catch (e) {
    // 502/504 come from a proxy between the browser and the container. That
    // leg is separate from the container→Ollama request, which is untouched
    // and still loading — so this is not a failure and the ghost row stays.
    // Our own timeout arrives as 500 and DOES mean Ollama cancelled the load.
    const proxyGaveUp = e.status === 502 || e.status === 504;
    if (kind === 'load' && proxyGaveUp) {
      setMsg(msg, 'The proxy stopped waiting — the load continues, still watching.');
    } else {
      if (kind === 'load') clearPending();
      setMsg(msg, /timeout/i.test(e.message)
        ? 'Load aborted — the connection timed out and Ollama cancelled it. Retry.'
        : 'Error: ' + e.message, true);
    }
  }
  // Redraw unconditionally: pollAll() swallows its own errors, so relying on
  // it to clear the ghost row leaves it stranded exactly when the backend is
  // the thing that failed.
  redrawOllama();
  if (modelsModalOpen) renderModelsModal();
  setTimeout(() => { setMsg(msg, ''); }, 15000);
  pollAll();
}

async function action(name) {
  if (name === 'restart-engine' && engineBusy(lastEngine)) return;
  const confirmMsg = {
    sleep: 'Shut down the server?',
    'restart-engine': `Restart ${ENGINE_NAMES[lastEngine.active] || 'Ollama'}? Loaded models will be unloaded.`,
  }[name];
  if (confirmMsg && !confirm(confirmMsg)) return;

  const msg = document.getElementById('action-msg');
  setMsg(msg, { wake: 'Waking up...', sleep: 'Shutting down...', 'restart-engine': 'Restarting...' }[name] || '...');
  try {
    const res = await apiFetch(`/api/${name}`, { method: 'POST' });
    setMsg(msg, res.ok
      ? ({ wake: 'Sent — boot ~3.5 min', sleep: 'Shutting down...', 'restart-engine': 'Restarted' }[name] || 'OK')
      : 'Error: ' + (res.error || '?'), !res.ok);
  } catch (e) {
    setMsg(msg, 'Error: ' + e.message, true);
  }
  // The next poll must not wipe this result as a stale "Restarting engine…".
  if (name === 'restart-engine') switchLine = false;
  setTimeout(() => { setMsg(msg, ''); }, 8000);
}
