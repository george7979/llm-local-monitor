# Theme Switcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Blue-Gray light theme and a round icon toggle button that auto-detects `prefers-color-scheme` and persists the choice to `localStorage`.

**Architecture:** `data-theme` attribute on `<html>` drives all CSS via a `[data-theme="light"]` override block. A small IIFE in `public/theme.js` (loaded synchronously in `<head>`) handles detection, persistence, and toggling. No build step, no framework.

**Tech Stack:** Vanilla JS (IIFE), CSS Custom Properties, `localStorage`, `matchMedia`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `public/theme.js` | **Create** | Theme detection, `localStorage` load/save, `toggleTheme()` global |
| `public/index.html` | **Modify** | Add `<script src="theme.js">` in `<head>` + toggle button in `.header-right` |
| `public/styles.css` | **Modify** | `[data-theme="light"]` variable block, structural overrides, `.theme-toggle` button styles |

---

## Task 1: Create `public/theme.js`

**Files:**
- Create: `public/theme.js`

- [ ] **Step 1: Create `public/theme.js` with the full IIFE**

```js
(function () {
  var KEY  = 'llm-monitor-theme';
  var html = document.documentElement;
  var mq   = window.matchMedia('(prefers-color-scheme: light)');

  function apply(theme) {
    html.setAttribute('data-theme', theme);
    var btn = document.getElementById('btn-theme');
    if (btn) btn.textContent = theme === 'light' ? '☽' : '☀';
  }

  function load() {
    return localStorage.getItem(KEY) || (mq.matches ? 'light' : 'dark');
  }

  window.toggleTheme = function () {
    var next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    localStorage.setItem(KEY, next);
    apply(next);
  };

  mq.addEventListener('change', function (e) {
    if (!localStorage.getItem(KEY)) apply(e.matches ? 'light' : 'dark');
  });

  apply(load());
}());
```

> **Icon logic:** ☀ (U+2600) shown in dark mode — click to go light. ☽ (U+263D) shown in light mode — click to go dark.
> **FOUC prevention:** `apply(load())` runs synchronously before first paint because the script is blocking (no `defer`/`async`).

- [ ] **Step 2: Wire script into `public/index.html` — add in `<head>` BEFORE the CSS link**

Find this in `<head>`:
```html
  <link rel="stylesheet" href="styles.css">
```
Replace with:
```html
  <script src="theme.js"></script>
  <link rel="stylesheet" href="styles.css">
```

> Script before CSS ensures `data-theme` is on `<html>` before the browser downloads the stylesheet, so no flash on first render.

- [ ] **Step 3: Start dev server and verify auto-detect**

```bash
npm run dev
```

Open `http://localhost:3788` in browser. Open DevTools → Elements → inspect `<html>`. Confirm `data-theme="dark"` (or `"light"` if your OS is in light mode). Change OS appearance; without any manual toggle, `data-theme` should follow the OS change.

- [ ] **Step 4: Commit**

```bash
git add public/theme.js public/index.html
git commit -m "feat: add theme.js with auto-detect and localStorage persistence"
```

---

## Task 2: Add toggle button to HTML + button CSS

**Files:**
- Modify: `public/index.html` (`.header-right` section)
- Modify: `public/styles.css` (add `.theme-toggle` styles)

- [ ] **Step 1: Add the button to `public/index.html`**

Find this in `.header-right`:
```html
  <div class="header-right">
    <a id="app-version" class="app-version-badge" href="https://github.com/george7979/llm-local-monitor" target="_blank" rel="noopener"></a>
    <a id="update-badge" class="update-available-badge" style="display:none" target="_blank" rel="noopener"></a>
    <div class="host-pill" id="host-pill">
```
Replace with:
```html
  <div class="header-right">
    <a id="app-version" class="app-version-badge" href="https://github.com/george7979/llm-local-monitor" target="_blank" rel="noopener"></a>
    <a id="update-badge" class="update-available-badge" style="display:none" target="_blank" rel="noopener"></a>
    <button id="btn-theme" class="theme-toggle" onclick="toggleTheme()" aria-label="Toggle theme">&#9728;</button>
    <div class="host-pill" id="host-pill">
```

> `&#9728;` = ☀ (sun). `theme.js` updates the icon on load and on every toggle, so the initial value is a placeholder that gets replaced immediately.

- [ ] **Step 2: Add `.theme-toggle` CSS to `public/styles.css`**

Append at the very end of `styles.css`:

```css
/* ── THEME TOGGLE ──────────────────────────── */

.theme-toggle {
  width: 28px; height: 28px;
  border-radius: 50%;
  padding: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 14px; line-height: 1;
  flex-shrink: 0;
}
.theme-toggle:hover:not(:disabled) {
  background: var(--border);
  border-color: var(--accent);
  color: var(--text);
}
```

> The global `button` rule already provides `border`, `background`, `color`, `cursor`, and `transition`. `.theme-toggle` only overrides the geometry (`width`, `height`, `border-radius`, `padding`) and `justify-content` needed for the round shape. The hover rule overrides the global hover (which tints with `var(--accent)` color — we want `var(--text)` instead for neutral icon).

- [ ] **Step 3: Verify button in browser**

Reload `http://localhost:3788`. Confirm:
- Round button appears in the header between version badge and the host pill
- Icon is ☀ (dark mode) or ☽ (light mode)
- Clicking toggles the icon
- Hard-refreshing the page preserves the last-chosen theme (from `localStorage`)

- [ ] **Step 4: Commit**

```bash
git add public/index.html public/styles.css
git commit -m "feat: add theme toggle button to header"
```

---

## Task 3: Add light theme CSS variables

**Files:**
- Modify: `public/styles.css` (append after `.theme-toggle` block)

- [ ] **Step 1: Append `[data-theme="light"]` variable block to `styles.css`**

```css
/* ── LIGHT THEME ───────────────────────────── */

[data-theme="light"] {
  --bg:      #f6f8fa;
  --bg2:     #eef1f4;
  --card:    #ffffff;
  --card2:   #f6f8fa;
  --border:  #d0d7de;
  --border2: #bdc5cd;
  --text:    #1f2328;
  --dim:     #57606a;
  --accent:  #0969da;
  --green:   #1a7f37;
  --amber:   #9a6700;
  --red:     #cf222e;
  --purple:  #6e40c9;
}
```

- [ ] **Step 2: Verify in browser — switch to light mode**

Click the toggle button. Confirm:
- Background changes from near-black to light gray (`#f6f8fa`)
- Card backgrounds become white
- Borders become light gray
- Accent color becomes GitHub-blue (`#0969da`)
- Status indicators (green/amber/red) become appropriately darker for light backgrounds

Note: at this step some text will still appear too light (hardcoded `#dde8f0` values) — that is fixed in Task 4.

- [ ] **Step 3: Commit**

```bash
git add public/styles.css
git commit -m "feat: add light theme CSS variable overrides (Blue-Gray palette)"
```

---

## Task 4: Fix hardcoded colors — structural CSS overrides

**Files:**
- Modify: `public/styles.css` (append to the light theme section)

The following selectors use hardcoded hex values instead of CSS variables. They look correct on the dark background but break on light. Each override must be added inside (or immediately after) the `[data-theme="light"]` block.

- [ ] **Step 1: Add all structural overrides as one block after the variable block**

```css
/* header: hardcoded rgba dark background */
[data-theme="light"] header {
  background: rgba(246,248,250,.97);
}

/* body: dark tinted gradients become near-invisible light tints */
[data-theme="light"] body {
  background-image:
    radial-gradient(ellipse 60% 40% at 10% -10%, rgba(9,105,218,.04) 0%, transparent 60%),
    radial-gradient(ellipse 40% 40% at 90% 110%, rgba(110,64,201,.03) 0%, transparent 60%);
}

/* hardcoded #dde8f0 (near-white) — invisible on white card */
[data-theme="light"] .brand-name   { color: var(--text); }
[data-theme="light"] .status-text  { color: var(--text); }
[data-theme="light"] .app-stat-val { color: var(--text); }
[data-theme="light"] .mem-legend-gb { color: var(--text); }

/* bar track: rgba(255,255,255,.05) invisible on white */
[data-theme="light"] .bar-track { background: rgba(0,0,0,.08); }

/* table row divider: dark blue rgba */
[data-theme="light"] tbody td { border-bottom: 1px solid var(--border); }

/* .td-model: #7aabcc too light on white */
[data-theme="light"] .td-model { color: #0550ae; }

/* .gpu-card-name: #7a9ab8 too light on white */
[data-theme="light"] .gpu-card-name { color: #424a53; }
```

- [ ] **Step 2: Verify all panels in light mode**

Click toggle to light mode and check each dashboard section:

| Section | What to verify |
|---------|---------------|
| Header | Light gray background, all text readable |
| SERVER card | "ONLINE" badge readable, button borders visible |
| RAM card | Donut chart visible, legend text readable |
| LAN PORTS | Histogram visible, port names readable |
| OLLAMA APP | Stat grid cells have borders, values readable |
| LOADED MODELS table | All columns readable, row dividers visible |
| GPU cards | Bar tracks visible as subtle gray, VRAM value readable, GPU name not washed out |

Also verify dark mode still looks correct by toggling back.

- [ ] **Step 3: Commit**

```bash
git add public/styles.css
git commit -m "fix: override hardcoded dark colors for light theme"
```

---

## Task 5: Final verification — full end-to-end checklist

**Files:** none (verification only)

- [ ] **Step 1: Test OS auto-detect (no `localStorage` key)**

Open browser DevTools → Application → Local Storage → delete `llm-monitor-theme` key. Hard-refresh. Confirm theme matches OS setting.

- [ ] **Step 2: Test manual override persists**

Click toggle. Hard-refresh. Confirm the manually chosen theme is restored (not OS theme).

- [ ] **Step 3: Test OS change while on "auto" (no `localStorage` key)**

Delete `llm-monitor-theme` from localStorage again. Without refreshing, change OS appearance. Confirm page theme switches live.

- [ ] **Step 4: Confirm no console errors in either theme**

Open DevTools → Console. Toggle between themes several times. Zero errors expected.

- [ ] **Step 5: Final commit**

```bash
git status
```
Expected: clean tree (all changes committed in Tasks 1–4).

If clean:
```bash
git log --oneline -5
```
Expected to see 4 commits from this feature.
