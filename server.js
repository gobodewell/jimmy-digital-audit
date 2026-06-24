const express = require('express');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3001;

const DFS_LOGIN    = process.env.DATAFORSEO_LOGIN    || '';
const DFS_PASSWORD = process.env.DATAFORSEO_PASSWORD || '';
const SF_KEY       = process.env.SOCIALFETCH_KEY     || '';
const GOOGLE_KEY   = process.env.GOOGLE_API_KEY       || '';
const SF_BASE      = 'https://api.socialfetch.dev/v1';
const DFS_BASE     = 'https://api.dataforseo.com/v3';

const AUDIT_KEY     = process.env.AUDIT_KEY      || '';   // shared secret the app must send
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY  || '';   // AI reviews, server-side
const AIRTABLE_TOKEN= process.env.AIRTABLE_TOKEN || '';   // Airtable push, server-side

app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type','Authorization','X-Audit-Key'] }));
app.options('*', cors());
app.use(express.json());

// ── Auth gate ─────────────────────────────────────────────────────────────────
// If AUDIT_KEY is set, every request (except /health and CORS preflight) must
// send a matching X-Audit-Key header. Keeps the proxy — and your paid DataForSEO
// and Anthropic usage — private even though CORS is open. If AUDIT_KEY is unset
// the gate is skipped (back-compatible), so set it in Render to lock things down.
app.use((req, res, next) => {
  if (req.method === 'OPTIONS' || req.path === '/health') return next();
  if (!AUDIT_KEY) return next();
  if ((req.get('X-Audit-Key') || '') !== AUDIT_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

// ── Auth helper ───────────────────────────────────────────────────────────────
function dfsAuth() {
  return 'Basic ' + Buffer.from(DFS_LOGIN + ':' + DFS_PASSWORD).toString('base64');
}

async function dfsPost(path, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const r = await fetch(DFS_BASE + path, {
      method:  'POST',
      headers: { 'Authorization': dfsAuth(), 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  controller.signal
    });
    clearTimeout(timeout);
    return r.json();
  } catch(e) {
    clearTimeout(timeout);
    throw e;
  }
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, dfs: !!DFS_LOGIN, sf: !!SF_KEY, ai: !!ANTHROPIC_KEY, at: !!AIRTABLE_TOKEN, locked: !!AUDIT_KEY }));

// ── 1. Domain overview — DA, keywords, traffic ────────────────────────────────
// Endpoint: /v3/dataforseo_labs/google/domain_rank_overview/live
app.get('/domain/overview', async (req, res) => {
  const { domain } = req.query;
  if (!domain) return res.status(400).json({ error: 'domain required' });
  if (!DFS_LOGIN) return res.status(500).json({ error: 'DataForSEO not configured' });
  try {
    const d = await dfsPost('/dataforseo_labs/google/domain_rank_overview/live', [
      { target: domain, location_code: 2840, language_code: 'en' }
    ]);
    console.log('DFS domain full response:', JSON.stringify(d)?.slice(0, 500));
    const task = d?.tasks?.[0];
    // Surface a real reason when DataForSEO didn't return usable data.
    if (task && task.status_code !== 20000) {
      return res.json({ da: 0, keywords: 0, traffic: 0, note: 'DataForSEO ' + task.status_code + ': ' + task.status_message });
    }
    const item = task?.result?.[0]?.items?.[0];
    console.log('DFS domain raw item:', JSON.stringify(item)?.slice(0, 300));
    if (!item) return res.json({ da: 0, keywords: 0, traffic: 0, note: 'no data for this domain' });
    const organic = item.metrics?.organic || item.organic || {};
    // NOTE: domain_rank_overview does NOT return a domain-authority "rank" field,
    // so `da` is essentially always 0 here. Real DA needs the Backlinks API.
    const da = item.rank || item.domain_rank || 0;
    const keywords = organic.count || ((organic.pos_1||0) + (organic.pos_2_3||0) + (organic.pos_4_10||0)) || 0;
    const traffic = Math.round(organic.etv || organic.estimated_traffic || 0);
    res.json({ da, keywords, traffic });
  } catch (e) {
    console.error('DFS domain/overview error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 2. PageSpeed — page speed, size, mobile, HTTPS, meta, indexable, GA, images
// Using Google PageSpeed Insights API (free, reliable, no CORS issues)
app.get('/site/lighthouse', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const psUrl = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=' +
      encodeURIComponent(url) + '&strategy=mobile' + (GOOGLE_KEY ? '&key=' + GOOGLE_KEY : '');
    console.log('PageSpeed fetching:', psUrl.slice(0, 100));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const r = await fetch(psUrl, { signal: controller.signal });
    clearTimeout(timeout);
    const d = await r.json();
    console.log('PageSpeed response status:', d?.lighthouseResult ? 'ok' : JSON.stringify(d?.error || d?.message || 'no lighthouse result'));
    const audits = d?.lighthouseResult?.audits;
    const cats   = d?.lighthouseResult?.categories;
    if (!audits) return res.status(500).json({ error: 'No PageSpeed data returned', detail: d?.error || d?.message });

    // Extract the metrics we need for the audit checklist
    const lcp      = audits['largest-contentful-paint']?.numericValue;
    const fcp      = audits['first-contentful-paint']?.numericValue;
    const tbt      = audits['total-blocking-time']?.numericValue;
    const speed    = lcp ? (lcp / 1000).toFixed(2) : fcp ? (fcp / 1000).toFixed(2) : null;
    const totalBytes = audits['total-byte-weight']?.numericValue;
    const sizeMB   = totalBytes ? (totalBytes / 1024 / 1024).toFixed(2) : null;
    const perfScore = cats?.performance?.score != null ? Math.round(cats.performance.score * 100) : null;
    const seoScore  = cats?.seo?.score          != null ? Math.round(cats.seo.score * 100)         : null;

    // Boolean checks
    const isHttps     = url.startsWith('https');
    const isMobile    = perfScore != null && perfScore >= 50;
    const isIndexable = (audits['is-crawlable']?.score ?? 0) >= 0.9;
    const hasMeta     = (audits['meta-description']?.score ?? 0) >= 0.9;
    const hasSitemap  = (audits['robots-txt']?.score ?? 0) >= 0.9;
    const speedPass   = speed != null && parseFloat(speed) < 3;
    const sizePass    = sizeMB != null && parseFloat(sizeMB) < 3;

    // Oversized images
    const imgItems  = audits['uses-optimized-images']?.details?.items || 
                      audits['uses-responsive-images']?.details?.items || [];
    const imagesOk  = imgItems.length === 0;
    const imgList   = imgItems.slice(0, 5).map(i => {
      const name = (i.url || '').split('/').pop().split('?')[0] || 'unknown';
      const kb   = i.totalBytes ? Math.round(i.totalBytes / 1024) + 'KB' : '';
      return name + (kb ? ' (' + kb + ')' : '');
    });

    // Google Analytics — check third-party summary
    const thirdParty = audits['third-party-summary']?.details?.items || [];
    const hasGA = thirdParty.some(i =>
      /google.tag|google.analytics|googletagmanager/i.test(i.entity || '')
    );

    res.json({
      speed, sizeMB, perfScore, seoScore,
      isHttps, isMobile, isIndexable, hasMeta, hasSitemap,
      speedPass, sizePass, imagesOk, imgList, hasGA
    });
  } catch (e) {
    console.error('DFS lighthouse error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 3. Sitemap check — direct HTTP ping ──────────────────────────────────────
app.get('/site/check', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const results = {};
    const base = url.replace(/\/$/, '');
    const UA   = { 'User-Agent': 'Mozilla/5.0 (compatible; GrowthLineAudit/1.0)' };

    // Check sitemap — entered URL + /sitemap.xml. Use GET (many servers reject
    // HEAD with 403/405) and sniff the body so a soft-404 HTML page doesn't
    // count as a sitemap.
    const sitemapUrl = base + '/sitemap.xml';
    try {
      const sr = await fetch(sitemapUrl, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(10000) });
      if (sr.ok) {
        const body = (await sr.text()).slice(0, 4000).toLowerCase();
        results.sitemap = body.includes('<urlset') || body.includes('<sitemapindex') || body.includes('<?xml');
      } else {
        results.sitemap = false;
      }
      results.sitemapStatus = sr.status;
    } catch(e) { results.sitemap = false; results.sitemapError = e.message; }
    results.sitemapUrl = sitemapUrl;

    // Check HTTPS
    results.https = url.startsWith('https');

    // Check robots.txt — GET + UA, same reasons as the sitemap check
    try {
      const rr = await fetch(base + '/robots.txt', { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(8000) });
      results.robotsTxt = rr.ok;
    } catch(e) { results.robotsTxt = false; }

    console.log('Site check results:', JSON.stringify(results));
    res.json(results);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 4. GBP — claimed, rating, review count, photos ───────────────────────────
// Endpoint: /v3/business_data/google/my_business_info/live  (no polling!)
app.get('/gbp/info', async (req, res) => {
  const { name, location } = req.query;
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!DFS_LOGIN) return res.status(500).json({ error: 'DataForSEO not configured' });
  try {
    const d = await dfsPost('/business_data/google/my_business_info/live', [
      {
        keyword:       name,
        location_name: location || 'United States',
        language_name: 'English'
      }
    ]);
    const task = d?.tasks?.[0];
    if (task && task.status_code !== 20000) {
      return res.json({ found: false, note: 'DataForSEO ' + task.status_code + ': ' + task.status_message });
    }
    const items = task?.result?.[0]?.items;
    if (!items || items.length === 0) return res.json({ found: false });

    // Find the best matching result
    const biz = items[0];
    res.json({
      found:       true,
      title:       biz.title        || '',
      address:     biz.address      || '',
      phone:       biz.phone        || '',
      rating:      biz.rating?.value               || null,
      reviewCount: biz.rating?.votes_count         || 0,
      claimed:     biz.is_claimed                  || false,
      hasPhotos:   (biz.main_image || biz.images?.length > 0) || false,
      category:    biz.category                    || '',
      url:         biz.url                         || ''
    });
  } catch (e) {
    console.error('DFS GBP error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 4. SocialFetch — follower counts by URL/handle ───────────────────────────
async function sfGet(path) {
  const r = await fetch(SF_BASE + path, { headers: { 'x-api-key': SF_KEY } });
  if (!r.ok) {
    const t = await r.text();
    console.error('SocialFetch ' + r.status + ' ' + path + ':', t.slice(0, 150));
    return null;
  }
  return r.json();
}

function cleanHandle(val, base) {
  if (!val) return null;
  const decoded = decodeURIComponent(val).trim().replace(/\/+$/, '');
  if (decoded.startsWith('http')) return decoded;
  return base + decoded.replace(/^\/+/, '');
}

app.get('/social/profiles', async (req, res) => {
  const { fb, li, ig, yt } = req.query;
  if (!SF_KEY) return res.status(500).json({ error: 'SocialFetch not configured' });

  const out   = {};
  const calls = [];

  if (fb) {
    const url = cleanHandle(fb, 'https://www.facebook.com/');
    calls.push(
      sfGet('/facebook/profiles?url=' + encodeURIComponent(url))
        .then(d => { if (d) out.facebook = d; })
        .catch(e => console.error('FB:', e.message))
    );
  }
  if (li) {
    const url = cleanHandle(li, 'https://www.linkedin.com/company/');
    calls.push(
      sfGet('/linkedin/companies?url=' + encodeURIComponent(url))
        .then(d => { if (d) out.linkedin = d; })
        .catch(e => console.error('LI:', e.message))
    );
  }
  if (ig) {
    const handle = decodeURIComponent(ig).replace(/^@/, '').replace(/.*instagram\.com\//, '').replace(/\/+$/, '');
    calls.push(
      sfGet('/instagram/profiles/' + encodeURIComponent(handle))
        .then(d => { if (d) out.instagram = d; })
        .catch(e => console.error('IG:', e.message))
    );
  }
  if (yt) {
    const handle = decodeURIComponent(yt).replace(/^@/, '').replace(/.*youtube\.com\/@?/, '').replace(/\/+$/, '');
    calls.push(
      sfGet('/youtube/channel?url=' + encodeURIComponent('https://www.youtube.com/@' + handle))
        .then(d => { if (d) out.youtube = d; })
        .catch(e => console.error('YT:', e.message))
    );
  }

  await Promise.allSettled(calls);
  res.json(out);
});

// ── 5. AI review — proxied Anthropic (key stays server-side) ─────────────────
// Also handles the web-search pause_turn loop so long searches don't come back
// with partial content and a missing ---JSON--- block.
app.post('/ai/message', async (req, res) => {
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'Anthropic not configured' });
  const { prompt } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  try {
    let messages = [{ role: 'user', content: prompt }];
    let data = null;
    for (let i = 0; i < 6; i++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method:  'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model:      'claude-sonnet-4-6',
          max_tokens: 2000,
          tools:      [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
          messages
        }),
        signal: controller.signal
      });
      clearTimeout(timeout);
      data = await r.json();
      if (data.type === 'error') {
        return res.status(502).json({ error: data.error?.message || 'Anthropic error' });
      }
      // Web-search server loop paused — append the assistant turn and continue.
      if (data.stop_reason === 'pause_turn' && Array.isArray(data.content)) {
        messages = messages.concat([{ role: 'assistant', content: data.content }]);
        continue;
      }
      break;
    }
    const text = (data?.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');
    res.json({ text, stop_reason: data?.stop_reason || null });
  } catch (e) {
    console.error('AI proxy error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 6. Airtable push — proxied (token stays server-side) ─────────────────────
app.post('/airtable', async (req, res) => {
  if (!AIRTABLE_TOKEN) return res.status(500).json({ error: 'Airtable not configured' });
  const { base, table, recordId, fields } = req.body || {};
  if (!base || !table || !fields) return res.status(400).json({ error: 'base, table, fields required' });
  try {
    const url = 'https://api.airtable.com/v0/' + base + '/' + encodeURIComponent(table) +
                (recordId ? '/' + recordId : '');
    const r = await fetch(url, {
      method:  recordId ? 'PATCH' : 'POST',
      headers: { 'Authorization': 'Bearer ' + AIRTABLE_TOKEN, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ fields })
    });
    const d = await r.json();
    res.status(r.status).json(d);
  } catch (e) {
    console.error('Airtable proxy error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log('Proxy running on port ' + PORT));
