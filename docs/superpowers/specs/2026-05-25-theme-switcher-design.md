# Design Spec: Light Theme & Theme Switcher

**Date:** 2026-05-25  
**Status:** Approved  

---

## Goal

Add a light theme (Blue-Gray palette) and a toggle button to the LLM Monitor dashboard. Theme auto-detects from the user's OS `prefers-color-scheme` on first visit; manual choice is saved to `localStorage`.

---

## Decisions Made

| Topic | Decision |
|-------|----------|
| Light palette | Blue-Gray (GitHub-like): cold, systematic |
| Toggle button | Round icon-only button (☀ / ☾), in `header-right` before `host-pill` |
| Technical approach | `data-theme` attribute on `<html>` + `public/theme.js` + `localStorage` |

---

## Color Palette — Light Theme (Blue-Gray)

CSS variables that override the dark defaults:

```css
[data-theme="light"] {
  --bg:        #f6f8fa;
  --bg2:       #eef1f4;
  --card:      #ffffff;
  --card2:     #f6f8fa;
  --border:    #d0d7de;
  --border2:   #bdc5cd;
  --text:      #1f2328;
  --dim:       #57606a;
  --accent:    #0969da;
  --green:     #1a7f37;
  --amber:     #9a6700;
  --red:       #cf222e;
  --purple:    #6e40c9;
}
```

---

## Files Changed

### 1. `public/theme.js` (new)

IIFE (~35 lines) that:
1. Reads `localStorage.getItem('llm-monitor-theme')` — uses it if present
2. Falls back to `window.matchMedia('(prefers-color-scheme: light)')` on first visit
3. Sets `document.documentElement.setAttribute('data-theme', theme)` immediately (before body renders, avoiding FOUC)
4. Exposes `window.toggleTheme()` for the button's `onclick`
5. Listens for OS `prefers-color-scheme` changes — only applies them when no manual preference is saved

Button icon logic: dark mode shows ☀ (click → go light), light mode shows ☾ (click → go dark).

### 2. `public/index.html`

Two changes:
- Add `<script src="theme.js"></script>` in `<head>`, **before** `<link rel="stylesheet" href="styles.css">` to prevent FOUC
- Add theme toggle button in `.header-right`, before `#host-pill`:
  ```html
  <button id="btn-theme" class="theme-toggle" onclick="toggleTheme()" aria-label="Toggle theme">☀</button>
  ```

### 3. `public/styles.css`

Two additions at the end of the file:

**a) Light theme variable overrides** — `[data-theme="light"]` block with the palette above.

**b) Light theme structural overrides** — several rules use hardcoded colors instead of CSS variables and need explicit overrides for `[data-theme="light"]`:

| Selector | Hardcoded value | Light override |
|----------|----------------|----------------|
| `header` background | `rgba(13,17,23,.96)` | `rgba(246,248,250,.97)` |
| `body` background-image gradients | dark blue/purple tints | lighter, near-transparent tints |
| `.brand-name` | `#dde8f0` | `var(--text)` |
| `.status-text` | `#dde8f0` | `var(--text)` |
| `.app-stat-val` | `#dde8f0` | `var(--text)` |
| `.mem-legend-gb` | `#dde8f0` | `var(--text)` |
| `.bar-track` | `rgba(255,255,255,.05)` | `rgba(0,0,0,.06)` |
| `.td-model` | `#7aabcc` | `#0550ae` (darker blue) |
| `.gpu-card-name` | `#7a9ab8` | `#424a53` |

**c) Theme toggle button styles** — `.theme-toggle` class:
- Shared: round (50%), 28×28px, no border outline from global `button` reset
- Dark: `background: rgba(255,255,255,.06)`, `border: 1px solid var(--border2)`, `color: var(--dim)`
- Light: same structure, colors derived from light vars
- Hover: subtle fill, `color: var(--text)`

---

## Behavior

| Scenario | Result |
|----------|--------|
| First visit, OS dark | Dark theme loads, ☀ icon shown |
| First visit, OS light | Light theme loads, ☾ icon shown |
| User clicks toggle | Theme flips, choice saved to `localStorage` |
| User revisits | `localStorage` preference used, ignoring OS |
| OS changes while no preference saved | Theme follows OS change live |

---

## Scope — Out of Scope

- No "Auto" third state (YAGNI — two states are enough)
- No CSS transitions on theme change (values switch instantly — adding transitions risks layout flash on complex props)
- No server-side theme preference
