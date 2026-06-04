// GrowthLine SEMrush Proxy Server
// Bypasses CORS so the app can call SEMrush API directly
// Deploy free on: Railway, Render, or Fly.io

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3001;
const SEMRUSH_KEY = process.env.SEMRUSH_KEY || '';

app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => res.json({ ok: true }));

// SEMrush domain overview
app.get('/semrush/domain', async (req, res) => {
  const { domain } = req.query;
  if (!domain) return res.status(400).json({ error: 'domain required' });
  try {
    const url = `https://api.semrush.com/?type=domain_rank&key=${SEMRUSH_KEY}&export_columns=Dn,Rk,Or,Ot&domain=${domain}&database=us`;
    const r = await fetch(url);
    const text = await r.text();
    res.type('text/plain').send(text);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// SEMrush listing management
app.get('/semrush/listings', async (req, res) => {
  const { domain } = req.query;
  if (!domain) return res.status(400).json({ error: 'domain required' });
  try {
    const url = `https://api.semrush.com/?type=listing_management_listings&key=${SEMRUSH_KEY}&domain=${domain}`;
    const r = await fetch(url);
    const text = await r.text();
    res.type('text/plain').send(text);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
