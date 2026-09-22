const express = require('express');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3001;

// Every one of these is trimmed. A key pasted into a hosting panel's env
// editor picks up a trailing newline or space remarkably easily, and these go
// straight into a query string or an auth header -- the vendor then rejects it
// as malformed, which reads as "the key is wrong" when the key is fine.
// SEMrush answers a key with a stray character on the end with
// "ERROR 122 :: WRONG FORMAT OR EMPTY KEY". Whitespace is also truthy, so the
// `if (!SEM_KEY)` guards below passed a key that was nothing but a newline.
const env = n => (process.env[n] || '').trim();
for (const n of ['DATAFORSEO_LOGIN','DATAFORSEO_PASSWORD','SOCIALFETCH_KEY',
                 'GOOGLE_API_KEY','SEMRUSH_KEY','ANTHROPIC_KEY','AIRTABLE_TOKEN']) {
  const raw = process.env[n];
  if (raw && raw !== raw.trim()) console.warn('WARNING: ' + n + ' had surrounding whitespace — trimmed.');
}
const DFS_LOGIN    = env('DATAFORSEO_LOGIN');
const DFS_PASSWORD = env('DATAFORSEO_PASSWORD');
const SF_KEY       = env('SOCIALFETCH_KEY');
const GOOGLE_KEY   = env('GOOGLE_API_KEY');
const SEM_KEY      = env('SEMRUSH_KEY');   // SEO numbers (DA/keywords/traffic)

// SEMrush reports failures as plain text: "ERROR ## :: MESSAGE". Relayed raw,
// the code means nothing to whoever is running the audit and says nothing
// about where to fix it.
// Label an error as SEMrush's without stuttering when it already says so.
const semLabel = m => /semrush/i.test(String(m)) ? String(m) : 'SEMrush: ' + m;

function semWhy(errText) {
  const code = (errText.match(/ERROR\s+(\d+)/i) || [])[1];
  const why = {
    120: 'the SEMRUSH_KEY is wrong',
    122: 'the SEMRUSH_KEY is empty or malformed — check it was pasted whole, with no line break or space on the end',
    131: 'the SEMrush account is out of API units',
    132: 'the SEMrush account is out of API units',
    133: 'the SEMrush API is not enabled on this plan — it needs a Business plan or an API units add-on',
    134: 'the SEMrush account has no API units left',
    135: 'the SEMrush API is disabled for this account'
  }[code];
  return errText.trim().slice(0, 120) + (why ? ' — ' + why : '');
}
// A self-identifying UA ("GrowthLineAudit/1.0") is a bot signature, and the
// managed WAFs in front of advisory-firm sites answer it with 403 — which the
// audit then had to report as "could not measure" for indexability and schema
// on sites that serve those pages to any browser. These are the headers a real
// browser sends, for pages a human could open in one. Public pages only: this
// does not touch robots.txt exclusions, which are still read and honoured.
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
                '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1'
};

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
const ANTHROPIC_KEY = env('ANTHROPIC_KEY');    // AI reviews, server-side
const AIRTABLE_TOKEN= env('AIRTABLE_TOKEN');   // Airtable push, server-side

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
// Two generations of this API are live and they are not interchangeable.
//
//   v3  key: 32 hex characters. Passed as ?key=. Answers semicolon-delimited
//       text, header row first, failures as "ERROR ## :: message".
//   v4  key: a personal access token, "semrtkn-pat-...". Passed as an
//       "Authorization: Apikey" header against https://api.semrush.com/apis/v4/.
//       Answers JSON. Column names differ throughout: ascore -> authority_score,
//       domain_ascore -> domain_authority_score, and domain_rank's short codes
//       (Dn, Rk, Or, Ot) become domain, rank, organic_keywords, organic_traffic.
//
// Semrush stopped issuing v3 keys, so new accounts only have the PAT. Both are
// supported here: v3 keys keep working, and the shape of the key picks the path
// rather than a setting nobody would remember to change.
// The two generations are not a migration, they are a split surface, and which
// one a report lives in is not a choice:
//
//   - Referring domains and domain_rank exist ONLY in v3. Probing all 84 v4
//     routes found overview, links, anchors, pages, competitors and summary in
//     the backlinks family and no refdomains route of any spelling, which
//     matches the docs: reports that have not migrated remain in v3.
//   - Backlinks overview exists in both.
//
// So both keys are held at once and each report uses whichever generation can
// serve it. Every account has an autogenerated v3 key that cannot be deleted,
// alongside the v4 token, so holding both is the normal case rather than a
// transitional one. SEMRUSH_KEY still accepts either on its own — the key's
// shape says which it is — and SEMRUSH_KEY_V3 / SEMRUSH_KEY_V4 name them
// explicitly when both are set.
const isV3Key = k => /^[0-9a-f]{32}$/i.test(k || '');
const SEM_KEY_V3 = env('SEMRUSH_KEY_V3') || (isV3Key(SEM_KEY) ? SEM_KEY : '');
const SEM_KEY_V4 = env('SEMRUSH_KEY_V4') || (!isV3Key(SEM_KEY) ? SEM_KEY : '');
const SEM_V4 = !!SEM_KEY_V4;
const SEM_V4_BASE = 'https://api.semrush.com/apis/v4';

// Which generations can serve each report, best first. A report with no key for
// any generation it supports says so by name, rather than failing as if the
// route were missing.
const SEM_REPORT_GEN = {
  domainRank: ['v3'],            // not migrated to v4
  refDomains: ['v3'],            // not migrated to v4 — confirmed by route map
  blOverview: ['v4', 'v3']       // in both; v4 preferred when a token is set
};

async function semFetch(url, opts) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const r = await fetch(url, Object.assign({ signal: controller.signal }, opts || {}));
    clearTimeout(timeout);
    return await r.text();
  } finally {
    clearTimeout(timeout);
  }
}

// v4 is Early Access and its route layout is not something this proxy can
// verify from the outside, so each report carries a short list of candidate
// paths. The first that answers with data wins and is remembered for the life
// of the process; a 404/405 moves on to the next. /semrush/diag reports which
// one answered, so a route that moves can be pinned without guesswork.
// Confirmed against the live API: /backlinks/v1/overview and /backlinks/v1/links
// answer 403 (they exist; this account is not authorised for them), while every
// other path probed answered 404. Routing is evaluated before authorisation, so
// 403 means the path is real and 404 means it is not -- which is also how
// /semrush/map finds the ones not documented anywhere reachable.
const SEM_V4_ROUTES = {
  domainRank:  ['/analytics/v1/domain_rank', '/trends/v1/domain-rank',
                '/domain/v1/rank', '/analytics/v1/overview'],
  blOverview:  ['/backlinks/v1/overview', '/backlinks/v1/backlinks_overview',
                '/analytics/v1/backlinks_overview'],
  refDomains:  ['/backlinks/v1/refdomains', '/backlinks/v1/referring_domains',
                '/backlinks/v1/referring-domains', '/backlinks/v1/domains',
                '/backlinks/v1/refdomains_historical', '/backlinks/v1/ref_domains',
                '/analytics/v1/backlinks_refdomains']
};

// Candidate segments for the route map. Worth probing because this API
// distinguishes "not found" from "not allowed", so an unauthorised account can
// still learn the shape of the surface.
const SEM_V4_MAP_FAMILIES = ['/backlinks/v1', '/analytics/v1', '/trends/v1', '/projects/v1'];
const SEM_V4_MAP_SEGMENTS = [
  // Confirmed to exist against the live API.
  'overview', 'links',
  // Referring-domain candidates. The report is called backlinks_refdomains in
  // both the v3 API and the v4 MCP surface, but none of the obvious spellings
  // route, so this casts wider.
  'refdomains', 'referring_domains', 'referring-domains', 'domains',
  'refdomain', 'referringdomains', 'referring', 'linking_domains',
  'refdomains_overview', 'domains_history', 'refdomains_historical',
  // The rest of the Backlink Analytics family, per the v4 report list.
  'refips', 'referring_ips', 'anchors', 'pages', 'categories',
  'categories_profile', 'tld', 'geo', 'historical', 'ascore_profile',
  'authority_score', 'competitors',
  // Domain Overview family.
  'domain_rank', 'domain_ranks', 'rank', 'ranks', 'summary', 'overview_history'
];
const semV4Found = {};   // report -> the path that worked

async function semV4Raw(url, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  const headers = { Authorization: 'Apikey ' + SEM_KEY_V4, Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      method: body ? 'POST' : 'GET',
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
    clearTimeout(timeout);
    return { status: r.status, text: await r.text() };
  } finally { clearTimeout(timeout); }
}

// Turn one v4 body into { rows } — a list of plain objects keyed by column
// name — or { error }. The shape is read defensively: rows may arrive as a bare
// array, or under data/rows/items/result, and either as objects or as a
// columns+rows pair. Anything unrecognised is reported as unreadable rather
// than quietly parsed into zeroes, because a zero here would score as "this
// firm has no backlinks".
function semV4Parse(txt) {
  const head = (txt || '').trim().slice(0, 200);
  if (!head) return { error: 'SEMrush returned an empty body' };
  if (/^ERROR/i.test(head)) return { error: semWhy(txt) };

  let j;
  try { j = JSON.parse(txt); }
  catch (_) {
    const rows = semCsvRows(txt);
    if (rows) return { rows };
    return { error: 'SEMrush v4 returned something this proxy could not read: ' + head };
  }

  if (j && j.error)   return { error: semLabel(j.error.message || j.error) };
  if (j && j.message && !j.data && !j.rows) return { error: semLabel(j.message) };

  const body = Array.isArray(j) ? j : (j.data || j.rows || j.items || j.result);
  if (Array.isArray(body)) {
    if (body.length && Array.isArray(body[0]) && Array.isArray(j.columns)) {
      const cols = j.columns.map(c => (typeof c === 'string' ? c : c.name));
      return { rows: body.map(r => Object.fromEntries(cols.map((c, i) => [c, r[i]]))) };
    }
    return { rows: body };
  }
  if (body && typeof body === 'object') return { rows: [body] };
  return { error: 'SEMrush v4 returned no recognisable rows: ' + head };
}

// Which generation should serve this report, given the keys configured.
// Returns 'v3', 'v4', or an { error } naming exactly which key is missing --
// "refdomains needs a v3 key" is actionable, "no route" is not.
function semGenFor(report) {
  const supported = SEM_REPORT_GEN[report] || ['v3'];
  for (const g of supported) {
    if (g === 'v3' && SEM_KEY_V3) return 'v3';
    if (g === 'v4' && SEM_KEY_V4) return 'v4';
  }
  const need = supported.join(' or ');
  const have = [SEM_KEY_V3 && 'v3', SEM_KEY_V4 && 'v4'].filter(Boolean).join(' + ') || 'none';
  return { error: report + ' is only served by the ' + need + ' API' +
    (supported.length === 1 && supported[0] === 'v3'
      ? ' — it has not migrated to v4, so the v4 token cannot serve it'
      : '') +
    '. Keys configured: ' + have + '. Set SEMRUSH_KEY_V3 to the account\'s v3 API key.' };
}

async function semV4(report, params) {
  const qs = new URLSearchParams(params).toString();
  const known = semV4Found[report];
  const candidates = known ? [known.path] : SEM_V4_ROUTES[report];
  let last = null;
  const tried = [];

  for (const path of candidates) {
    let r, method = (known && known.method) || 'GET';
    try {
      r = method === 'POST'
        ? await semV4Raw(SEM_V4_BASE + path, params)
        : await semV4Raw(SEM_V4_BASE + path + (qs ? '?' + qs : ''));
    }
    catch (e) {
      last = e.name === 'AbortError' ? 'SEMrush timed out after 20s' : e.message;
      tried.push(path + ' → ' + last);
      continue;
    }

    // 405 means this path is right and only the method is wrong. Retry it as a
    // POST here, not just in the diagnostics, or the audit keeps failing on a
    // route we have already identified.
    if (r.status === 405 && method === 'GET') {
      try {
        const p2 = await semV4Raw(SEM_V4_BASE + path, params);
        if (p2.status !== 405) { r = p2; method = 'POST'; }
      } catch (_) { /* keep the GET result */ }
    }
    // A missing route is the only reason to try the next candidate. 401/403 is
    // the key, 429 is the rate limit, 402 is units — all of them mean this path
    // was right and something else is wrong, so stop and say so.
    // 404 means there is nothing here, so try the next candidate. 405 means
    // this route EXISTS and only the method is wrong -- worth recording
    // prominently, because it names the right path.
    if (r.status === 404) { tried.push(path + ' → 404'); last = 'no route at ' + path; continue; }
    if (r.status === 405) {
      tried.push(path + ' → 405 (route exists, but rejects GET and POST)');
      last = path + ' exists but rejects both GET and POST (HTTP 405)';
      continue;
    }
    if (r.status === 401) {
      return { error: 'SEMrush did not accept the key (HTTP 401) — check SEMRUSH_KEY is the v4 token, whole and unexpired' };
    }
    // 403 on a v4 route means the path is right and the account is not cleared
    // for it. That is a subscription question, not something to route around,
    // so say so rather than moving to the next candidate and blaming the path.
    // Confirmed against the live account: a 403 here was "ERROR 132 :: API UNITS
    // BALANCE IS ZERO" all along. The v4 JSON error body does not say so -- it
    // only says Forbidden -- so name the likeliest cause first, because an
    // empty unit balance reads exactly like a permissions problem and sends
    // people to their plan settings instead of their balance.
    if (r.status === 403) {
      return { error: 'SEMrush returned 403 Forbidden for ' + path +
        ' — the route exists, so this is an account problem, not a path problem. ' +
        'Check the API units balance first (a zero balance returns 403 here and ' +
        '"ERROR 132 :: API UNITS BALANCE IS ZERO" on v3); then check the plan ' +
        'covers the Backlinks API.' };
    }
    if (r.status === 402) return { error: 'SEMrush: out of API units' };
    if (r.status === 429) return { error: 'SEMrush: rate limited — try again shortly' };
    if (r.status >= 400)  return { error: 'SEMrush HTTP ' + r.status + ': ' + (r.text || '').trim().slice(0, 120) };

    const parsed = semV4Parse(r.text);
    if (parsed.error) { tried.push(path + ' → ' + parsed.error); last = parsed.error; continue; }
    semV4Found[report] = { path, method };
    return parsed;
  }
  // Name every path tried and what each said. Reporting only the last one made
  // a whole exhausted candidate list look like a single wrong guess.
  return { error: 'no working v4 route for ' + report + ' — tried: ' + tried.join('; ') +
                  '. Run /semrush/diag to see the full responses.' };
}

// v3's semicolon-delimited body -> the same list-of-objects shape as v4, so
// everything downstream reads one format regardless of which API answered.
function semCsvRows(txt) {
  const lines = (txt || '').trim().split('\n').filter(Boolean);
  if (lines.length < 2 || !lines[0].includes(';')) return null;
  const cols = lines[0].split(';').map(h => h.trim());
  return lines.slice(1).map(l => {
    const c = l.split(';');
    return Object.fromEntries(cols.map((h, i) => [h, c[i]]));
  });
}

// Column names differ between the two generations, and v3 labels its header row
// with DISPLAY names rather than the codes asked for in export_columns -- ask
// for "Or" and the header says "Organic Keywords". So match on a normalised
// key: lowercased, with everything but letters and digits stripped. That makes
// organic_keywords, "Organic Keywords" and organicKeywords the same lookup, and
// leaves the call sites naming both generations' columns and nothing else.
const semKey = k => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
function semCell(row, names) {
  if (!row) return null;
  const want = names.map(semKey);
  for (const k of Object.keys(row)) {
    if (want.includes(semKey(k)) && row[k] != null && row[k] !== '') return row[k];
  }
  return null;
}
const semNum = (row, ...names) => {
  const v = semCell(row, names);
  if (v == null) return null;
  const n = parseInt(String(v).replace(/[^0-9-]/g, ''), 10);
  return Number.isNaN(n) ? null : n;
};
const semStr = (row, ...names) => {
  const v = semCell(row, names);
  return v == null ? '' : String(v).trim();
};

// Authority Score, total backlinks and referring-domain count. Same story as
// the referring-domain list: SEMrush can only answer if a key can serve
// blOverview, so DataForSEO covers it otherwise. Its rank is 0-1000 where
// SEMrush's Authority Score is 0-100, so it is scaled to keep one meaning for
// the number the report prints and the c-da5 check tests.
async function backlinkSummaryFrom(target) {
  const d = await dfsPost('/backlinks/summary/live', [
    { target, internal_list_limit: 1, include_subdomains: true }
  ]);
  if (d && d.status_code && d.status_code !== 20000)
    return { error: 'DataForSEO ' + d.status_code + ': ' + d.status_message };
  const task = d?.tasks?.[0];
  if (task && task.status_code !== 20000)
    return { error: 'DataForSEO ' + task.status_code + ': ' + task.status_message };
  const it = task?.result?.[0];
  if (!it) return { error: 'DataForSEO returned no backlink summary for ' + target };
  return {
    da: it.rank != null ? Math.round(it.rank / 10) : null,
    backlinks: it.backlinks != null ? it.backlinks : null,
    refDomains: it.referring_domains != null ? it.referring_domains : null,
    source: 'dataforseo'
  };
}

// Returns { da, keywords, traffic } on success, or { error } when SEMrush
// reports a problem (bad key, no data) so the caller can fall back.
async function semrushOverview(domain) {
  // domain_rank → organic keywords + organic traffic.
  const gen = semGenFor('domainRank');
  if (gen.error) return { error: gen.error };
  const r = gen === 'v4'
    ? await semV4('domainRank', {
        target: domain, database: 'us',
        export_columns: 'domain,rank,organic_keywords,organic_traffic' })
    : await semLegacy(`https://api.semrush.com/?type=domain_rank&key=${SEM_KEY_V3}` +
        `&export_columns=Dn,Rk,Or,Ot&domain=${encodeURIComponent(domain)}&database=us`);
  if (r.error) return { error: r.error };

  const row = (r.rows || [])[0] || {};
  // Read by either generation's column name. null, not 0, when the column is
  // absent — a zero here would report a firm with real traffic as having none.
  const keywords = semNum(row, 'organic_keywords', 'Or', 'Organic Keywords');
  const traffic  = semNum(row, 'organic_traffic',  'Ot', 'Organic Traffic');

  // backlinks_overview → Authority Score (the real "DA"), plus total backlinks
  // and referring domains — all three come back in one billed call, so we may
  // as well take them. Best-effort: a failure here leaves them unmeasured
  // rather than aborting the whole overview.
  let da = null, backlinks = null, refDomains = null, blError = null;
  try {
    const bGen = semGenFor('blOverview');
    // No key can serve this one — don't call out with an empty key and read the
    // resulting auth error as "this firm has no backlinks".
    const b = bGen.error ? { error: bGen.error }
      : bGen === 'v4'
      ? await semV4('blOverview', {
          target: domain, target_type: 'root_domain',
          export_columns: 'authority_score,total,domains_num' })
      : await semLegacy(`https://api.semrush.com/analytics/v1/?type=backlinks_overview&key=${SEM_KEY_V3}` +
          `&target=${encodeURIComponent(domain)}&target_type=root_domain` +
          `&export_columns=ascore,total,domains_num`);
    if (b.error) {
      // SEMrush could not answer. Try DataForSEO before giving up — and keep
      // the reason either way. Swallowing it as "optional" is how a zero
      // API-unit balance looked like a firm with no backlink profile.
      blError = b.error;
      if (DFS_LOGIN) {
        const alt = await backlinkSummaryFrom(domain);
        if (!alt.error) {
          return { da: alt.da, keywords, traffic,
                   backlinks: alt.backlinks, refDomains: alt.refDomains,
                   blSource: 'dataforseo' };
        }
        blError += ' · DataForSEO: ' + alt.error;
      }
    } else {
      const br = (b.rows || [])[0] || {};
      da         = semNum(br, 'authority_score', 'ascore', 'Authority Score');
      backlinks  = semNum(br, 'total', 'Backlinks');
      refDomains = semNum(br, 'domains_num', 'Referring Domains');
    }
  } catch (e) { blError = e.message; }

  return { da, keywords, traffic, backlinks, refDomains, blError, blSource: 'semrush' };
}

// A v3 call, normalised to the same { rows } / { error } shape as semV4 so the
// call sites above do not branch on anything but the URL.
async function semLegacy(url) {
  let txt;
  try { txt = await semFetch(url); }
  catch (e) { return { error: e.name === 'AbortError' ? 'SEMrush timed out after 20s' : e.message }; }
  const trimmed = (txt || '').trim();
  if (/^ERROR/i.test(trimmed)) return { error: semWhy(trimmed) };
  return { rows: semCsvRows(trimmed) || [] };
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
// semV3/semV4 are reported separately: they serve different reports, and
// "sem: true" hid that the one report with no v4 route had no key to run on.
app.get('/health', (req, res) => res.json({ ok: true, dfs: !!DFS_LOGIN,
  sem: !!(SEM_KEY_V3 || SEM_KEY_V4), semV3: !!SEM_KEY_V3, semV4: !!SEM_KEY_V4,
  sf: !!SF_KEY, ai: !!ANTHROPIC_KEY, at: !!AIRTABLE_TOKEN, google: !!GOOGLE_KEY,
  locked: !!AUDIT_KEY, model: AI_MODEL }));

// ── SEMrush diagnostics ───────────────────────────────────────────────────────
// Probes every candidate v4 route and reports what each one answered. v4 is
// Early Access, so a route can move; this turns "the directory check is broken"
// into a specific path and status without redeploying to find out. Never
// returns the key itself -- only its generation, length and last four.
app.get('/semrush/diag', async (req, res) => {
  if (!SEM_KEY_V3 && !SEM_KEY_V4) return res.json({ error: 'SEMRUSH_KEY not set' });
  const target = rootDomain(req.query.domain || 'semrush.com');
  const out = {
    keysConfigured: { v3: !!SEM_KEY_V3, v4: !!SEM_KEY_V4 },
    reportGenerations: SEM_REPORT_GEN,
    keyGeneration: SEM_KEY_V4 ? 'v4 (token)' : 'v3 (32-char hex)',
    keyLength: (SEM_KEY_V4 || SEM_KEY_V3).length,
    keyEndsWith: (SEM_KEY_V4 || SEM_KEY_V3).slice(-4),
    base: SEM_V4_BASE,
    target,
    probes: []
  };

  if (!SEM_KEY_V4) {
    const r = await semLegacy(`https://api.semrush.com/?type=domain_rank&key=${SEM_KEY_V3}` +
      `&export_columns=Dn,Rk,Or,Ot&domain=${encodeURIComponent(target)}&database=us`);
    out.probes.push({ generation: 'v3', report: 'domainRank',
                      ok: !r.error, error: r.error, rows: (r.rows || []).length });
    return res.json(out);
  }

  const params = {
    domainRank: { target, database: 'us', export_columns: 'domain,rank,organic_keywords,organic_traffic' },
    blOverview: { target, target_type: 'root_domain', export_columns: 'authority_score,total,domains_num' },
    refDomains: { target, target_type: 'root_domain', export_columns: 'domain,domain_authority_score', display_limit: 5 }
  };

  // Ask the API about itself first. A root or discovery document, or even the
  // error body from a known-good path, usually names the real route layout --
  // worth more than another round of guessing.
  out.discovery = [];
  for (const probe of ['', '/', '/backlinks/v1', '/backlinks/v1/links']) {
    try {
      const r = await semV4Raw(SEM_V4_BASE + probe + (probe.endsWith('links') ?
        '?target=' + encodeURIComponent(target) + '&target_type=root_domain&display_limit=1' : ''));
      out.discovery.push({ path: probe || '(root)', status: r.status,
                           sample: (r.text || '').trim().slice(0, 300) });
    } catch (e) { out.discovery.push({ path: probe || '(root)', error: e.message }); }
  }

  for (const [report, paths] of Object.entries(SEM_V4_ROUTES)) {
    for (const path of paths) {
      const qs = new URLSearchParams(params[report]).toString();
      let r;
      try { r = await semV4Raw(SEM_V4_BASE + path + '?' + qs); }
      catch (e) { out.probes.push({ report, path, error: e.message }); continue; }

      // 405 says the route is right and only the method is wrong, so retry it
      // as a POST rather than moving on and reporting "no route".
      let method = 'GET';
      if (r.status === 405) {
        try {
          const p2 = await semV4Raw(SEM_V4_BASE + path, params[report]);
          if (p2.status !== 405) { r = p2; method = 'POST'; }
        } catch (_) { /* keep the GET result */ }
      }

      const parsed = r.status < 400 ? semV4Parse(r.text) : { error: 'HTTP ' + r.status };
      out.probes.push({
        report, path, method, status: r.status,
        ok: !parsed.error,
        rows: parsed.rows ? parsed.rows.length : 0,
        fields: parsed.rows && parsed.rows[0] ? Object.keys(parsed.rows[0]) : undefined,
        error: parsed.error,
        sample: (r.text || '').trim().slice(0, 300)
      });
      if (!parsed.error) break;   // this report is answered; move to the next
    }
  }
  res.json(out);
});

// ── SEMrush route map ─────────────────────────────────────────────────────────
// v4's route layout is not documented anywhere this proxy can reach, and the
// paths moved. But the API answers 404 for a path that does not exist and 403
// for one that does and this account cannot use -- routing runs before
// authorisation -- so the surface can be mapped without being authorised for
// any of it. Probes each family/segment pair and reports the ones that exist.
// Costs no API units: every response is an error before any report is run.
app.get('/semrush/map', async (req, res) => {
  if (!SEM_KEY_V4) return res.json({ error: 'no v4 token set — the route map only applies to v4' });

  const exists = [], missing = [], other = [];
  const jobs = [];
  for (const fam of SEM_V4_MAP_FAMILIES)
    for (const seg of SEM_V4_MAP_SEGMENTS) jobs.push(fam + '/' + seg);

  // Small batches: this is dozens of requests and the point is a map, not a
  // stampede against someone else's rate limit.
  for (let i = 0; i < jobs.length; i += 6) {
    await Promise.all(jobs.slice(i, i + 6).map(async path => {
      try {
        const r = await semV4Raw(SEM_V4_BASE + path);
        if (r.status === 403)      exists.push({ path, status: 403 });
        else if (r.status === 404) missing.push(path);
        else other.push({ path, status: r.status, sample: (r.text || '').trim().slice(0, 160) });
      } catch (e) { other.push({ path, error: e.message }); }
    }));
  }

  res.json({
    note: '403 = the route exists but this account is not authorised for it. ' +
          '404 = no such route. Anything else is listed under "other" and is the ' +
          'most interesting: it means the account CAN reach that route.',
    base: SEM_V4_BASE,
    probed: jobs.length,
    exists, other,
    missingCount: missing.length
  });
});

// ── 1. Domain overview — DA, keywords, traffic ────────────────────────────────
// Endpoint: /v3/dataforseo_labs/google/domain_rank_overview/live
app.get('/domain/overview', async (req, res) => {
  const { domain } = req.query;
  if (!domain) return res.status(400).json({ error: 'domain required' });

  // Prefer SEMrush when a key is configured — it returns a real Authority Score
  // for DA plus organic keywords/traffic. Fall back to DataForSEO on error.
  if (SEM_KEY_V3 || SEM_KEY_V4) {
    try {
      const s = await semrushOverview(domain);
      if (s && !s.error) return res.json({
        da: s.da, keywords: s.keywords, traffic: s.traffic,
        backlinks: s.backlinks, refDomains: s.refDomains, source: 'semrush',
        note: s.blError ? semLabel(s.blError) : undefined
      });
      if (s && s.error && !DFS_LOGIN) return res.json({ da: null, keywords: null, traffic: null, note: semLabel(s.error) });
      // else fall through to DataForSEO
    } catch (e) {
      if (!DFS_LOGIN) return res.status(500).json({ error: semLabel(e.message) });
      // else fall through to DataForSEO
    }
  }

  if (!DFS_LOGIN) return res.status(500).json({ error: 'No SEO source configured (set SEMRUSH_KEY or DataForSEO)' });
  try {
    // No location_code and no language_code: DataForSEO then returns one row
    // per country-language pair the domain ranks in, rather than a single
    // market. The previous call pinned location_code 2840 (United States), so
    // everything outside the US was invisible.
    const d = await dfsPost('/dataforseo_labs/google/domain_rank_overview/live', [
      { target: domain }
    ]);
    console.log('DFS domain full response:', JSON.stringify(d)?.slice(0, 500));
    // Top-level DataForSEO error (auth, credits, access).
    if (d && d.status_code && d.status_code !== 20000) {
      return res.json({ da: null, keywords: null, traffic: null, note: 'DataForSEO ' + d.status_code + ': ' + d.status_message });
    }
    const task = d?.tasks?.[0];
    // Surface a real reason when DataForSEO didn't return usable data.
    if (task && task.status_code !== 20000) {
      return res.json({ da: null, keywords: null, traffic: null, note: 'DataForSEO ' + task.status_code + ': ' + task.status_message });
    }
    // Every locale row, not items[0]. Reading the first row alone would have
    // reported whichever market DataForSEO happened to return first as if it
    // were the whole picture.
    const rows = (task?.result || []).flatMap(r => r.items || []);
    console.log('DFS domain locales:', rows.length);
    if (!rows.length) return res.json({ da: null, keywords: null, traffic: null, note: 'no data for this domain' });

    const organicOf = it => it.metrics?.organic || it.organic || {};
    // Estimated traffic is per-locale visits, so it adds up across markets.
    const traffic = Math.round(rows.reduce((a, it) => a + (organicOf(it).etv || organicOf(it).estimated_traffic || 0), 0));
    // Keyword counts are per-locale ranking positions. A keyword the firm ranks
    // for in both the US and Canada is counted in both, so this is "ranking
    // positions across all markets" rather than distinct keywords — worth
    // knowing before the number is quoted to a client as "keywords".
    const keywords = rows.reduce((a, it) => {
      const o = organicOf(it);
      return a + (o.count || ((o.pos_1||0) + (o.pos_2_3||0) + (o.pos_4_10||0)) || 0);
    }, 0);

    // Which market actually carries the firm, for context in the report.
    const top = rows.reduce((best, it) =>
      (organicOf(it).etv || 0) > (organicOf(best).etv || 0) ? it : best, rows[0]);
    const scope = {
      locales: rows.length,
      topLocation: top?.location_code ?? null,
      topLanguage: top?.language_code ?? null,
      topTraffic: Math.round(organicOf(top).etv || 0)
    };
    const item = top;

    // domain_rank_overview carries no domain-authority field, so `da` used to
    // be 0 here no matter the firm -- a real number for every other metric and
    // a silent zero for the one the DA check scores on. The Backlinks summary
    // is where authority actually lives, so ask for it.
    let da = item.rank || item.domain_rank || null, backlinks = null, refDomains = null, blNote;
    const bl = await backlinkSummaryFrom(domain);
    if (bl.error) blNote = bl.error;
    else { da = bl.da; backlinks = bl.backlinks; refDomains = bl.refDomains; }

    res.json({ da, keywords, traffic, backlinks, refDomains, scope,
               source: 'dataforseo', note: blNote });
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
    // Ask only for the two categories we read. Unfiltered, PageSpeed also runs
    // and returns accessibility and best-practices, which roughly doubles a
    // response that is already megabytes of JSON -- and this proxy parses the
    // whole thing in memory on a 512MB instance. Every audit used below
    // (largest-contentful-paint, first-contentful-paint, total-blocking-time,
    // total-byte-weight, resource-summary, third-party-summary,
    // uses-optimized-images, uses-responsive-images) is in performance;
    // viewport, is-crawlable, meta-description and robots-txt are in seo.
    const psUrl = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=' +
      encodeURIComponent(url) + '&strategy=' + strategy +
      '&category=performance&category=seo' + (GOOGLE_KEY ? '&key=' + GOOGLE_KEY : '');
    console.log('PageSpeed fetching:', psUrl.slice(0, 100));
    // One retry. Lighthouse runs a real browser against a live site, so a
    // failure is often transient — a slow first byte, a cold CDN, a redirect
    // that resolved on the second attempt. Retrying once costs a minute and
    // saves a check that would otherwise be reported as unmeasurable.
    let d = null, gMsg = '', runtime = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);  // slow sites can take >30s for a full Lighthouse run
      try {
        const r = await fetch(psUrl, { signal: controller.signal });
        d = await r.json();
      } finally { clearTimeout(timeout); }

      gMsg = d?.error?.message || (typeof d?.error === 'string' ? d.error : '') || d?.message || '';
      // "Lighthouse returned error: Something went wrong." is Google's generic
      // wrapper; the code underneath it is the part that says what to do.
      runtime = d?.lighthouseResult?.runtimeError || null;
      if (d?.lighthouseResult?.audits) break;
      if (attempt === 1) console.log('PageSpeed attempt 1 failed (' + (gMsg || 'no data') + '), retrying');
    }

    console.log('PageSpeed response status:', d?.lighthouseResult ? 'ok' : (gMsg || 'no lighthouse result'));
    const audits = d?.lighthouseResult?.audits;
    const cats   = d?.lighthouseResult?.categories;
    if (!audits) {
      // Translate the codes that have a real remedy. Everything else is
      // relayed with its code attached, which is still more than "Something
      // went wrong" gave anyone to work with.
      const code = runtime?.code || '';
      const why = {
        ERRORED_DOCUMENT_REQUEST:  'Lighthouse could not load the page at all — the server refused or reset the request. Sites behind a strict WAF often block it.',
        FAILED_DOCUMENT_REQUEST:   'Lighthouse could not load the page at all — the server refused or reset the request.',
        NO_FCP:                    'the page never rendered anything Lighthouse could measure, usually a redirect loop, a blocking script, or a consent wall.',
        NO_LCP:                    'the page never painted a largest-contentful element Lighthouse could time.',
        DNS_FAILURE:               'the domain did not resolve from Google\'s side.',
        INVALID_URL:               'Google rejected the URL as malformed.'
      }[code];
      const detail = why ? code + ' — ' + why
                   : code ? (runtime.message || gMsg || 'no data') + ' (' + code + ')'
                   : (gMsg || 'no data');
      return res.status(502).json({
        error: 'PageSpeed: ' + detail +
               (GOOGLE_KEY ? '' : ' — no GOOGLE_API_KEY set') +
               ' · tried twice on the ' + strategy + ' run' });
    }

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
    // No fallback to perfScore. That rule measured SPEED, not mobile-
    // friendliness, and under a desktop run it means nothing at all -- it is
    // the exact conflation the note above describes removing, and leaving it
    // here as a fallback quietly reinstated it. Unmeasured is null.
    const isMobile    = viewportAudit != null ? viewportAudit >= 0.9 : null;
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

// The mobile-viewport declaration, read straight from the page. PageSpeed's
// `viewport` audit says the same thing, but it is one more thing that has to
// have succeeded — and when it has not, the audit should say "not measured"
// rather than fall back to a number that means something else entirely.
// A declared viewport is a necessary condition for a usable mobile page, not
// a sufficient one, which is why the check is named for the tag.
function readViewport(html) {
  for (const m of String(html).matchAll(/<meta\b[^>]*>/gi)) {
    const tag  = m[0];
    const name = (/\bname\s*=\s*["']?([^"'\s>]+)/i.exec(tag) || [])[1] || '';
    if (!/^viewport$/i.test(name)) continue;
    const content = (/\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag) || [])[1] || '';
    return { content: content.trim(),
             ok: /\bwidth\s*=/i.test(content) || /\binitial-scale\s*=/i.test(content) };
  }
  return null;
}

// ── 3. Sitemap check — direct HTTP ping ──────────────────────────────────────
app.get('/site/check', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const results = {};
    const base = url.replace(/\/$/, '');
    const UA   = BROWSER_HEADERS;

    // Find the sitemap the way a crawler does. Checking only /sitemap.xml
    // missed most of them: robots.txt DECLARES the location and that line is
    // authoritative, WordPress with Yoast publishes /sitemap_index.xml, and
    // WordPress 5.5+ publishes /wp-sitemap.xml — none of which live at the
    // one path this used to try. A firm with a perfectly good sitemap was
    // being reported as having none.
    //
    // robots.txt is fetched first now because it answers both questions.
    let robotsBody = '';
    try {
      const rr = await fetch(base + '/robots.txt', { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(8000) });
      results.robotsTxt = rr.ok;
      if (rr.ok) robotsBody = (await rr.text()).slice(0, 100000);
    } catch (e) { results.robotsTxt = false; }

    const declared = [...robotsBody.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)].map(m => m[1].trim());
    const candidates = [
      ...declared,
      base + '/sitemap.xml',
      base + '/sitemap_index.xml',     // Yoast, and most WordPress SEO plugins
      base + '/wp-sitemap.xml',        // WordPress 5.5+ core
      base + '/sitemap-index.xml',
      base + '/sitemap1.xml'
    ].filter((v, i, a) => a.indexOf(v) === i);
    results.sitemapDeclared = declared;

    results.sitemap = false;
    results.sitemapTried = [];
    for (const cand of candidates) {
      try {
        const sr = await fetch(cand, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(10000) });
        if (!sr.ok) { results.sitemapTried.push(cand + ' → HTTP ' + sr.status); continue; }
        // Sniff the body: a soft-404 that returns 200 with an HTML page is not
        // a sitemap. Requiring <urlset or <sitemapindex rather than merely
        // "<?xml" also stops an XML-formatted error page counting as one.
        const body = (await sr.text()).slice(0, 4000).toLowerCase();
        if (body.includes('<urlset') || body.includes('<sitemapindex')) {
          results.sitemap    = true;
          results.sitemapUrl = cand;
          results.sitemapStatus = sr.status;
          results.sitemapNote = declared.includes(cand)
            ? 'declared in robots.txt' : 'found at ' + cand.replace(base, '');
          break;
        }
        results.sitemapTried.push(cand + ' → 200 but not a sitemap');
      } catch (e) {
        results.sitemapTried.push(cand + ' → ' + e.message);
      }
    }
    if (!results.sitemap) {
      results.sitemapUrl  = base + '/sitemap.xml';
      results.sitemapNote = 'none found — tried ' + candidates.length + ' locations' +
                            (declared.length ? ', including the one robots.txt declares' : '');
    }

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
        results.viewport = null;
        results.viewportNote = 'homepage returned HTTP ' + pr.status;
      } else {
        const xRobots = (pr.headers.get('x-robots-tag') || '').trim();
        const html    = (await pr.text()).slice(0, 300000);
        const metas   = readRobotsMeta(html);
        const blockers = [];
        if (/\bnoindex\b/i.test(xRobots)) blockers.push('X-Robots-Tag: ' + xRobots);
        for (const m of metas) {
          if (/\bnoindex\b/i.test(m.content)) blockers.push('<meta name="' + m.name + '" content="' + m.content + '">');
        }
        const vp = readViewport(html);
        results.viewport     = vp ? vp.ok : false;
        results.viewportNote = vp
          ? (vp.ok ? 'declares viewport: ' + vp.content
                   : 'has a viewport tag but it sets neither width nor initial-scale: ' + vp.content)
          : 'no <meta name="viewport"> on the homepage';

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
      results.viewport = null;
      results.viewportNote = 'could not fetch the homepage: ' + e.message;
    }

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
      headers: BROWSER_HEADERS,
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

// The referring-domain list, from whichever provider can actually supply it.
// SEMrush serves it only from v3: the v4 route map turned up overview, links,
// anchors, pages, competitors and summary, and no refdomains endpoint of any
// spelling. An account with only a v4 token therefore cannot run this check at
// all -- and v4 tokens are what Semrush issues now -- so DataForSEO, which this
// proxy already uses for GBP and domain metrics, is the primary source and
// SEMrush v3 the fallback for accounts that still hold a key.
async function refDomainsFrom(target) {
  if (DFS_LOGIN) {
    const d = await dfsPost('/backlinks/referring_domains/live', [
      { target, limit: 1000, order_by: ['rank,desc'] }
    ]);
    if (d && d.status_code && d.status_code !== 20000)
      return { error: 'DataForSEO ' + d.status_code + ': ' + d.status_message };
    const task = d?.tasks?.[0];
    if (task && task.status_code !== 20000)
      return { error: 'DataForSEO ' + task.status_code + ': ' + task.status_message };
    const items = task?.result?.[0]?.items;
    // No items array at all is a shape we did not understand; an empty one is a
    // real answer (this domain has no referring domains). Only the first is an
    // error -- treating them alike would score every directory as missing.
    if (!Array.isArray(items))
      return { error: 'DataForSEO returned no referring-domain list for ' + target };
    return { rows: items, source: 'dataforseo' };
  }

  const gen = semGenFor('refDomains');
  if (gen.error) return { error: semLabel(gen.error) };
  const base = `https://api.semrush.com/analytics/v1/?type=backlinks_refdomains&key=${SEM_KEY_V3}` +
               `&target=${encodeURIComponent(target)}&target_type=root_domain` +
               `&export_columns=domain,domain_ascore&display_limit=1000`;
  let r = await semLegacy(base + '&display_sort=domain_ascore_desc');
  if (r.error) r = await semLegacy(base);
  if (r.error) return { error: semLabel(r.error) };
  return { rows: r.rows || [], source: 'semrush' };
}

app.get('/directories', async (req, res) => {
  const { domain } = req.query;
  if (!domain) return res.status(400).json({ error: 'domain required' });
  if (!DFS_LOGIN && !SEM_KEY_V3 && !SEM_KEY_V4) return res.status(500).json({
    error: 'No backlink source configured — directory checks read the referring-domain list, ' +
           'which needs DataForSEO or a SEMrush v3 key' });

  const target = rootDomain(domain);

  try {
    // Sorted by authority so the directories that matter surface first if the
    // firm has more referring domains than the limit.
    const r = await refDomainsFrom(target);
    if (r.error) return res.json({ error: r.error });

    // Read the domain column by name under either generation. A response that
    // parsed but carried no usable domain column is reported as unreadable, not
    // as a firm with no referring domains -- that would score every directory
    // as missing and quietly cost the client real points.
    const seen = new Set();
    for (const row of r.rows || []) {
      const d = rootDomain(semStr(row, 'domain', 'source_url', 'url', 'referring_domain'));
      if (d) seen.add(d);
    }
    if (!seen.size && (r.rows || []).length) {
      return res.json({ error: (r.source === 'dataforseo' ? 'DataForSEO' : 'SEMrush') +
        ' returned ' + r.rows.length + ' referring domains but no readable domain ' +
        'column — fields were: ' + Object.keys(r.rows[0] || {}).join(', ') });
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
      source: r.source,
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

  // A heartbeat on its own timer, not on upstream events. The ping used to fire
  // from onEvent, which means it only fired while Anthropic was actively
  // streaming -- and the long stretches in these reviews are exactly the ones
  // where it is NOT: a web_fetch of a slow page, or a server-side tool loop
  // running between turns. The connection sat silent for those stretches and
  // got dropped as idle, which the app saw as a review that returned nothing.
  // The social review is the one that hits this, being the most tool-hungry.
  const started = Date.now();
  const beat = setInterval(() => send({ type: 'ping', elapsed: Math.round((Date.now() - started) / 1000) }), 5000);

  // Stop working the moment the browser goes away, rather than finishing a
  // multi-minute review for a client that is no longer listening.
  let gone = false;
  res.on('close', () => { gone = true; clearInterval(beat); });

  try {
    const out = await claudeRun({
      prompt, model, tools: WEB_TOOLS, maxTokens: 8192,
      onResume: () => send({ type: 'resuming' })
    });
    clearInterval(beat);
    if (gone) return;
    if (out.error) { send({ type: 'error', error: out.error }); return res.end(); }
    send({ type: 'done', text: out.text, stop_reason: out.stopReason, model: pickModel(model),
           elapsed: Math.round((Date.now() - started) / 1000) });
    res.end();
  } catch (e) {
    clearInterval(beat);
    console.error('AI proxy error:', e.message);
    if (gone) return;
    send({ type: 'error', error: e.message });
    res.end();
  }
});

// ── 5a. AI mentions — DataForSEO LLM Mentions ────────────────────────────────
// What this measures, and why it is not the same as the Claude check below.
//
//   This endpoint        — how often the firm actually appears in AI answers
//                          people really asked, across Google's AI Overview and
//                          ChatGPT, from a prompt database of hundreds of
//                          millions. A population, not a sample.
//   /ai/visibility below — whether Claude, specifically, knows the firm, over a
//                          dozen synthetic runs. Useful, but a dozen runs means
//                          3/10 and 4/10 are the same number wearing different
//                          clothes, and nobody's prospects ask Claude.
//
// Both are kept: they answer different questions. This one is what belongs in
// front of a client.
const AIM_BASE = '/ai_optimization/llm_mentions';
const AIM_PLATFORMS = ['google', 'chat_gpt'];   // AI Overview (all locations), ChatGPT (US only)

// The real shape, confirmed against the live API. `items` and `total_count`
// describe a detail list that comes back empty for these queries; everything
// worth reporting is in `aggregated_metrics`:
//
//   total                  { mentions, ai_search_volume }
//   location / language /
//   platform               the same pair, broken down
//   sources_domain         ranked: domains CITED in answers that mention the firm
//   search_results_domain  ranked: domains the model RETRIEVED (ChatGPT only)
//   brand_entities_*       brands named alongside
//
// Reading only `items` reported a firm with 855 mentions as having none.
const aimNum = (o, k) => {
  const v = o && o[k];
  if (v == null || v === '') return null;
  const num = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isNaN(num) ? null : num;
};

// Domain keys arrive as markdown links — "[www.example.com](https://www.example.com)"
// — mixed in with bare ones like "en.wikipedia.org". Pull the label out of the
// link, then normalise, or every cited domain prints with its own URL glued on.
function aimDomain(key) {
  const k = String(key || '').trim();
  const md = k.match(/^\[([^\]]+)\]\((.*)\)$/);
  return rootDomain(md ? md[1] : k);
}

// A ranked source list, normalised and flagged against the firm's own domain.
function aimSources(list, own, limit) {
  return (Array.isArray(list) ? list : []).map(r => ({
    domain: aimDomain(r.key),
    mentions: aimNum(r, 'mentions'),
    searchVolume: aimNum(r, 'ai_search_volume')
  })).filter(r => r.domain)
     .map(r => ({ ...r, own: r.domain === own }))
     .slice(0, limit || 15);
}

// `target` is an array of OBJECTS — up to ten, each carrying a domain or a
// keyword plus optional per-entity settings. Passing plain strings returns
// "Invalid Field: 'Each target item must be an object.'". The domain/keyword
// shape is the one the live API accepts; the others are kept as fallbacks in
// case it changes, tried only on a validation error.
const AIM_TARGET_SHAPES = [
  { name: 'domain/keyword', build: t => t.kind === 'domain' ? { domain: t.value } : { keyword: t.value } },
  { name: 'target+type',    build: t => ({ target: t.value, type: t.kind }) },
  { name: 'value+type',     build: t => ({ value: t.value, type: t.kind }) }
];
let aimShape = null;
const aimIsValidationError = code => code === 40501 || code === 40001;

async function aimTargetMetricsOnce({ targets, platform, locationCode, languageCode, shape }) {
  const d = await dfsPost(AIM_BASE + '/target_metrics/live', [{
    target: targets.map(shape.build),
    platform,
    location_code: locationCode || 2840,
    language_code: languageCode || 'en',
    internal_list_limit: 10
  }]);
  if (d && d.status_code && d.status_code !== 20000)
    return { error: 'DataForSEO ' + d.status_code + ': ' + d.status_message, code: d.status_code };
  const task = d?.tasks?.[0];
  if (task && task.status_code !== 20000)
    return { error: 'DataForSEO ' + task.status_code + ': ' + task.status_message, code: task.status_code };
  const result = task?.result?.[0];
  if (!result) return { error: 'DataForSEO returned no LLM mentions result for ' +
    targets.map(t => t.value).join(', ') };
  return { result, items: result.items || [],
           // The totals live here, not in items. Reading only items reported a
           // firm with real AI presence as having none whenever the per-row
           // breakdown came back empty.
           agg: result.aggregated_metrics || null,
           totalCount: result.total_count ?? null, shape: shape.name };
}

async function aimTargetMetrics(opts) {
  const shapes = aimShape ? [aimShape] : AIM_TARGET_SHAPES;
  let last = null;
  const tried = [];
  for (const shape of shapes) {
    const r = await aimTargetMetricsOnce({ ...opts, shape });
    if (!r.error) { aimShape = shape; return r; }
    tried.push(shape.name + ' → ' + r.error);
    last = r;
    // Not a "wrong shape" answer — the request was understood and something
    // else is wrong. Trying other spellings would just bill for more failures.
    if (!aimIsValidationError(r.code)) return { ...r, tried };
  }
  return { ...last, tried, error: (last && last.error) + ' · tried target shapes: ' + tried.join(' | ') };
}

app.post('/ai/mentions', async (req, res) => {
  if (!DFS_LOGIN) return res.status(500).json({ error: 'DataForSEO not configured — LLM Mentions needs it' });
  const { name, domain } = req.body || {};
  if (!domain) return res.status(400).json({ error: 'domain required' });

  const target = rootDomain(domain);
  // The domain and the brand name are different targets: a firm can be talked
  // about constantly and never have its site cited, which is exactly the gap
  // worth reporting.
  const targets = [{ value: target, kind: 'domain' },
                   ...(name ? [{ value: name, kind: 'keyword' }] : [])];

  const out = { target, targets, platforms: {} };
  for (const platform of AIM_PLATFORMS) {
    const r = await aimTargetMetrics({
      targets, platform,
      locationCode: parseInt(req.body.locationCode, 10) || 2840,
      languageCode: req.body.languageCode || 'en'
    });
    if (r.error) { out.platforms[platform] = { error: r.error }; continue; }

    // Sum across the returned rows: the endpoint groups by location, language,
    // model and domain, so one row is a slice rather than the whole answer.
    const agg      = r.agg || {};
    const total    = agg.total || {};
    const cited    = aimSources(agg.sources_domain, target);
    const retrieved = aimSources(agg.search_results_domain, target);
    const ownCited = cited.find(x => x.own) || null;
    const mentions = aimNum(total, 'mentions');

    out.platforms[platform] = {
      targetShape:  r.shape,
      mentions,
      searchVolume: aimNum(total, 'ai_search_volume'),
      // How much of the firm's own AI presence is built on their own site
      // versus everyone else's. The headline finding on this page.
      ownCitedMentions: ownCited ? ownCited.mentions : null,
      ownCitedShare: (ownCited && mentions) ? Math.round((ownCited.mentions / mentions) * 100) : null,
      // Who the model cites, and separately what it retrieved. They differ:
      // ChatGPT reads more of the firm's own site than it ends up citing.
      cited,
      retrieved,
      brands: aimSources(agg.brand_entities_title, target, 10),
      aggFields: Object.keys(agg)
    };
  }

  const anyOk = Object.values(out.platforms).some(p => !p.error);
  if (!anyOk) return res.status(502).json({ error: 'LLM Mentions returned nothing: ' +
    Object.entries(out.platforms).map(([k, v]) => k + ' → ' + v.error).join(' · ') });
  res.json(out);
});

// Prints what DataForSEO actually returns, so the field names above can be
// pinned to the real ones instead of a plausible list.
app.post('/ai/mentions/diag', async (req, res) => {
  if (!DFS_LOGIN) return res.json({ error: 'DataForSEO not configured' });
  const target = rootDomain(req.body?.domain || 'fisherinvestments.com');
  const out = { target, platforms: {} };
  const one = [{ value: target, kind: 'domain' }];
  for (const platform of AIM_PLATFORMS) {
    const r = await aimTargetMetrics({ targets: one, platform });
    out.platforms[platform] = r.error ? { error: r.error, triedShapes: r.tried || [] } : {
      targetShape: r.shape,
      totalCount: r.totalCount,
      rows: r.items.length,
      resultKeys: Object.keys(r.result || {}),
      // The whole aggregate block verbatim — this is where the totals are, and
      // a plain key list does not say whether they are populated.
      aggregatedMetrics: r.agg,
      itemKeys: r.items[0] ? Object.keys(r.items[0]) : [],
      firstItem: r.items[0] || null
    };
  }

  res.json(out);
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

// Pull every source Claude actually read out of the web_search result blocks.
// Errors come back on the same block with `content` as an OBJECT rather than a
// list (and HTTP 200, no exception), so branch on that before iterating.
//
// Returns the domains AND what was read at each one. The boolean "was the
// firm's own site among them" is only one question this answers; the list
// itself is the more useful finding, because it names the sources that speak
// for the firm when an AI answers questions about them.
function citedSources(blocks) {
  const out = new Map();   // domain -> { domain, url, title }
  for (const b of blocks || []) {
    if (b.type !== 'web_search_tool_result') continue;
    if (!Array.isArray(b.content)) continue;          // error object, not results
    for (const r of b.content) {
      const d = rootDomain(r && r.url);
      if (!d) continue;
      if (!out.has(d)) out.set(d, { domain: d, url: r.url || null, title: (r.title || '').slice(0, 140) });
    }
  }
  return out;
}
const citedDomains = blocks => new Set(citedSources(blocks).keys());

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
    // The paragraph is capped at 440 characters, but the budget is not what the
    // paragraph costs. Thinking is billed against max_tokens and is deliberately
    // excluded from the text this returns, so a model that reasons for a few
    // hundred tokens hit the old 700 ceiling before emitting a single visible
    // character -- an empty string reported as "no summary returned". Only
    // generated tokens are charged, so headroom here costs nothing when unused.
    const out = await claudeOnce({
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 4000,
      model
    });
    if (out.error) return res.status(502).json({ error: out.error });
    const text = (out.text || '').trim();
    if (!text) {
      // Say which empty this is. They have different fixes and used to look
      // identical from the app.
      return res.status(502).json({ error: out.stopReason === 'max_tokens'
        ? 'the model used its whole token budget before writing anything — raise maxTokens on /ai/summary'
        : 'the model returned no text' +
          (out.stopReason ? ' (stopped on: ' + out.stopReason + ')' : '') });
    }
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
        cited: job.mode === 'citation' ? citedDomains(out.blocks).has(want) : false,
        // The sources themselves, not just whether ours was among them.
        sources: job.mode === 'citation' ? [...citedSources(out.blocks).values()] : []
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
      // Every source Claude read across the searched runs, most-cited first,
      // with how many runs each appeared in and whether it is the firm's own
      // site. This is the answer to "who speaks for us when an AI is asked" --
      // and when the firm's own domain is absent from a long list, that is the
      // finding, not the absence of data.
      sources: (() => {
        const seen = new Map();
        for (const r of citation.concat(bCite)) {
          for (const src of r.sources || []) {
            const cur = seen.get(src.domain);
            if (cur) { cur.runs++; continue; }
            seen.set(src.domain, { ...src, runs: 1, own: src.domain === want });
          }
        }
        return [...seen.values()].sort((a, b) => b.runs - a.runs).slice(0, 40);
      })(),
      sourceRuns: citation.length + bCite.length,
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
