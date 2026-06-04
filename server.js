const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;
const SEMRUSH_KEY = process.env.SEMRUSH_KEY || '';
const BRIGHTLOCAL_KEY = process.env.BRIGHTLOCAL_KEY || '';
const BL_BASE = 'https://tools.brightlocal.com/seo-tools/api';

app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => res.json({ ok: true }));

// ── SEMrush domain overview ──────────────────────────────────────────────────
app.get('/semrush/domain', async (req, res) => {
  const { domain } = req.query;
  if (!domain) return res.status(400).json({ error: 'domain required' });
  try {
    const r = await fetch(`https://api.semrush.com/?type=domain_rank&key=${SEMRUSH_KEY}&export_columns=Dn,Rk,Or,Ot&domain=${domain}&database=us`);
    res.type('text/plain').send(await r.text());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SEMrush listing management ───────────────────────────────────────────────
app.get('/semrush/listings', async (req, res) => {
  const { domain } = req.query;
  if (!domain) return res.status(400).json({ error: 'domain required' });
  try {
    const r = await fetch(`https://api.semrush.com/?type=listing_management_listings&key=${SEMRUSH_KEY}&domain=${domain}`);
    res.type('text/plain').send(await r.text());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── BrightLocal GBP + listing data ──────────────────────────────────────────
// Uses the batch API: create → add jobs → commit → poll → return results
app.get('/brightlocal/gbp', async (req, res) => {
  const { name, url, city, postcode } = req.query;
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!BRIGHTLOCAL_KEY) return res.status(500).json({ error: 'BrightLocal key not configured' });

  try {
    // Step 1: Create batch
    const batchRes = await fetch(`${BL_BASE}/v4/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `api-key=${BRIGHTLOCAL_KEY}`
    });
    const batchData = await batchRes.json();
    if (!batchData.success) return res.status(500).json({ error: 'BrightLocal batch creation failed', detail: batchData });
    const batchId = batchData['batch-id'];

    // Step 2: Add GBP profile fetch job
    const jobBody = new URLSearchParams({
      'api-key': BRIGHTLOCAL_KEY,
      'batch-id': batchId,
      'local-directory': 'google',
      'business-names': name,
      'country': 'USA',
      'city': city || '',
      'postcode': postcode || '',
      'website-url': url || ''
    });
    const jobRes = await fetch(`${BL_BASE}/v4/ld/fetch-profile-details-by-business-data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: jobBody.toString()
    });
    const jobData = await jobRes.json();

    // Step 3: Commit batch
    await fetch(`${BL_BASE}/v4/batch`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `api-key=${BRIGHTLOCAL_KEY}&batch-id=${batchId}`
    });

    // Step 4: Poll for results (max 30s)
    let results = null;
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const pollRes = await fetch(`${BL_BASE}/v4/batch?api-key=${BRIGHTLOCAL_KEY}&batch-id=${batchId}`);
      const pollData = await pollRes.json();
      if (pollData.status === 'Finished' || pollData.status === 'Stopped') {
        results = pollData;
        break;
      }
    }

    if (!results) return res.status(408).json({ error: 'BrightLocal timed out' });
    res.json(results);
  } catch (e) {
    console.error('BrightLocal error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── BrightLocal Google Reviews ───────────────────────────────────────────────
app.get('/brightlocal/reviews', async (req, res) => {
  const { name, city, postcode } = req.query;
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!BRIGHTLOCAL_KEY) return res.status(500).json({ error: 'BrightLocal key not configured' });

  try {
    // Create batch
    const batchRes = await fetch(`${BL_BASE}/v4/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `api-key=${BRIGHTLOCAL_KEY}`
    });
    const batchData = await batchRes.json();
    if (!batchData.success) return res.status(500).json({ error: 'batch failed' });
    const batchId = batchData['batch-id'];

    // Add review fetch job
    const jobBody = new URLSearchParams({
      'api-key': BRIGHTLOCAL_KEY,
      'batch-id': batchId,
      'local-directory': 'google',
      'business-names': name,
      'country': 'USA',
      'city': city || '',
      'postcode': postcode || '',
      'reviews-limit': '10'
    });
    await fetch(`${BL_BASE}/v4/ld/fetch-reviews-by-business-data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: jobBody.toString()
    });

    // Commit
    await fetch(`${BL_BASE}/v4/batch`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `api-key=${BRIGHTLOCAL_KEY}&batch-id=${batchId}`
    });

    // Poll
    let results = null;
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const pollRes = await fetch(`${BL_BASE}/v4/batch?api-key=${BRIGHTLOCAL_KEY}&batch-id=${batchId}`);
      const pollData = await pollRes.json();
      if (pollData.status === 'Finished' || pollData.status === 'Stopped') {
        results = pollData;
        break;
      }
    }

    if (!results) return res.status(408).json({ error: 'timed out' });
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
