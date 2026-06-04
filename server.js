const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;
const SEMRUSH_KEY     = process.env.SEMRUSH_KEY     || '';
const BRIGHTLOCAL_KEY = process.env.BRIGHTLOCAL_KEY || '';
const SOCIALFETCH_KEY = process.env.SOCIALFETCH_KEY || '';
const BL_BASE         = 'https://tools.brightlocal.com/seo-tools/api';
const SF_BASE         = 'https://api.socialfetch.dev/v1';

app.use(cors({ origin: "*", methods: ["GET","POST","OPTIONS"], allowedHeaders: ["Content-Type","Authorization"] }));
app.options("*", cors());
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
// Uses the confirmed working v4 batch API with fetch-profile-details-by-business-data
async function blBatch(apiKey, jobEndpoint, jobParams) {
  // Step 1: Create batch
  const bRes = await fetch(`${BL_BASE}/v4/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `api-key=${apiKey}`
  });
  const bData = await bRes.json();
  if (!bData.success) throw new Error('Batch create failed: ' + JSON.stringify(bData));
  const batchId = bData['batch-id'];

  // Step 2: Add job
  const jobBody = new URLSearchParams({ 'api-key': apiKey, 'batch-id': batchId, ...jobParams });
  const jRes = await fetch(`${BL_BASE}${jobEndpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: jobBody.toString()
  });
  const jData = await jRes.json();
  if (!jData.success) {
    console.error('BrightLocal job add failed:', JSON.stringify(jData));
    // Try to continue anyway — some BrightLocal errors are non-fatal
    if (!jData['job-id']) throw new Error('Job add failed: ' + JSON.stringify(jData));
  }

  // Step 3: Commit
  await fetch(`${BL_BASE}/v4/batch`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `api-key=${apiKey}&batch-id=${batchId}`
  });

  // Step 4: Poll up to 60s
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const pRes = await fetch(`${BL_BASE}/v4/batch?api-key=${apiKey}&batch-id=${batchId}`);
    const pData = await pRes.json();
    if (pData.status === 'Finished' || pData.status === 'Stopped') return pData;
  }
  throw new Error('Batch timed out');
}

app.get('/brightlocal/gbp', async (req, res) => {
  const { name, url } = req.query;
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!BRIGHTLOCAL_KEY) return res.status(500).json({ error: 'BrightLocal key not configured' });

  try {
    // Use fetch-profile-details-by-business-data — confirmed v4 endpoint
    // Falls back to fetch-reviews-by-business-data if needed
    const results = await blBatch(BRIGHTLOCAL_KEY, '/v4/ld/fetch-reviews-by-business-data', {
      'local-directory': 'google',
      'business-names':  name,
      'country':         'USA',
      'website-url':     url || '',
      'city':            '',
      'postcode':        '',
      'reviews-limit':   '1'
    });
    res.json(results);
  } catch (e) {
    console.error('BrightLocal GBP error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── SocialFetch ───────────────────────────────────────────────────────────────
async function sfGet(path) {
  const r = await fetch(`${SF_BASE}${path}`, { headers: { 'x-api-key': SOCIALFETCH_KEY } });
  if (!r.ok) {
    const err = await r.text();
    console.error(`SocialFetch ${r.status} for ${path}:`, err.slice(0, 200));
    return null;
  }
  return r.json();
}

function ensureUrl(val, base) {
  if (!val) return null;
  if (val.startsWith('http')) return val;
  return base + val.replace(/^\/+/, '');
}

app.get('/social/profiles', async (req, res) => {
  const { fb, li, ig, yt } = req.query;
  if (!SOCIALFETCH_KEY) return res.status(500).json({ error: 'SocialFetch key not configured' });

  const out = {};
  const calls = [];

  if (fb) {
    const url = ensureUrl(fb, 'https://www.facebook.com/');
    calls.push(sfGet(`/facebook/profiles?url=${encodeURIComponent(url)}`).then(d => { if (d) out.facebook = d; }).catch(() => {}));
  }
  if (li) {
    const url = ensureUrl(li, 'https://www.linkedin.com/company/');
    calls.push(sfGet(`/linkedin/companies?url=${encodeURIComponent(url)}`).then(d => { if (d) out.linkedin = d; }).catch(() => {}));
  }
  if (ig) {
    const handle = ig.replace(/^@/, '').replace(/.*instagram\.com\//, '').replace(/\/$/, '');
    calls.push(sfGet(`/instagram/profiles/${encodeURIComponent(handle)}`).then(d => { if (d) out.instagram = d; }).catch(() => {}));
  }
  if (yt) {
    const handle = yt.replace(/^@/, '').replace(/.*youtube\.com\/@?/, '').replace(/\/$/, '');
    const url = `https://www.youtube.com/@${handle}`;
    calls.push(sfGet(`/youtube/channel?url=${encodeURIComponent(url)}`).then(d => { if (d) out.youtube = d; }).catch(() => {}));
  }

  await Promise.allSettled(calls);
  res.json(out);
});

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
