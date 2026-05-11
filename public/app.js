// ── Helpers ───────────────────────────────────────────────────────────

function gb(bytes) { return (bytes / 1073741824).toFixed(1); }
function shortName(s) { return s.length > 30 ? s.slice(0, 28) + '…' : s; }
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// ── API ───────────────────────────────────────────────────────────────

async function apiFetch(path, opts = {}) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// ── Polling ───────────────────────────────────────────────────────────

async function pollAll() {
  try {
    const data = await apiFetch('/api/status');
    renderStatus(data.host);
    renderOllama(data.ollama);
    renderOllamaApp(data.ollamaApp);
    renderGpu(data.gpu);
    renderMemory(data.memory);
    document.getElementById('last-updated').textContent =
      new Date().toLocaleTimeString();
  } catch (e) {
    document.getElementById('last-updated').textContent = 'connection error';
  }
}

// Load server hostname for branding
fetch('/api/config').then(r => r.json()).then(c => {
  const h = c.llmHost || '—';
  const el = document.getElementById('brand-host');
  if (el) el.textContent = h;
  document.title = `LLM Monitor — ${h}`;
}).catch(() => {});

setInterval(pollAll, 5000);
pollAll();

// ── Status ────────────────────────────────────────────────────────────

function renderStatus(host) {
  if (!host) return;
  const ring  = document.getElementById('status-ring');
  const dot   = document.getElementById('pill-dot');
  const label = document.getElementById('pill-label');
  const text  = document.getElementById('status-text');
  const sub   = document.getElementById('status-checked');
  const wake  = document.getElementById('btn-wake');
  const sleep = document.getElementById('btn-sleep');
  const rst   = document.getElementById('btn-restart');

  if (host.alive) {
    ring.className  = 'status-ring alive';
    dot.className   = 'pill-dot alive';
    label.textContent = 'Online';
    text.textContent  = 'Online';
    wake.disabled = true; sleep.disabled = false; rst.disabled = false;
  } else {
    ring.className  = 'status-ring dead';
    dot.className   = 'pill-dot dead';
    label.textContent = 'Offline';
    text.textContent  = 'Powered off';
    wake.disabled = false; sleep.disabled = true; rst.disabled = true;
  }

  sub.textContent = host.checkedAt
    ? 'checked ' + new Date(host.checkedAt).toLocaleTimeString() : '—';
}

// ── Ollama ────────────────────────────────────────────────────────────

function renderOllama(data) {
  const wrap = document.getElementById('ollama-content');
  wrap.textContent = '';

  if (!data) { wrap.appendChild(el('span', 'dim-text', 'Host unavailable')); return; }
  if (data.error) { wrap.appendChild(el('span', 'dim-text', 'Temporarily unavailable')); return; }
  if (!data.models?.length) {
    wrap.appendChild(el('span', 'dim-text', 'No models loaded'));
    return;
  }

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  ['Model', 'Params', 'Quant', 'Processor', 'VRAM', 'Ctx', 'Expires'].forEach(h => {
    hr.appendChild(el('th', null, h));
  });
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const m of data.models) {
    const tr = document.createElement('tr');
    const expires = m.expiresAt ? new Date(m.expiresAt).toLocaleTimeString() : '—';
    const vram    = m.sizeVram  ? gb(m.sizeVram) + ' GB' : '—';
    const ctx     = m.contextLength ? Math.round(m.contextLength / 1000) + 'k' : '—';

    const procCls = m.processor === '100% GPU' ? 'td-gpu'
      : m.processor?.includes('CPU') && m.processor?.includes('GPU') ? 'td-mix'
      : 'td-cpu';

    const cells = [
      ['td-model', shortName(m.name), m.name],
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
    badges.appendChild(el('span', g.temperature > 75 ? 'badge warn' : 'badge', `${g.temperature}°C`));
    badges.appendChild(el('span', 'badge', `${g.powerDraw}W`));
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

// ── Ollama App ────────────────────────────────────────────────────────

function fmt(bytes) {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
  if (bytes >= 1048576)    return (bytes / 1048576).toFixed(0) + ' MB';
  if (bytes >= 1024)       return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}

function renderOllamaApp(data) {
  const wrap = document.getElementById('ollama-app-content');
  wrap.textContent = '';

  if (!data) { wrap.appendChild(el('span', 'dim-text', 'Host unavailable')); return; }
  if (data.error) { wrap.appendChild(el('span', 'dim-text', 'Temporarily unavailable')); return; }

  // Status row
  const statusRow = el('div', 'app-status-row');
  const stateText = (data.state || '').toUpperCase();
  const stateBadge = el('span', `app-state-badge ${stateText === 'RUNNING' ? 'running' : 'stopped'}`, stateText || '—');
  const version = el('span', 'app-version', `v${data.version || '?'}`);
  const updateBadge = el('span', `app-update-badge ${data.upgradeAvailable ? 'update' : 'ok'}`,
    data.upgradeAvailable ? '⬆ Update' : '✓ Up to date');
  statusRow.appendChild(stateBadge);
  statusRow.appendChild(version);
  statusRow.appendChild(updateBadge);
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
  memCard.appendChild(el('div', 'app-stat-sub', `limit ${fmt(memMax)}`));
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

  // Image
  if (data.image) {
    const img = el('div', null);
    img.style.cssText = 'margin-top:10px; font-family:var(--mono); font-size:10px; color:var(--dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
    img.textContent = data.image;
    img.title = data.image;
    wrap.appendChild(img);
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
  const R    = 82;
  const CIRC = 2 * Math.PI * R;

  const segments = [
    { label: 'SERVICES', bytes: services, color: '#2e88ff' },
    { label: 'ZFS ARC',  bytes: arc,      color: '#f59e0b' },
    { label: 'FREE',     bytes: free,     color: '#00c896' },
  ];

  // ── SVG donut ──
  const svg = svgEl('svg', { viewBox: '0 0 200 200', class: 'mem-donut-svg' });

  // Track
  svg.appendChild(svgEl('circle', { cx: 100, cy: 100, r: R, fill: 'none', stroke: 'rgba(255,255,255,.05)', 'stroke-width': 28 }));

  // Counter-clockwise: mirror horizontally around x=100
  const ccw = svgEl('g', { transform: 'translate(200,0) scale(-1,1)' });
  let offset = 0;
  segments.forEach(({ bytes, color }) => {
    const len = total > 0 ? (bytes / total) * CIRC : 0;
    if (len < 0.5) return;
    const circle = svgEl('circle', {
      cx: 100, cy: 100, r: R,
      fill: 'none', stroke: color, 'stroke-width': 26,
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
  const centerVal = svgEl('text', { x: 100, y: 97, 'text-anchor': 'middle', fill: '#dde8f0', 'font-size': 20, 'font-family': 'JetBrains Mono', 'font-weight': 600 });
  centerVal.textContent = totalGb;
  const centerUnit = svgEl('text', { x: 100, y: 115, 'text-anchor': 'middle', fill: '#4a6680', 'font-size': 11, 'font-family': 'JetBrains Mono' });
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

// ── Actions ───────────────────────────────────────────────────────────

async function action(name) {
  const confirmMsg = {
    sleep: 'Shut down the server?',
    'restart-ollama': 'Restart Ollama? Loaded models will be unloaded.',
  }[name];
  if (confirmMsg && !confirm(confirmMsg)) return;

  const msg = document.getElementById('action-msg');
  msg.textContent = { wake: 'Waking up...', sleep: 'Shutting down...', 'restart-ollama': 'Restarting...' }[name] || '...';
  try {
    const res = await apiFetch(`/api/${name}`, { method: 'POST' });
    msg.textContent = res.ok
      ? ({ wake: 'Sent — boot ~3.5 min', sleep: 'Shutting down...', 'restart-ollama': 'Restart queued' }[name] || 'OK')
      : 'Error: ' + (res.error || '?');
  } catch (e) {
    msg.textContent = 'Error: ' + e.message;
  }
  setTimeout(() => { msg.textContent = ''; }, 8000);
}
