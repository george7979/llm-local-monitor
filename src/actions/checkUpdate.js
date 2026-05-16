import { cfg } from '../config.js';

const REPO    = 'george7979/llm-local-monitor';
const TTL_MS  = 60 * 60 * 1000; // 1 hour

function semverGt(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

let _cache   = null;
let _cacheTs = 0;

export async function checkUpdate() {
  if (_cache && Date.now() - _cacheTs < TTL_MS) return _cache;

  if (cfg.version.includes('-')) {
    return { current: cfg.version, latest: null, updateAvailable: false, releaseUrl: null };
  }

  try {
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/releases/latest`,
      {
        headers: { 'User-Agent': `llm-local-monitor/${cfg.version}` },
        signal: AbortSignal.timeout(8_000),
      }
    );
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const data = await res.json();
    const latest = (data.tag_name || '').replace(/^v/, '');
    const updateAvailable = !!latest && semverGt(latest, cfg.version);
    _cache = { current: cfg.version, latest, updateAvailable, releaseUrl: data.html_url || null };
  } catch {
    _cache = { current: cfg.version, latest: null, updateAvailable: false, releaseUrl: null };
  }

  _cacheTs = Date.now();
  return _cache;
}
