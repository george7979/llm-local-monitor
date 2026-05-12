import { cfg } from '../config.js';

const REPO    = 'george7979/llm-local-monitor';
const TTL_MS  = 60 * 60 * 1000; // 1 hour

let _cache   = null;
let _cacheTs = 0;

export async function checkUpdate() {
  if (_cache && Date.now() - _cacheTs < TTL_MS) return _cache;

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
    const updateAvailable = !!latest && latest !== cfg.version;
    _cache = { current: cfg.version, latest, updateAvailable, releaseUrl: data.html_url || null };
  } catch {
    _cache = { current: cfg.version, latest: null, updateAvailable: false, releaseUrl: null };
  }

  _cacheTs = Date.now();
  return _cache;
}
