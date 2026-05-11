import { cfg } from '../config.js';

export function requireApiKey(req, res, next) {
  const token = req.get('X-API-Key');
  if (!token || token !== cfg.apiKey) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}
