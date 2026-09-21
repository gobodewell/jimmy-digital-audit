const express = require('express');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3001;

const DFS_LOGIN    = process.env.DATAFORSEO_LOGIN    || '';
const DFS_PASSWORD = process.env.DATAFORSEO_PASSWORD || '';
const SF_KEY       = process.env.SOCIALFETCH_KEY     || '';
const GOOGLE_KEY   = process.env.GOOGLE_API_KEY       || '';
const SEM_KEY      = process.env.SEMRUSH_KEY          || '';   // SEO numbers (DA/keywords/traffic)
const SF_BASE      = 'https://api.socialfetch.dev/v1';
const DFS_BASE     = 'https://api.dataforseo.com/v3';

const AI_MODEL      = process.env.AI_MODEL       || 'claude-sonnet-5';    // default when the app doesn't name one
const MAX_RESUMES   = 5;                                  // cap on pause_turn continuations

// The app can name a model per request (Settings -> Claude model) so a newly
// released one can be used without redeploying the proxy. Kept to a plausible
// model-id shape rather than a fixed allowlist, which would go stale — this is
// the whole point of making it settable. Anything else falls back to the
// server default; an unknown-but-well-formed id simply errors from Anthropic
// with a clear message, which the app surfaces.
function pickModel(requested) {
  const m = String(requested || '').trim();
  return /^[a-z0-9][a-z0-9.\-]{2,63}$/.test(m) ? m : AI_MODEL;
}

// Trimmed deliberately. A key pasted into Render's dashboard easily picks up a
// trailing space or newline; HTTP strips that whitespace from the header in
// transit, so the two would never match and every request would 401 with no
// clue why. The same trim is applied to the key the app sends.
const AUDIT_KEY     = (process.env.AUDIT_KEY   || '').trim();   // shared secret the app must send
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
  if ((req.get('X-Audit-Key') || '').trim() !== AUDIT_KEY) {
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

// ── SEMrush helper ────────────────────────────────────────────────────────────
// SEMrush returns CSV-ish text (semicolon-delimited, header row first). Hard
// failures come back as a line beginning with "ERROR ## :: message".
async function semFetch(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const r = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    return await r.text();
  } finally {
    clearTimeout(timeout);
  }
}

// Returns { da, keywords, traffic } on success, or { error } when SEMrush
// reports a problem (bad key, no data) so the caller can fall back.
async function semrushOverview(domain) {
  // domain_rank → organic keywords (Or) + organic traffic (Ot)
  const txt = await semFetch(
    `https://api.semrush.com/?type=domain_rank&key=${SEM_KEY}&export_columns=Dn,Rk,Or,Ot&domain=${encodeURIComponent(domain)}&database=us`
  );
  const trimmed = (txt || '').trim();
  if (/^ERROR/i.test(trimmed)) return { error: trimmed };

  const rows = trimmed.split('\n');
  let keywords = 0, traffic = 0;
  if (rows.length >= 2) {
    const cols = rows[1].split(';');           // Dn;Rk;Or;Ot
    keywords = parseInt(cols[2], 10) || 0;
    traffic  = parseInt(cols[3], 10) || 0;
  }

  // backlinks_overview → Authority Score (the real "DA"), plus total backlinks
  // and referring domains — all three come back in one billed call, so we may
  // as well take them. Columns arrive in the order named in export_columns.
  // Best-effort: a failure here leaves the values at 0 rather than aborting.
  let da = 0, backlinks = 0, refDomains = 0;
  try {
    const bl = await semFetch(
      `https://api.semrush.com/analytics/v1/?type=backlinks_overview&key=${SEM_KEY}&target=${encodeURIComponent(domain)}&target_type=root_domain&export_columns=ascore,total,domains_num`
    );
    const blRows = (bl || '').trim().split('\n');
    if (blRows.length >= 2 && !/^ERROR/i.test(blRows[0])) {
      const c = blRows[1].split(';');            // ascore;total;domains_num
      da         = parseInt(c[0], 10) || 0;
      backlinks  = parseInt(c[1], 10) || 0;
      refDomains = parseInt(c[2], 10) || 0;
    }
  } catch (_) { /* backlink data is optional */ }

  return { da, keywords, traffic, backlinks, refDomains };
}

// ── Domain helper ─────────────────────────────────────────────────────────────
// Normalises a URL or bare domain for comparison, so "https://www.example.com/x"
// and "example.com" compare equal.
function rootDomain(u) {
  if (!u) return '';
  return String(u).trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[\/?#].*$/, '')
    .replace(/:\d+$/, '');
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, dfs: !!DFS_LOGIN, sem: !!SEM_KEY, sf: !!SF_KEY, ai: !!ANTHROPIC_KEY, at: !!AIRTABLE_TOKEN, google: !!GOOGLE_KEY, locked: !!AUDIT_KEY, model: AI_MODEL }));

// ── 1. Domain overview — DA, keywords, traffic ────────────────────────────────
// Endpoint: /v3/dataforseo_labs/google/domain_rank_overview/live
app.get('/domain/overview', async (req, res) => {
  const { domain } = req.query;
  if (!domain) return res.status(400).json({ error: 'domain required' });

  // Prefer SEMrush when a key is configured — it returns a real Authority Score
  // for DA plus organic keywords/traffic. Fall back to DataForSEO on error.
  if (SEM_KEY) {
    try {
      const s = await semrushOverview(domain);
      if (s && !s.error) return res.json({
        da: s.da, keywords: s.keywords, traffic: s.traffic,
        backlinks: s.backlinks, refDomains: s.refDomains, source: 'semrush'
      });
      if (s && s.error && !DFS_LOGIN) return res.json({ da: 0, keywords: 0, traffic: 0, note: 'SEMrush: ' + s.error });
      // else fall through to DataForSEO
    } catch (e) {
      if (!DFS_LOGIN) return res.status(500).json({ error: 'SEMrush: ' + e.message });
      // else fall through to DataForSEO
    }
  }

  if (!DFS_LOGIN) return res.status(500).json({ error: 'No SEO source configured (set SEMRUSH_KEY or DataForSEO)' });
  try {
    const d = await dfsPost('/dataforseo_labs/google/domain_rank_overview/live', [
      { target: domain, location_code: 2840, language_code: 'en' }
    ]);
    console.log('DFS domain full response:', JSON.stringify(d)?.slice(0, 500));
    // Top-level DataForSEO error (auth, credits, access).
    if (d && d.status_code && d.status_code !== 20000) {
      return res.json({ da: 0, keywords: 0, traffic: 0, note: 'DataForSEO ' + d.status_code + ': ' + d.status_message });
    }
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
  // Desktop by default. PageSpeed's mobile run simulates a mid-range phone on a
  // throttled connection with a 4x CPU slowdown, which produces LCP figures
  // several times worse than a desktop test — accurate, but not comparable to
  // the desktop numbers these reports are read against.
  const strategy = req.query.strategy === 'mobile' ? 'mobile' : 'desktop';
  try {
    const psUrl = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=' +
      encodeURIComponent(url) + '&strategy=' + strategy + (GOOGLE_KEY ? '&key=' + GOOGLE_KEY : '');
    console.log('PageSpeed fetching:', psUrl.slice(0, 100));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);  // slow sites can take >30s for a full Lighthouse run
    const r = await fetch(psUrl, { signal: controller.signal });
    clearTimeout(timeout);
    const d = await r.json();
    const gMsg = d?.error?.message || (typeof d?.error === 'string' ? d.error : '') || d?.message || '';
    console.log('PageSpeed response status:', d?.lighthouseResult ? 'ok' : (gMsg || 'no lighthouse result'));
    const audits = d?.lighthouseResult?.audits;
    const cats   = d?.lighthouseResult?.categories;
    if (!audits) return res.status(502).json({ error: 'PageSpeed: ' + (gMsg || 'no data') + (GOOGLE_KEY ? '' : ' — no GOOGLE_API_KEY set') });

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
    // "Mobile optimized" used to mean "performance score >= 50", which measured
    // speed rather than mobile-friendliness — and under a desktop run it would
    // mean nothing at all. Lighthouse's `viewport` audit is the real signal
    // (does the page declare a mobile viewport?) and it is returned under both
    // strategies. Falls back to the old rule only if the audit is missing.
    const viewportAudit = audits['viewport']?.score;
    const isMobile    = viewportAudit != null
                      ? viewportAudit >= 0.9
                      : (perfScore != null && perfScore >= 50);
    // `?? 0` here used to turn a missing audit into a failed one: Lighthouse
    // reports score `null` when it could not evaluate a check, and that null
    // became `0 >= 0.9` -> false -> an unchecked box, indistinguishable from a
    // real failure. Absence of evidence is not evidence of absence, so an
    // unevaluated audit now returns null and the caller decides what to do.
    const passes = id => { const s = audits[id]?.score; return s == null ? null : s >= 0.9; };
    const isIndexable = passes('is-crawlable');
    const hasMeta     = passes('meta-description');
    // Named for what it actually measures. This is Lighthouse's robots-txt
    // audit -- whether robots.txt parses -- which says nothing about whether a
    // sitemap exists. It was called hasSitemap, which invited exactly that
    // misreading; the sitemap box is driven by the real /sitemap.xml fetch.
    const robotsTxtValid = passes('robots-txt');
    // These used to read false when the metric was missing, which is the same
    // conflation as the is-crawlable bug: no measurement scored as a failure.
    const speedPass   = speed  == null ? null : parseFloat(speed)  < 3;
    const sizePass    = sizeMB == null ? null : parseFloat(sizeMB) < 3;

    // Oversized images
    const imgItems  = audits['uses-optimized-images']?.details?.items || 
                      audits['uses-responsive-images']?.details?.items || [];
    const imagesOk  = imgItems.length === 0;
    // The filename alone was kept and the URL thrown away, which left no way to
    // see WHERE the weight comes from — and on these sites it is nearly always
    // one vendor CDN serving unresized originals, which is the finding worth
    // having, because it repeats across every client on that platform.
    const imgList   = imgItems.slice(0, 10).map(i => ({
      url:  i.url || '',
      name: (i.url || '').split('/').pop().split('?')[0] || 'unknown',
      kb:   i.totalBytes ? Math.round(i.totalBytes / 1024) : null,
      host: rootDomain(i.url)
    }));

    // total-byte-weight is the audit behind "avoid enormous network payloads":
    // every resource the page pulled, with its real transfer size.
    const heavy = (audits['total-byte-weight']?.details?.items || [])
      .slice(0, 10)
      .map(i => ({
        url:  i.url || '',
        name: (i.url || '').split('/').pop().split('?')[0] || 'unknown',
        kb:   i.totalBytes ? Math.round(i.totalBytes / 1024) : null,
        host: rootDomain(i.url)
      }));

    // Where the weight sits, by host.
    const byHost = {};
    for (const r of heavy) {
      if (!r.host || !r.kb) continue;
      byHost[r.host] = (byHost[r.host] || 0) + r.kb;
    }
    const hosts = Object.entries(byHost)
      .map(([host, kbTotal]) => ({ host, kb: kbTotal }))
      .sort((a, b) => b.kb - a.kb)
      .slice(0, 5);

    // Weight by resource type, straight from Lighthouse's resource summary.
    const byType = (audits['resource-summary']?.details?.items || [])
      .filter(i => i.resourceType && i.resourceType !== 'total' && i.transferSize)
      .map(i => ({ type: i.resourceType, kb: Math.round(i.transferSize / 1024), count: i.requestCount }))
      .sort((a, b) => b.kb - a.kb);

    // Google Analytics — check third-party summary
    // If Lighthouse did not produce a third-party summary we have not looked
    // for Analytics at all, so we cannot say it is absent.
    const thirdParty = audits['third-party-summary']?.details?.items;
    const hasGA = !thirdParty ? null : thirdParty.some(i =>
      /google.tag|google.analytics|googletagmanager/i.test(i.entity || '')
    );

    res.json({
      strategy,
      speed, sizeMB, perfScore, seoScore,
      isHttps, isMobile, isIndexable, hasMeta, robotsTxtValid,
      speedPass, sizePass, imagesOk, imgList, hasGA,
      heavy, hosts, byType
    });
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'PageSpeed timed out — the site is slow to load' : e.message;
    console.error('PageSpeed error:', e.message);
    res.status(500).json({ error: msg });
  }
});

// Read every robots directive the page declares. Attribute order and quoting
// vary in the wild, so match the tag first and pull name/content out of it
// rather than assuming a fixed shape.
function readRobotsMeta(html) {
  const out = [];
  for (const m of String(html).matchAll(/<meta\b[^>]*>/gi)) {
    const tag  = m[0];
    const name = (/\bname\s*=\s*["']?([^"'\s>]+)/i.exec(tag) || [])[1] || '';
    if (!/^(robots|googlebot)$/i.test(name)) continue;
    const content = (/\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag) || [])[1] || '';
    out.push({ name: name.toLowerCase(), content: content.trim() });
  }
  return out;
}

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

    // Indexability, measured rather than inferred. Only two things actually
    // keep a page out of an index: a robots meta tag on the page, and the
    // X-Robots-Tag response header. Both are readable in one request, so the
    // audit reads them instead of depending on PageSpeed having evaluated its
    // is-crawlable audit -- and it records WHY, so an unchecked box can be
    // explained instead of just asserted.
    try {
      const pr = await fetch(url, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(15000) });
      results.homeStatus = pr.status;
      if (!pr.ok) {
        results.indexable = null;
        results.indexableNote = 'homepage returned HTTP ' + pr.status;
      } else {
        const xRobots = (pr.headers.get('x-robots-tag') || '').trim();
        const metas   = readRobotsMeta((await pr.text()).slice(0, 300000));
        const blockers = [];
        if (/\bnoindex\b/i.test(xRobots)) blockers.push('X-Robots-Tag: ' + xRobots);
        for (const m of metas) {
          if (/\bnoindex\b/i.test(m.content)) blockers.push('<meta name="' + m.name + '" content="' + m.content + '">');
        }
        results.indexable        = blockers.length === 0;
        results.indexableBlocked = blockers;
        results.robotsMeta       = metas.map(m => m.name + ': ' + m.content);
        results.xRobotsTag       = xRobots;
        results.indexableNote    = blockers.length ? 'blocked by ' + blockers.join(' and ')
                                 : metas.length    ? 'declares ' + results.robotsMeta.join(', ')
                                                   : 'no robots directive found, which means indexable';
      }
    } catch (e) {
      results.indexable = null;
      results.indexableNote = 'could not fetch the homepage: ' + e.message;
    }

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

// ── 3b. Structured data — what schema.org markup the homepage declares ───────
// Parsed here rather than through a validator service: schema.org has no public
// API, Google's Rich Results Test has none either and is being wound down
// through 2026, and JSON-LD is only JSON inside a script tag. Doing it here is
// deterministic, free, and cannot be deprecated out from under the audit.

// The types that matter for an advisory firm. FinancialService is the correct
// specific type; the others are progressively weaker but still count as having
// identified the business.
const BUSINESS_TYPES = [
  'FinancialService', 'AccountingService', 'InsuranceAgency', 'ProfessionalService',
  'LocalBusiness', 'Corporation', 'Organization'
];

// Walk a parsed JSON-LD document into a flat list of nodes. Handles a bare
// object, an array at the root, and @graph — all three are common in the wild.
function flattenLd(node, out) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach(n => flattenLd(n, out)); return out; }
  if (Array.isArray(node['@graph'])) node['@graph'].forEach(n => flattenLd(n, out));
  if (node['@type']) out.push(node);
  for (const k of Object.keys(node)) {
    if (k === '@graph') continue;
    const v = node[k];
    if (v && typeof v === 'object') flattenLd(v, out);
  }
  return out;
}

const typesOf = n => [].concat(n['@type'] || []).map(t => String(t).replace(/^https?:\/\/schema\.org\//, ''));

app.get('/site/schema', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GrowthLineAudit/1.0)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) return res.json({ found: false, note: 'page returned HTTP ' + r.status });
    const html = await r.text();

    // JSON-LD blocks
    const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
      .map(m => m[1]);

    const nodes = [];
    let parseErrors = 0;
    for (const raw of blocks) {
      // CDATA is usually comment-wrapped inside a script tag — //<![CDATA[ or
      // /*<![CDATA[*/ — so the marker alone is not enough to strip.
      const cleaned = raw
        .replace(/^\s*(?:\/\/|\/\*)?\s*<!\[CDATA\[\s*(?:\*\/)?/, '')
        .replace(/(?:\/\*)?\s*\]\]>\s*(?:\*\/|\/\/)?\s*$/, '')
        .trim();
      if (!cleaned) continue;
      try { flattenLd(JSON.parse(cleaned), nodes); } catch (_) { parseErrors++; }
    }

    // Microdata / RDFa, still common on older builds
    const micro = [...html.matchAll(/itemtype=["']https?:\/\/schema\.org\/([A-Za-z]+)["']/gi)]
      .map(m => m[1]);

    const ldTypes = nodes.flatMap(typesOf);
    const types = [...new Set(ldTypes.concat(micro))].sort();

    const has = t => types.includes(t);
    const businessTypes = BUSINESS_TYPES.filter(has);

    // Location signals, read off whichever node carries them.
    const withAddr = nodes.filter(n => n.address);
    const addrNode = withAddr[0];
    const addr = addrNode && typeof addrNode.address === 'object' ? addrNode.address : null;

    const sameAs = [...new Set(nodes.flatMap(n => [].concat(n.sameAs || [])).filter(Boolean).map(String))];

    res.json({
      found: types.length > 0,
      types,
      jsonLdBlocks: blocks.length,
      parseErrors,
      microdataOnly: blocks.length === 0 && micro.length > 0,

      // Is the business itself described, and how specifically?
      businessTypes,
      isFinancialService: has('FinancialService'),
      hasBusinessType: businessTypes.length > 0,
      businessName: (nodes.find(n => businessTypes.some(b => typesOf(n).includes(b))) || {}).name || '',

      // Location
      hasAddress:   !!addrNode,
      addressLocality: addr ? (addr.addressLocality || '') : '',
      addressRegion:   addr ? (addr.addressRegion   || '') : '',
      hasGeo:       nodes.some(n => n.geo),
      hasPhone:     nodes.some(n => n.telephone),
      hasHours:     nodes.some(n => n.openingHours || n.openingHoursSpecification),
      hasAreaServed:nodes.some(n => n.areaServed),

      // Other things worth knowing about
      hasFAQ:    has('FAQPage'),
      hasPerson: has('Person'),
      hasRating: nodes.some(n => n.aggregateRating) || has('AggregateRating'),
      sameAs
    });
  } catch (e) {
    const msg = e.name === 'TimeoutError' ? 'timed out fetching the page' : e.message;
    console.error('schema error:', msg);
    res.status(500).json({ error: msg });
  }
});

// ── 3c. Directory listings ───────────────────────────────────────────────────
// Checked through the firm's own backlink profile rather than by searching each
// site. A directory listing with a public profile page links back to the firm,
// so if yelp.com is among their referring domains they have a Yelp listing —
// one SEMrush call settles every directory at once, deterministically, instead
// of twenty scrapes or twenty AI searches.
//
// Authority Scores below were measured once against SEMrush and are stored
// rather than fetched per audit: they move slowly, and paying for twenty
// lookups on every run to watch a number drift by one point is not worth it.
const DIRECTORIES = [
  // Free to anyone — the ones worth claiming first.
  { key: 'yelp',    name: 'Yelp',                  domain: 'yelp.com',                   as: 100, cost: 'free' },
  { key: 'bbb',     name: 'Better Business Bureau', domain: 'bbb.org',                   as: 78,  cost: 'free' },
  { key: 'nextdr',  name: 'Nextdoor',              domain: 'nextdoor.com',               as: 74,  cost: 'free' },
  { key: 'yp',      name: 'Yellow Pages',          domain: 'yellowpages.com',            as: 68,  cost: 'free' },
  { key: 'manta',   name: 'Manta',                 domain: 'manta.com',                  as: 49,  cost: 'free' },
  { key: 'coc',     name: 'ChamberOfCommerce.com', domain: 'chamberofcommerce.com',      as: 48,  cost: 'free' },
  { key: 'fsq',     name: 'Foursquare',            domain: 'foursquare.com',             as: 47,  cost: 'free' },
  { key: 'align',   name: 'Alignable',             domain: 'alignable.com',              as: 43,  cost: 'free' },

  // Free, but only because the firm already pays for the credential.
  { key: 'cfp',     name: "CFP Board — Let's Make a Plan", domain: 'letsmakeaplan.org',  as: 39,  cost: 'credential' },
  { key: 'fpa',     name: 'FPA PlannerSearch',     domain: 'plannersearch.org',          as: 38,  cost: 'credential' },
  { key: 'napfa',   name: 'NAPFA',                 domain: 'napfa.org',                  as: 44,  cost: 'credential' },
  { key: 'xypn',    name: 'XY Planning Network',   domain: 'xyplanningnetwork.com',      as: 36,  cost: 'credential' },
  { key: 'garrett', name: 'Garrett Planning Network', domain: 'garrettplanningnetwork.com', as: 31, cost: 'credential' },

  // Paid listings or per-lead. Separate bucket — compliance treats paid
  // placement differently from a claimed free listing.
  { key: 'smart',   name: 'SmartAsset',            domain: 'smartasset.com',             as: 68,  cost: 'paid' },
  { key: 'wt',      name: 'Wealthtender',          domain: 'wealthtender.com',           as: 42,  cost: 'paid' },
  { key: 'feeonly', name: 'Fee-Only Network',      domain: 'feeonlynetwork.com',         as: 34,  cost: 'paid' },
  { key: 'zoe',     name: 'Zoe Financial',         domain: 'zoefinancial.com',           as: 30,  cost: 'paid' },
  { key: 'paladin', name: 'Paladin Registry',      domain: 'paladinregistry.com',        as: 27,  cost: 'paid' },
  { key: 'wiser',   name: 'WiserAdvisor',          domain: 'wiseradvisor.com',           as: 25,  cost: 'paid' }
];

// These are map/profile products with no public page linking back to the firm,
// so a backlink profile can never show them. Reported as "check by hand" rather
// than silently as absent.
const UNVERIFIABLE = [
  { name: 'Bing Places',    cost: 'free', why: 'map listing, no linking page' },
  { name: 'Apple Business', cost: 'free', why: 'map listing, no linking page' }
];

app.get('/directories', async (req, res) => {
  const { domain } = req.query;
  if (!domain) return res.status(400).json({ error: 'domain required' });
  if (!SEM_KEY) return res.status(500).json({ error: 'SEMRUSH_KEY not set — directory checks read the backlink profile' });

  const target = rootDomain(domain);
  const base = `https://api.semrush.com/analytics/v1/?type=backlinks_refdomains&key=${SEM_KEY}` +
               `&target=${encodeURIComponent(target)}&target_type=root_domain` +
               `&export_columns=domain,domain_ascore&display_limit=1000`;

  try {
    // Sorted by authority so the directories that matter surface first if the
    // firm has more referring domains than the limit. Column and sort naming
    // differs across SEMrush report families, so fall back to an unsorted
    // request rather than failing the whole check on a rejected parameter.
    let txt = await semFetch(base + '&display_sort=domain_ascore_desc');
    if (/^ERROR/i.test((txt || '').trim())) txt = await semFetch(base);

    const trimmed = (txt || '').trim();
    if (/^ERROR/i.test(trimmed)) {
      return res.json({ error: 'SEMrush: ' + trimmed.slice(0, 120) });
    }

    // Find the domain column by header name — its position is not guaranteed.
    const rows = trimmed.split('\n');
    const headers = (rows[0] || '').split(';').map(h => h.trim().toLowerCase());
    const di = headers.indexOf('domain') >= 0 ? headers.indexOf('domain') : 0;

    const seen = new Set();
    for (const line of rows.slice(1)) {
      const d = rootDomain((line.split(';')[di] || '').trim());
      if (d) seen.add(d);
    }

    // A listing may sit on a subdomain (eg. austin.bbb.org), so match the
    // referring domain by suffix as well as exactly.
    const has = dom => seen.has(dom) || [...seen].some(s => s.endsWith('.' + dom));

    const results = DIRECTORIES.map(d => ({ ...d, found: has(d.domain) }));
    const free = results.filter(d => d.cost === 'free');

    res.json({
      checked: results.length,
      found: results.filter(d => d.found).length,
      freeFound: free.filter(d => d.found).length,
      freeTotal: free.length,
      refDomainsScanned: seen.size,
      capped: seen.size >= 1000,
      directories: results,
      unverifiable: UNVERIFIABLE
    });
  } catch (e) {
    console.error('directories error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 4. GBP — claimed, rating, review count, photos ───────────────────────────
// Endpoint: /v3/business_data/google/my_business_info/live  (no polling!)
app.get('/gbp/info', async (req, res) => {
  const { name, location, url } = req.query;
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
    console.log('DFS GBP full response:', JSON.stringify(d)?.slice(0, 400));
    // Top-level DataForSEO error (auth, credits, access) — catches what the
    // task-level check below misses when there are no tasks at all.
    if (d && d.status_code && d.status_code !== 20000) {
      return res.json({ found: false, note: 'DataForSEO ' + d.status_code + ': ' + d.status_message });
    }
    const task = d?.tasks?.[0];
    if (task && task.status_code !== 20000) {
      return res.json({ found: false, note: 'DataForSEO ' + task.status_code + ': ' + task.status_message });
    }
    const items = task?.result?.[0]?.items;
    if (!items || items.length === 0) return res.json({ found: false });

    // Match the listing to the firm by its website domain. Advisory firms share
    // names constantly ("Cornerstone", "Integrity"), and Google returns them by
    // keyword relevance — so the audited site is the only reliable way to tell
    // this firm's listing from a neighbour's. When no listing matches we still
    // return the top hit for a human to eyeball, but flag it unverified so the
    // caller does not score it automatically.
    const want = rootDomain(url);
    let biz = null, verified = false;
    if (want) {
      biz = items.find(i => rootDomain(i.url || i.domain) === want) || null;
      verified = !!biz;
    }
    if (!biz) biz = items[0];

    res.json({
      found:       true,
      verified,                                    // listing's site matched the audited domain
      candidates:  items.length,
      matchedOn:   verified ? 'domain' : (want ? 'name-only' : 'no-url-supplied'),
      title:       biz.title        || '',
      address:     biz.address      || '',
      phone:       biz.phone        || '',
      rating:      biz.rating?.value               || null,
      reviewCount: biz.rating?.votes_count         || 0,
      // DataForSEO returns null for is_claimed when it does not know. `|| false`
      // turned that into a confident "Unclaimed", which is a different claim
      // about the business than "we could not tell". Null now survives to the
      // caller, which marks the box unmeasured rather than failed.
      claimed:     biz.is_claimed == null ? null : !!biz.is_claimed,
      // Deliberately NOT given the same null treatment as is_claimed. A firm
      // with no logo is the ordinary case and the field is simply absent, so
      // reading absence as "unknown" would turn a real, common finding into a
      // shrug -- the opposite error, and it would bury the unmeasured list in
      // noise. is_claimed is different: DataForSEO documents null there as
      // "not determined", which is genuinely not the same as unclaimed.
      hasLogo:     !!biz.logo,                     // the real logo field
      hasPhotos:   !!(biz.main_image || (biz.images && biz.images.length > 0)),
      // The profile's own description. Absent key means DataForSEO did not
      // return the field at all, which is unmeasured -- treating that as "no
      // description" would fail every firm on an 8-point check. An explicit
      // empty value is a real finding: the box is there and nothing is in it.
      description:    biz.description || '',
      hasDescription: biz.description === undefined
                        ? null
                        : !!(biz.description && String(biz.description).trim()),
      category:    biz.category                    || '',
      url:         biz.url                         || ''
    });
  } catch (e) {
    console.error('DFS GBP error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 4. SocialFetch — follower counts by URL/handle ───────────────────────────
// The only outbound call in this file that had no timeout. SocialFetch can sit
// on a request indefinitely, and because the four platform lookups are awaited
// together, one hung call held the whole audit open with nothing to show for
// it. Twenty seconds is well past a healthy response and well short of the
// caller giving up.
const SF_TIMEOUT_MS = 20000;
async function sfGet(path) {
  let r;
  try {
    r = await fetch(SF_BASE + path, {
      headers: { 'x-api-key': SF_KEY },
      signal: AbortSignal.timeout(SF_TIMEOUT_MS)
    });
  } catch (e) {
    const why = e.name === 'TimeoutError' || e.name === 'AbortError'
      ? 'SocialFetch timed out after ' + (SF_TIMEOUT_MS / 1000) + 's'
      : 'SocialFetch unreachable: ' + e.message;
    console.error(why + ' ' + path);
    return { error: why };
  }
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    console.error('SocialFetch ' + r.status + ' ' + path + ':', t.slice(0, 150));
    // Returning null here made a broken lookup indistinguishable from a firm
    // that simply has no profile on that platform -- the box went unticked
    // either way and the UI blamed the handle.
    //
    // The status alone does not say what to do about it, and the answer is
    // almost always in the body. Carried through to the browser so the cause
    // is visible in the app rather than only in the proxy's logs.
    // 402 is the one that actually happens. SocialFetch bills per lookup and
    // the balance runs out quietly: the key stays valid, the endpoints stay
    // correct, requests are still counted, and every lookup fails. Usage
    // charts show spend, not balance, so nothing on the dashboard looks wrong.
    const why = { 401: 'the SOCIALFETCH_KEY is wrong or expired',
                  402: 'the SocialFetch account is out of credits — top it up in their Billing tab',
                  403: 'the SOCIALFETCH_KEY is not allowed to call this',
                  404: 'the endpoint path no longer exists',
                  429: 'rate limited or out of quota' }[r.status];
    // The message can sit at the top level or nested under `error`, and
    // SocialFetch nests it -- taking j.error straight gave "[object Object]".
    let detail = '';
    try {
      const j = JSON.parse(t);
      const e = j && j.error;
      detail = (e && typeof e === 'object' ? (e.message || e.code) : e) || j.message || '';
    } catch (_) { detail = t; }
    detail = String(detail).replace(/\s+/g, ' ').trim().slice(0, 120);
    return { error: 'SocialFetch HTTP ' + r.status +
                    (why ? ' — ' + why : '') +
                    (detail ? ' (' + detail + ')' : '') };
  }
  try { return await r.json(); }
  catch (e) { return { error: 'SocialFetch sent a malformed response' }; }
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

  // One shape for all four, so a lookup failure is recorded the same way
  // everywhere instead of being logged and dropped.
  const lookup = (key, path) => calls.push(
    sfGet(path)
      .then(d => {
        if (d && d.error) out[key + 'Error'] = d.error;
        else if (d)       out[key] = d;
        else              out[key + 'Error'] = 'no response';
      })
      .catch(e => { out[key + 'Error'] = e.message; console.error(key + ':', e.message); })
  );

  if (fb) lookup('facebook',
    '/facebook/profiles?url=' + encodeURIComponent(cleanHandle(fb, 'https://www.facebook.com/')));
  if (li) lookup('linkedin',
    '/linkedin/companies?url=' + encodeURIComponent(cleanHandle(li, 'https://www.linkedin.com/company/')));
  if (ig) {
    const handle = decodeURIComponent(ig).replace(/^@/, '').replace(/.*instagram\.com\//, '').replace(/\/+$/, '');
    lookup('instagram', '/instagram/profiles/' + encodeURIComponent(handle));
  }
  if (yt) {
    const handle = decodeURIComponent(yt).replace(/^@/, '').replace(/.*youtube\.com\/@?/, '').replace(/\/+$/, '');
    lookup('youtube', '/youtube/channel?url=' + encodeURIComponent('https://www.youtube.com/@' + handle));
  }

  await Promise.allSettled(calls);
  res.json(out);
});

// ── 5. Claude helpers — one streaming call, and one that resumes pauses ──────
// Streams a single request, accumulating the visible text and a rebuilt copy of
// the assistant's content blocks. The blocks matter for two reasons: resuming a
// paused turn requires handing the whole turn back (text alone loses the
// trailing server_tool_use block the server resumes from), and the web-search
// result blocks are where the citation URLs live.
async function claudeOnce({ messages, tools, maxTokens, effort, model, onEvent }) {
  const body = {
    model:      pickModel(model),
    max_tokens: maxTokens || 8192,
    stream:     true,
    messages
  };
  if (tools && tools.length) body.tools = tools;
  if (effort) body.output_config = { effort };

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });

  if (!r.ok || !r.body) {
    const t = await r.text().catch(() => '');
    return { error: 'Anthropic ' + r.status + ': ' + t.slice(0, 200) };
  }

  const reader  = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', text = '', stopReason = null;
  const blocks = [];        // assistant content, rebuilt in index order
  const jsonBuf = {};       // index -> accumulating input_json_delta string

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (!payload || payload === '[DONE]') continue;
      let ev; try { ev = JSON.parse(payload); } catch { continue; }
      if (onEvent) onEvent(ev);

      if (ev.type === 'content_block_start') {
        blocks[ev.index] = JSON.parse(JSON.stringify(ev.content_block || {}));
        const t = blocks[ev.index].type;
        if (t === 'tool_use' || t === 'server_tool_use') jsonBuf[ev.index] = '';
      } else if (ev.type === 'content_block_delta') {
        const bl = blocks[ev.index], d = ev.delta || {};
        if (!bl) continue;
        if (d.type === 'text_delta')           { bl.text = (bl.text || '') + d.text; text += d.text; }
        else if (d.type === 'thinking_delta')  { bl.thinking = (bl.thinking || '') + d.thinking; }
        else if (d.type === 'signature_delta') { bl.signature = d.signature; }
        else if (d.type === 'input_json_delta'){ jsonBuf[ev.index] = (jsonBuf[ev.index] || '') + d.partial_json; }
      } else if (ev.type === 'content_block_stop') {
        const bl = blocks[ev.index];
        if (bl && jsonBuf[ev.index] !== undefined) {
          try { bl.input = jsonBuf[ev.index] ? JSON.parse(jsonBuf[ev.index]) : {}; } catch (_) { bl.input = {}; }
        }
      } else if (ev.type === 'message_delta' && ev.delta?.stop_reason) {
        stopReason = ev.delta.stop_reason;
      } else if (ev.type === 'error') {
        return { error: ev.error?.message || 'stream error' };
      }
    }
  }
  return { text, stopReason, blocks: blocks.filter(Boolean) };
}

// Runs a prompt to completion, resuming paused turns. A server-side tool loop
// pauses after 10 iterations with the answer genuinely unfinished; handing the
// conversation back resumes it — the server spots the trailing server_tool_use
// block and carries on by itself, so no "continue" message (adding one confuses
// it). Left unhandled, a long review just stopped early and its closing
// ---JSON--- block never arrived, which downstream looked like a parse failure.
async function claudeRun({ prompt, tools, maxTokens, effort, model, onEvent, onResume }) {
  const messages = [{ role: 'user', content: prompt }];
  let text = '', stopReason = null, assistant = [];

  for (let i = 0; i <= MAX_RESUMES; i++) {
    const out = await claudeOnce({ messages, tools, maxTokens, effort, model, onEvent });
    if (out.error) return { error: out.error };
    text      += out.text;
    stopReason = out.stopReason;
    assistant  = assistant.concat(out.blocks);
    if (stopReason !== 'pause_turn') break;
    if (onResume) onResume();
    messages[1] = { role: 'assistant', content: assistant };
  }
  return { text, stopReason, blocks: assistant };
}

const WEB_TOOLS = [
  // Dynamic-filtering variants: Claude filters search results in a sandbox
  // before they reach the context window, which is both more accurate and
  // cheaper in tokens. The filtering is built into these tool versions — do NOT
  // also declare code_execution, or the model ends up with two execution
  // environments and gets confused.
  //
  // These caps have to cover what the prompts actually ask for. At 4 fetches
  // the visibility review alone ran out -- sitemap, homepage, contact/about,
  // homepage again -- and the website review, which reads several sub-pages,
  // ran out sooner. A model that exhausts its tools does not fail: it writes
  // up what it managed to see and drops the JSON block, so the audit applied
  // nothing while reporting success.
  { type: 'web_search_20260209', name: 'web_search', max_uses: 6 },
  { type: 'web_fetch_20260209',  name: 'web_fetch',  max_uses: 12 }
];

// ── 5a. AI review — proxied Anthropic, STREAMED ──────────────────────────────
// Streams the response as newline-delimited JSON: a {"type":"ping"} on every
// upstream event (keeps the browser connection alive while the AI searches/reads,
// so the long request can't be dropped), then a final {"type":"done","text":...}.
app.post('/ai/message', async (req, res) => {
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'Anthropic not configured' });
  const { prompt, model } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');   // ask any proxy not to buffer
  res.flushHeaders?.();
  const send = obj => { try { res.write(JSON.stringify(obj) + '\n'); } catch (e) {} };

  try {
    const out = await claudeRun({
      prompt, model, tools: WEB_TOOLS, maxTokens: 8192,
      onEvent:  () => send({ type: 'ping' }),      // heartbeat
      onResume: () => send({ type: 'resuming' })
    });
    if (out.error) { send({ type: 'error', error: out.error }); return res.end(); }
    send({ type: 'done', text: out.text, stop_reason: out.stopReason, model: pickModel(model) });
    res.end();
  } catch (e) {
    console.error('AI proxy error:', e.message);
    send({ type: 'error', error: e.message });
    res.end();
  }
});

// ── 5b. AI visibility — does Claude know this firm, and does it cite them? ────
// Two measurements, both real rather than inferred:
//   visibility — ask the questions a prospect's clients ask, with NO tools, and
//                count how often the firm gets named from trained knowledge.
//   citations  — ask the same questions WITH web search, and count how often the
//                firm's own domain shows up in the sources Claude actually read.
// Model output varies run to run and temperature was removed on current models,
// so a single answer is not a measurement — each prompt is repeated and scored
// as a rate.
function visibilityPrompts(city) {
  const where = city ? ' in ' + city : '';
  return [
    `Who are the best financial advisors${where}?`,
    `I'm looking for a financial advisor${where} to help with retirement planning. Which firms should I consider?`,
    `What are the top wealth management firms${where}?`,
    `Who should I talk to about financial planning${where}?`,
    `Recommend a few fee-only financial advisory firms${where}.`
  ];
}

// Branded prompts name the firm outright. These answer a different and more
// basic question than the discovery prompts: not "would a prospect stumble on
// them" but "does the model know who they are at all, and does it treat their
// own site as the source about them".
// Each branded prompt asks for a verdict alongside the prose, because inferring
// "did it know them" from the prose does not work. The first version of this
// matched disclaimer phrases anywhere in the answer, and a good answer routinely
// ends with a narrow caveat — "I don't have anything on their AUM" — which
// scored a detailed, accurate answer identically to "I have never heard of
// them". The better the answer, the more likely it caveated, the more likely it
// was marked as ignorance. The model reporting on its own knowledge, and listing
// what it knew so a human can check, is both more reliable and auditable.
const VERDICT_BLOCK = `

After your answer, end with this EXACT block and nothing after it:
---VERDICT---
{"knewFirm": true or false, "specifics": ["one short fact you knew about THIS firm", "..."]}
---END---
Rules:
- knewFirm is true if you could state anything specific about THIS firm from your
  own knowledge — a location, a parent or custodian, a service line, a person.
- Caveats about details you happen to lack (AUM, fees, regulatory history) do
  NOT make it false. Lacking some details is not the same as not knowing them.
- knewFirm is false only if you genuinely cannot place this firm at all, or the
  only things you can say would be true of any advisory firm.
- specifics: up to 4 short facts, drawn only from what you actually knew. Empty
  array when knewFirm is false.`;

function brandedPrompts(name, city) {
  const where = city ? ' in ' + city : '';
  return [
    `What can you tell me about ${name}, a financial advisory firm${where}?` + VERDICT_BLOCK,
    `Is ${name}${where} a reputable financial advisory firm? What are they known for?` + VERDICT_BLOCK,
    `Who works at ${name}${where}, and what services do they offer?` + VERDICT_BLOCK
  ];
}

// Fallback only, for when the verdict block is missing or unparseable. Narrowed
// so it cannot repeat the original mistake: a disclaimer is only read as "does
// not know them" in a SHORT answer. A long answer full of specifics is not
// ignorance, whatever caveat it happens to close with.
const NO_KNOWLEDGE = /(i (do ?n'?t|do not) have|i'?m not familiar|not familiar with|don'?t have (any |specific |reliable )?(information|details)|no (specific |reliable |publicly available )?information|could ?n'?t find|could not find|unable to find|not aware of|i don'?t know|no record of|can ?n'?t find|cannot find)/i;
const SHORT_ANSWER = 400;

function readVerdict(text) {
  const m = /---VERDICT---([\s\S]*?)---END---/.exec(text || '');
  if (m) {
    try {
      const v = JSON.parse(m[1].trim());
      if (typeof v.knewFirm === 'boolean') {
        return { knew: v.knewFirm, specifics: (v.specifics || []).slice(0, 4).map(String), source: 'verdict' };
      }
    } catch (_) { /* fall through to the heuristic */ }
  }
  const prose = (text || '').replace(/---VERDICT---[\s\S]*/, '').trim();
  const knew = !(prose.length < SHORT_ANSWER && NO_KNOWLEDGE.test(prose));
  return { knew, specifics: [], source: 'heuristic' };
}

// Loose name match — case, punctuation and legal suffixes ignored, so
// "Totus Wealth Management, LLC" still matches "totus wealth management".
function normaliseName(s) {
  return String(s || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(llc|llp|inc|incorporated|corp|corporation|ltd|pllc|pc)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function mentionsName(text, name) {
  const n = normaliseName(name);
  return !!n && normaliseName(text).includes(n);
}

// Pull every URL Claude actually cited out of the web_search result blocks.
// Errors come back on the same block with `content` as an OBJECT rather than a
// list (and HTTP 200, no exception), so branch on that before iterating.
function citedDomains(blocks) {
  const out = new Set();
  for (const b of blocks || []) {
    if (b.type !== 'web_search_tool_result') continue;
    if (!Array.isArray(b.content)) continue;          // error object, not results
    for (const r of b.content) {
      const d = rootDomain(r && r.url);
      if (d) out.add(d);
    }
  }
  return out;
}

// Small concurrency limiter — keeps a burst of prompts from hammering the API.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }));
  return results;
}

// ── Cover summary — written from the audit, never from a fresh look ─────────
// The one piece of per-firm prose in the report. It is generated ONLY from the
// results this audit produced: the scores, the failed KPIs and the metric
// values. Asking the model to go and look at the firm again would eventually
// produce a paragraph that contradicts the checkboxes printed beside it, and
// the reader would believe the paragraph.
app.post('/ai/summary', async (req, res) => {
  const { firm, scores, failed, metrics, model } = req.body || {};
  if (!firm)   return res.status(400).json({ error: 'firm required' });
  if (!scores) return res.status(400).json({ error: 'scores required' });
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_KEY not set' });

  const lines = [];
  lines.push(`Firm: ${firm}`);
  lines.push(`Overall ${scores.overall}/100 (${scores.band}). ` +
             `Visibility ${scores.v}, Website ${scores.w}, Social ${scores.s}.`);
  if (scores.aeoTotal) {
    // Answer-engine coverage is a count, not a score, and is given as one so
    // the summary cannot describe it as a fourth grade.
    lines.push(`Answer-engine KPIs passed: ${scores.aeoPassed} of ${scores.aeoTotal}.`);
  }
  if (scores.prior) {
    lines.push(`Previous audit scored ${scores.prior.overall}; the change is ${scores.prior.delta >= 0 ? '+' : ''}${scores.prior.delta}.`);
  }
  if (Array.isArray(failed) && failed.length) {
    lines.push('Failed checks, worst impact first:');
    failed.slice(0, 12).forEach(f => lines.push(`  - ${f.label} (${f.pts} pts, ${f.cat})`));
  }
  if (metrics && Object.keys(metrics).length) {
    lines.push('Measured values:');
    for (const [k, v] of Object.entries(metrics)) {
      if (v !== null && v !== undefined && v !== '') lines.push(`  - ${k}: ${v}`);
    }
  }

  const prompt =
`Below are the results of a digital marketing audit of a financial advisory firm.

${lines.join('\n')}

Write the summary paragraph for the cover of the report. Rules:
- 3 to 4 sentences, and UNDER 440 CHARACTERS in total. The cover has a fixed
  amount of room; anything longer is trimmed before it is printed, so a fifth
  sentence is a sentence the client never reads. Count as you write.
- Addressed to the firm as "your".
- Say what is working first, then name the single biggest thing holding the
  score back, then say that fixing it is achievable.
- Use ONLY the facts above. Do not invent measurements, competitors, numbers,
  or anything about the firm that is not listed. If something is not in the
  data, do not mention it.
- No projected results, no revenue or lead claims, no guarantees — this is read
  by a regulated firm and may reach their compliance officer.
- Plain prose. No headings, no bullets, no preamble. Return the paragraph only.`;

  try {
    const out = await claudeOnce({
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 700,
      model
    });
    if (out.error) return res.status(502).json({ error: out.error });
    const text = (out.text || '').trim();
    if (!text) return res.status(502).json({ error: 'no summary returned' });
    res.json({ summary: text, model: pickModel(model) });
  } catch (e) {
    console.error('AI summary error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/ai/visibility', async (req, res) => {
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'Anthropic not configured' });
  const { name, domain, city, model } = req.body || {};
  if (!name)   return res.status(400).json({ error: 'name required' });
  if (!domain) return res.status(400).json({ error: 'domain required' });

  const prompts = (Array.isArray(req.body.prompts) && req.body.prompts.length)
    ? req.body.prompts.slice(0, 12)
    : visibilityPrompts(city);
  const branded = (Array.isArray(req.body.brandedPrompts) && req.body.brandedPrompts.length)
    ? req.body.brandedPrompts.slice(0, 6)
    : (req.body.branded === false ? [] : brandedPrompts(name, city));
  const repeats = Math.min(Math.max(parseInt(req.body.repeats, 10) || 2, 1), 5);
  const want    = rootDomain(domain);

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const send = obj => { try { res.write(JSON.stringify(obj) + '\n'); } catch (e) {} };

  // One job per prompt per repetition per mode, across both prompt sets.
  const jobs = [];
  for (const p of prompts) {
    for (let i = 0; i < repeats; i++) {
      jobs.push({ prompt: p, kind: 'discovery', mode: 'knowledge' });
      jobs.push({ prompt: p, kind: 'discovery', mode: 'citation'  });
    }
  }
  for (const p of branded) {
    for (let i = 0; i < repeats; i++) {
      jobs.push({ prompt: p, kind: 'branded', mode: 'knowledge' });
      jobs.push({ prompt: p, kind: 'branded', mode: 'citation'  });
    }
  }

  let finished = 0;
  try {
    const runs = await mapLimit(jobs, 4, async (job) => {
      const out = await claudeRun({
        prompt:    job.prompt,
        model,
        tools:     job.mode === 'citation' ? WEB_TOOLS : undefined,
        maxTokens: job.mode === 'citation' ? 4096 : 2048,
        effort:    'low'
      });
      finished++;
      send({ type: 'progress', done: finished, total: jobs.length });
      if (out.error) return { ...job, error: out.error };
      const v = job.kind === 'branded' ? readVerdict(out.text) : { knew: false, specifics: [], source: null };
      return {
        ...job,
        // A discovery answer counts if it names the firm unprompted. A branded
        // answer already contains the name, so it counts only if the model
        // knew something rather than disclaiming.
        hit: job.kind === 'branded' ? v.knew : mentionsName(out.text, name),
        specifics: job.kind === 'branded' ? v.specifics : [],
        verdictSource: job.kind === 'branded' ? v.source : null,
        cited: job.mode === 'citation' ? citedDomains(out.blocks).has(want) : false
      };
    });

    const ok        = runs.filter(r => !r.error);
    const knowledge = ok.filter(r => r.kind === 'discovery' && r.mode === 'knowledge');
    const citation  = ok.filter(r => r.kind === 'discovery' && r.mode === 'citation');
    const bKnow     = ok.filter(r => r.kind === 'branded'   && r.mode === 'knowledge');
    const bCite     = ok.filter(r => r.kind === 'branded'   && r.mode === 'citation');
    const errors    = runs.filter(r => r.error);
    const pct = (n, d) => d ? Math.round((n / d) * 100) : null;

    send({
      type: 'done',
      model: pickModel(model),
      prompts: prompts.length,
      repeats,
      brandedPrompts: branded.length,
      // Discovery — the firm is never named in the question.
      // % of no-tool answers that named the firm at all
      visibilityScore: pct(knowledge.filter(r => r.hit).length, knowledge.length),
      visibilityHits:  knowledge.filter(r => r.hit).length,
      visibilityRuns:  knowledge.length,
      // % of searched answers whose cited sources included the firm's domain
      citationShare:   pct(citation.filter(r => r.cited).length, citation.length),
      citationHits:    citation.filter(r => r.cited).length,
      citationRuns:    citation.length,
      // Branded — the firm IS named in the question. Did the model know them,
      // and did it treat their own site as the source about them?
      brandedScore:    pct(bKnow.filter(r => r.hit).length, bKnow.length),
      brandedHits:     bKnow.filter(r => r.hit).length,
      brandedRuns:     bKnow.length,
      brandedCitation: pct(bCite.filter(r => r.cited).length, bCite.length),
      brandedCiteHits: bCite.filter(r => r.cited).length,
      brandedCiteRuns: bCite.length,
      // What the model actually said it knew, so the number can be checked
      // rather than taken on faith.
      brandedSpecifics: [...new Set(bKnow.concat(bCite).flatMap(r => r.specifics || []))].slice(0, 6),
      brandedFallbacks: bKnow.filter(r => r.verdictSource === 'heuristic').length,
      // A firm the model cites but is scored as not knowing is a contradiction,
      // and it was exactly this shape that exposed the first scoring bug.
      brandedConflict: pct(bKnow.filter(r => r.hit).length, bKnow.length) === 0 &&
                       pct(bCite.filter(r => r.cited).length, bCite.length) > 0,
      errors: errors.length,
      errorNote: errors.length ? (errors[0].error || '').slice(0, 160) : ''
    });
    res.end();
  } catch (e) {
    console.error('AI visibility error:', e.message);
    send({ type: 'error', error: e.message });
    res.end();
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
