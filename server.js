const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;
const SEMRUSH_KEY     = process.env.SEMRUSH_KEY     || '';
const BRIGHTLOCAL_KEY = process.env.BRIGHTLOCAL_KEY || '';
const SOCIALFETCH_KEY = process.env.SOCIALFETCH_KEY || '';
const BL_BASE         = 'https://tools.brightlocal.com/seo-tools/api';
const SF_BASE         = 'https://api.socialfetch.dev/v1';

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));

// ── SEMrush ───────────────────────────────────────────────────────────────────
app.get('/semrush/domain', async (req, res) => {
  const { domain } = req.query;
  if (!domain) return res.status(400).json({ error: 'domain required' });
  try {
    const r = await fetch(`https://api.semrush.com/?type=domain_rank&key=${SEMRUSH_KEY}&export_columns=Dn,Rk,Or,Ot&domain=${domain}&database=us`);
    res.type('text/plain').send(await r.text());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/semrush/listings', async (req, res) => {
  const { domain } = req.query;
  if (!domain) return res.status(400).json({ error: 'domain required' });
  try {
    const r = await fetch(`https://api.semrush.com/?type=listing_management_listings&key=${SEMRUSH_KEY}&domain=${domain}`);
    res.type('text/plain').send(await r.text());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── BrightLocal GBP ───────────────────────────────────────────────────────────
app.get('/brightlocal/gbp', async (req, res) => {
  const { name, url, city, postcode } = req.query;
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!BRIGHTLOCAL_KEY) return res.status(500).json({ error: 'BrightLocal key not configured' });
  try {
    const batchRes = await fetch(`${BL_BASE}/v4/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `api-key=${BRIGHTLOCAL_KEY}`
    });
    const batchData = await batchRes.json();
    if (!batchData.success) return res.status(500).json({ error: 'batch failed', detail: batchData });
    const batchId = batchData['batch-id'];
    const jobBody = new URLSearchParams({
      'api-key': BRIGHTLOCAL_KEY, 'batch-id': batchId,
      'local-directory': 'google', 'business-names': name,
      'country': 'USA', 'city': city || '', 'postcode': postcode || '',
      'website-url': url || ''
    });
    await fetch(`${BL_BASE}/v4/ld/fetch-profile-details-by-business-data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: jobBody.toString()
    });
    await fetch(`${BL_BASE}/v4/batch`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `api-key=${BRIGHTLOCAL_KEY}&batch-id=${batchId}`
    });
    let results = null;
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const pollRes = await fetch(`${BL_BASE}/v4/batch?api-key=${BRIGHTLOCAL_KEY}&batch-id=${batchId}`);
      const pollData = await pollRes.json();
      if (pollData.status === 'Finished' || pollData.status === 'Stopped') { results = pollData; break; }
    }
    if (!results) return res.status(408).json({ error: 'timed out' });
    res.json(results);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SocialFetch helper ────────────────────────────────────────────────────────
async function sfGet(path) {
  const r = await fetch(`${SF_BASE}${path}`, { headers: { 'x-api-key': SOCIALFETCH_KEY } });
  if (!r.ok) { console.error('SocialFetch error', r.status, path); return null; }
  return r.json();
}

// Helper: ensure URL has protocol
function toUrl(handle, base) {
  if (!handle) return null;
  if (handle.startsWith('http')) return handle;
  return base + handle.replace(/^\//, '');
}

// ── SocialFetch profiles endpoint ─────────────────────────────────────────────
// Accepts full URLs or handles — normalises before calling API
app.get('/social/profiles', async (req, res) => {
  const { fb, li, ig, yt } = req.query;
  if (!SOCIALFETCH_KEY) return res.status(500).json({ error: 'SocialFetch key not configured' });

  const results = {};
  const calls = [];

  // Facebook — needs full URL: /v1/facebook/profiles?url=...
  if (fb) {
    const fbUrl = toUrl(fb, 'https://www.facebook.com/');
    calls.push(
      sfGet(`/facebook/profiles?url=${encodeURIComponent(fbUrl)}`)
        .then(d => { if (d) results.facebook = d; })
        .catch(() => {})
    );
  }

  // LinkedIn — needs full URL: /v1/linkedin/companies?url=...
  if (li) {
    const liUrl = toUrl(li, 'https://www.linkedin.com/company/');
    calls.push(
      sfGet(`/linkedin/companies?url=${encodeURIComponent(liUrl)}`)
        .then(d => { if (d) results.linkedin = d; })
        .catch(() => {})
    );
  }

  // Instagram — handle in path: /v1/instagram/profiles/{handle}
  if (ig) {
    const igHandle = ig.replace(/^@/, '').replace(/.*instagram\.com\//, '').replace(/\/$/, '');
    calls.push(
      sfGet(`/instagram/profiles/${encodeURIComponent(igHandle)}`)
        .then(d => { if (d) results.instagram = d; })
        .catch(() => {})
    );
  }

  // YouTube — handle in path: /v1/youtube/channel?url=... or handle
  if (yt) {
    const ytHandle = yt.replace(/^@/, '').replace(/.*youtube\.com\/@?/, '').replace(/\/$/, '');
    calls.push(
      sfGet(`/youtube/channel?url=${encodeURIComponent('https://www.youtube.com/@' + ytHandle)}`)
        .then(d => { if (d) results.youtube = d; })
        .catch(() => {})
    );
  }

  await Promise.allSettled(calls);
  res.json(results);
});

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
