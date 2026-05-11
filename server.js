import express from 'express';
import { router } from './src/routes.js';
import './src/config.js'; // load dotenv + validate env vars before anything else

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());

app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.use('/api', router);
app.use(express.static('public'));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`llm-local-monitor running on :${PORT}`);
});
