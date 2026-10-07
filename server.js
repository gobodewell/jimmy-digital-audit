const express = require('express');
const zlib    = require('zlib');
const cors    = require('cors');

const app  = express();
// Bumped whenever a build is handed over. /health reports it so the app can
// tell the user their page and their proxy are different vintages -- the
// failure mode is a fix that silently is not there.
const BUILD = '2026-10-07.2';
// Building the report without a browser. See render.js: the scoring engine
// stays in the page, this turns the page's report DATA into the same pages.
const { renderReport, reportName, templateNames, templateInfo, checkReport, rendererStatus } = require('./render.js');
// Running the audit without a person. See runner.js: it drives the real page
// in a headless browser rather than reimplementing the forty checks here.
//
// Loaded on first use, not at boot -- the same reason render.js is. A
// top-level require turns a deploy that forgot one file into "Cannot find
// module" before app.listen, which takes the WHOLE proxy down rather than the
// one capability that is missing. The test suite caught this exact mistake
// here after it had already been fixed once for the renderer.
let _runner = null;
function runner() {
  if (_runner) return _runner;
  try { return (_runner = require('./runner.js')); }
  catch (e) {
    const err = new Error(
      'the audit runner is not installed on this proxy: runner.js is missing. ' +
      '(' + e.message.split('\n')[0] + ')');
    err.runnerMissing = true;
    throw err;
  }
}
// Never throws: /health reports what is installed rather than failing to answer.
async function runnerHealth() {
  try { return await runner().runnerStatus(); }
  catch (e) { return { ok: false, why: e.message }; }
}

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

// Which table the audits come from and go back to. Defaulted to the live
// GrowthLine base so a deploy that forgets them still works, but overridable
// because a test run against production data is not a test.
const AIRTABLE_BASE  = env('AIRTABLE_BASE')  || 'appIDKRHUlIMSTgGK';
const AIRTABLE_TABLE = env('AIRTABLE_TABLE') || 'tblrInJH3HvhgMZDX';
// number | grade | number+grade. The four Index Score fields are text and the
// base holds both conventions; see airtable.js. Grades refuse to guess their
// own boundaries, so `grade` without AIRTABLE_GRADE_BANDS is a startup error
// rather than a confident B written over something nobody agreed.
const AIRTABLE_SCORE_FORMAT = env('AIRTABLE_SCORE_FORMAT') || 'number';
const AIRTABLE_GRADE_BANDS  = env('AIRTABLE_GRADE_BANDS');
// How often to look for new rows, and how long a pushed report link lives.
const AIRTABLE_POLL_MS  = Math.max(+env('AIRTABLE_POLL_MS') || 120000, 30000);
const AIRTABLE_POLL_ON  = env('AIRTABLE_POLL') !== 'off';
const AIRTABLE_URL_DAYS = +env('AIRTABLE_REPORT_URL_DAYS') || 3650;
const AIRTABLE_PUSH_URL = env('AIRTABLE_PUSH_URL') !== 'off';
// Whether the queue starts itself. Without this the poller turns a row into a
// queued job and then waits for somebody to press Run, which is not what "a
// row appears and the audit runs" means.
const QUEUE_AUTORUN = env('QUEUE_AUTORUN') !== 'off';

// Audit history. The SERVICE key lives here and never reaches the browser: the
// app talks to this proxy, which is already gated by AUDIT_KEY, and the proxy
// talks to Supabase. Row level security is on with no policies, so even if a
// publishable key leaked into the front end it could read nothing -- the
// service key is the only way in, and it is only ever on this side.
const SUPABASE_URL = env('SUPABASE_URL').replace(/\/+$/, '');
const SUPABASE_KEY = env('SUPABASE_SERVICE_KEY');
const HIST_BUCKET  = 'audit-reports';

app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type','Authorization','X-Audit-Key'] }));
app.options('*', cors());
// 25MB, not express's 100KB default. The default silently governed every route
// -- including /history/save, whose own 25MB parser never got a look in,
// because this one runs first and had already rejected the body. A filed audit
// carries its PDF as base64, so ~300KB of report arrives as ~400KB of JSON and
// came back 413 with an HTML error page. Nothing was ever written: the Supabase
// request log shows reads succeeding and not one write arriving.
app.use(express.json({ limit: '25mb' }));

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

// DataForSEO's "live" endpoints are not lookups against a prepared index --
// they go and scrape on demand while the request is open. my_business_info in
// particular routinely runs past half a minute, so a flat 25s cut it off every
// time and a retry hit exactly the same wall: the call was never failing, it
// was being abandoned.
//
// The timeout is therefore per-call, and a slow endpoint gets a window that
// matches how it actually behaves rather than one number for everything.
const DFS_TIMEOUT_DEFAULT = 25000;
// A host with its own hard request cap needs these shorter than the endpoint
// would like, and the suite needs them short enough to run. One knob, applied
// to every DataForSEO call, rather than each site guessing.
const DFS_TIMEOUT_SCALE = parseFloat(process.env.DFS_TIMEOUT_SCALE || '1') || 1;

async function dfsPost(path, body, opts) {
  const ms = Math.round(((opts && opts.timeout) || DFS_TIMEOUT_DEFAULT) * DFS_TIMEOUT_SCALE);
  const controller = new AbortController();
  // abort() with no reason produces a DOMException reading "This operation was
  // aborted", which tells the user nothing about what happened or what to do.
  // The reason is carried through so the catch can say what actually went on.
  const timeout = setTimeout(
    () => controller.abort(new Error('DataForSEO did not answer within ' +
      Math.round(ms / 1000) + 's (' + path + ')')), ms);
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
    if (controller.signal.aborted) {
      const why = controller.signal.reason;
      const err = new Error(
        (why && why.message ? why.message : 'DataForSEO timed out after ' + Math.round(ms / 1000) + 's') +
        ' — this endpoint scrapes on demand and is slow, so running it again ' +
        'usually hits the same limit rather than fixing it');
      err.timedOut = true;
      throw err;
    }
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
app.get('/health', async (req, res) => res.json({ ok: true, dfs: !!DFS_LOGIN,
  sem: !!(SEM_KEY_V3 || SEM_KEY_V4), semV3: !!SEM_KEY_V3, semV4: !!SEM_KEY_V4,
  sf: !!SF_KEY, ai: !!ANTHROPIC_KEY, at: !!AIRTABLE_TOKEN, google: !!GOOGLE_KEY,
  locked: !!AUDIT_KEY, model: AI_MODEL, build: BUILD,
  // Whether this proxy can build a report, and if not, which file it is
  // missing. The renderer needs assets/report-doc.js and report-assets.js,
  // which used to go to the web host only -- so this is the first place to
  // look after a deploy that updated server.js alone.
  report: rendererStatus(),
  // Whether this proxy can RUN an audit as well as render one. Separate from
  // `report` because they fail for different reasons: the renderer needs two
  // asset files, the runner needs playwright and a browser binary.
  runner: await runnerHealth(),
  history: !!(SUPABASE_URL && SUPABASE_KEY),
  // The Airtable loop: whether it is configured, whether the poller is on, and
  // what the last pass actually did. A poller that is quietly off looks exactly
  // like a poller finding nothing, so it says which.
  airtable: airtableHealth() }));

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
// What the site is built on, without being allowed to look at it.
//
// This is what Wappalyzer does, and it is worth being precise about why
// Wappalyzer succeeds where this proxy fails: it runs INSIDE the browser, on a
// page the firewall already let through. It is not defeating bot management,
// it is on the other side of it. Their server-side API would be making the
// same request this proxy makes, from the same kind of address.
//
// So take the signal from the crawl that is already allowed. Wappalyzer
// identifies technology mostly by WHICH URLS A PAGE LOADS, and Lighthouse's
// network-requests audit is exactly that list, gathered by Google. Two more
// fields in the same response have never been read: stackPacks, where
// Lighthouse names the CMS outright, and the js-libraries audit, which needs
// the best-practices category the request was not asking for.
//
// Hosts only -- no claim is made from a URL that merely mentions a name.
const TECH_SIGNS = [
  ['Analytics',     'Google Analytics',     /google-analytics\.com|\/gtag\/js/i],
  ['Analytics',     'Google Tag Manager',   /googletagmanager\.com\/gtm\.js|googletagmanager\.com\/ns\.html/i],
  ['Analytics',     'Datadog RUM',          /datadoghq|datadog-rum/i],
  ['Analytics',     'Hotjar',               /hotjar\.com/i],
  ['Analytics',     'Microsoft Clarity',    /clarity\.ms/i],
  ['Analytics',     'Matomo',               /matomo\.(?:cloud|org)/i],
  ['Analytics',     'Plausible',            /plausible\.io/i],
  ['Advertising',   'Meta Pixel',           /connect\.facebook\.net/i],
  ['Advertising',   'LinkedIn Insight',     /snap\.licdn\.com/i],
  ['Advertising',   'Microsoft Ads',        /bat\.bing\.com/i],
  ['Advertising',   'Google Ads',           /googleadservices\.com|doubleclick\.net/i],
  ['Platform',      'WordPress',            /\/wp-content\/|\/wp-includes\//i],
  ['Platform',      'Squarespace',          /squarespace\.com|sqspcdn|static1\.squarespace/i],
  ['Platform',      'Wix',                  /parastorage\.com|wixstatic\.com/i],
  ['Platform',      'Webflow',              /website-files\.com|webflow\.com/i],
  ['Platform',      'HubSpot CMS',          /hs-scripts\.com|hubspot\.com|hsforms\.net/i],
  ['Platform',      'FMG Suite',            /fmgsuite\.com|fmgcontent\.com/i],
  ['Scheduling',    'Calendly',             /calendly\.com/i],
  ['Chat',          'Intercom',             /intercom\.(?:io|com)/i],
  ['Chat',          'Drift',                /drift\.com|driftt\.com/i],
  ['Chat',          'Tawk.to',              /tawk\.to/i],
  ['Delivery',      'Cloudflare',           /cdnjs\.cloudflare\.com|cloudflareinsights\.com/i],
  ['Delivery',      'Akamai',               /akamaized\.net|akamaihd\.net/i],
  ['Delivery',      'Fastly',               /fastly\.net/i]
];

function detectTech(urls, stackPacks, jsLibs) {
  const blob = (urls || []).join(' \n ');
  const found = [];
  for (const [group, name, re] of TECH_SIGNS)
    if (re.test(blob)) found.push({ group, name, via: 'a request the page made' });
  // Lighthouse names the CMS itself, which beats guessing from asset paths.
  for (const sp of (stackPacks || []))
    if (sp && sp.title && !found.some(f => f.name === sp.title))
      found.push({ group: 'Platform', name: sp.title, via: 'identified by Lighthouse' });
  // And the libraries it recognises in the running page.
  for (const it of (jsLibs || []))
    if (it && it.name)
      found.push({ group: 'Library', name: it.name + (it.version ? ' ' + it.version : ''),
                   via: 'detected in the page' });
  return found;
}

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
      '&category=performance&category=seo&category=best-practices' +
      (GOOGLE_KEY ? '&key=' + GOOGLE_KEY : '');
    console.log('PageSpeed fetching:', psUrl.slice(0, 100));
    // Lighthouse drives a real browser against a live site, so failures here are
    // mostly transient: a slow first byte, a cold CDN, a redirect that settles
    // on the next try, Google's own capacity. One retry was not enough — this
    // check was the one most often reported as unmeasurable.
    //
    // Backoff between attempts, because an immediate retry hits whatever was
    // busy a second ago. Nothing is retried that cannot succeed: a malformed
    // URL and a rejected API key fail the same way every time, and burning
    // three minutes to confirm it helps nobody.
    const PSI_ATTEMPTS = 3;
    const PSI_BACKOFF  = [0, 5000, 12000];
    const PSI_PERMANENT = ['INVALID_URL', 'DNS_FAILURE'];
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    let d = null, gMsg = '', runtime = null, tries = 0;
    for (let attempt = 0; attempt < PSI_ATTEMPTS; attempt++) {
      if (PSI_BACKOFF[attempt]) await sleep(PSI_BACKOFF[attempt]);
      tries = attempt + 1;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);  // slow sites can take >30s for a full Lighthouse run
      try {
        const r = await fetch(psUrl, { signal: controller.signal });
        d = await r.json();
      } catch (e) {
        // A timeout or a dropped connection is exactly the transient case this
        // loop exists for, so record it and try again rather than throwing out.
        d = null;
        gMsg = e.name === 'AbortError' ? 'timed out after 60s' : e.message;
        console.log('PageSpeed attempt ' + tries + ' failed (' + gMsg + ')');
        continue;
      } finally { clearTimeout(timeout); }

      gMsg = d?.error?.message || (typeof d?.error === 'string' ? d.error : '') || d?.message || '';
      // "Lighthouse returned error: Something went wrong." is Google's generic
      // wrapper; the code underneath it is the part that says what to do.
      runtime = d?.lighthouseResult?.runtimeError || null;
      if (d?.lighthouseResult?.audits) break;

      const code = runtime?.code || '';
      if (PSI_PERMANENT.includes(code) || /API key|keyInvalid|quota/i.test(gMsg)) {
        console.log('PageSpeed failed permanently (' + (code || gMsg) + ') — not retrying');
        break;
      }
      console.log('PageSpeed attempt ' + tries + ' failed (' + (code || gMsg || 'no data') + ')');
    }

    console.log('PageSpeed response status:', d?.lighthouseResult ? 'ok' : (gMsg || 'no lighthouse result'));
    const lh     = d?.lighthouseResult || {};
    const audits = lh.audits;
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
               ' · ' + tries + (tries === 1 ? ' attempt' : ' attempts') +
               ' on the ' + strategy + ' run' });
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

    // The box says "Images under 500KB", so that is what this has to measure.
    // It was reading the uses-optimized-images / uses-responsive-images lists
    // and passing when they were EMPTY. Those audits flag images that could be
    // compressed or resized -- a saving of a few KB, nothing to do with 500KB.
    // A page with one well-compressed 2MB hero passed it; a page of thumbnails
    // each wasting 5KB failed it.
    //
    // Worse, `[] === empty` also meant an audit Lighthouse never ran scored as
    // a PASS: unmeasured silently earning the firm ten points. speedPass and
    // sizePass above were fixed for exactly this; this one was missed.
    const IMG_LIMIT_KB = 500;
    // network-requests lists every resource the page actually pulled, with its
    // real transfer size -- the only audit that can speak for ALL images.
    // Field names read defensively; one wrong guess here is a silent wrong
    // answer, not an error.
    const bytesOf = i => {
      for (const k of ['transferSize', 'resourceSize', 'totalBytes']) {
        if (typeof i[k] === 'number') return i[k];
      }
      return null;
    };
    const netAudit = audits['network-requests'];
    const netImgs  = (netAudit?.details?.items || [])
      .filter(i => /image/i.test(String(i.resourceType || i.mimeType || '')));

    let imagesOk = null, imgOver = [];
    if (netImgs.length) {
      imgOver  = netImgs.filter(i => (bytesOf(i) || 0) > IMG_LIMIT_KB * 1024);
      imagesOk = imgOver.length === 0;
    } else if (netAudit) {
      imagesOk = true;                 // the audit ran; the page loads no images
    } else if (imgItems.length) {
      // Fallback. This list holds only the images Lighthouse thinks could be
      // improved, so it can PROVE a failure and never a pass: an image outside
      // the list is simply unlisted, not known to be small.
      imgOver  = imgItems.filter(i => (bytesOf(i) || 0) > IMG_LIMIT_KB * 1024);
      imagesOk = imgOver.length ? false : null;
    }
    // else: nothing measured it, and null says so.
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
    // Analytics, from the one fetcher these sites do not refuse.
    //
    // Every source-reading route runs from this server, and to a WAF that is a
    // crawler from a cloud IP range: refused outright, or handed an
    // interstitial. Widening the patterns cannot fix being shown a different
    // page. But Lighthouse already ran on this URL from GOOGLE's addresses,
    // which these sites do allow -- the audit's own progress list shows the
    // PageSpeed step passing on the sites where every other route failed.
    //
    // network-requests is its complete enumeration of what the page loaded,
    // and a page running Google Analytics loads it from googletagmanager.com
    // or google-analytics.com. Nothing can be blocked out of that list, and it
    // catches what no source read ever could: a tag injected at runtime by a
    // tag manager, which is in nobody's HTML.
    const netUrls = (netAudit?.details?.items || [])
      .map(i => String(i.url || '')).filter(Boolean);
    const gaReq = netUrls.filter(u =>
      /googletagmanager\.com|google-analytics\.com|\/gtag\/js|\/gtm\.js|analytics\.js/i.test(u));

    // third-party-summary stays as a second opinion: it names entities rather
    // than URLs, so it can recognise a tag served from the firm's own domain
    // that the URL test would miss.
    const thirdParty = audits['third-party-summary']?.details?.items;
    const tpGA = !thirdParty ? null : thirdParty.some(i =>
      /google.tag|google.analytics|googletagmanager/i.test(i.entity || '')
    );

    // Either one is enough. Null only when NEITHER audit came back -- then
    // Lighthouse did not look, which is not the same as finding nothing.
    const hasGA = gaReq.length ? true
                : tpGA === true ? true
                : (netUrls.length || thirdParty) ? false
                : null;
    const gaFrom = gaReq.length ? 'loaded by the page: ' + gaReq[0].slice(0, 110)
                 : tpGA ? 'named in the third-party summary'
                 : null;

    res.json({
      strategy,
      attempts: tries,
      speed, sizeMB, perfScore, seoScore,
      isHttps, isMobile, isIndexable, hasMeta, robotsTxtValid,
      // The technology fingerprint, from the crawl these sites allow.
      tech: detectTech(netUrls,
                       lh.stackPacks,
                       audits['js-libraries']?.details?.items),
      speedPass, sizePass, imagesOk, imgList, hasGA, gaFrom,
      gaRequests: gaReq.slice(0, 5),
      imgLimitKb: IMG_LIMIT_KB,
      imgOverCount: imgOver.length,
      imgOver: imgOver.slice(0, 10).map(i => ({
        url:  i.url || '',
        name: (i.url || '').split('/').pop().split('?')[0] || 'unknown',
        kb:   bytesOf(i) ? Math.round(bytesOf(i) / 1024) : null,
        host: rootDomain(i.url)
      })),
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
// When a site refuses us, WHO refused matters: a CDN/WAF edge rule (Cloudflare,
// Akamai, Sucuri, Imperva) blocks by network reputation and will refuse Google
// and DataForSEO the same way, while an origin 403 is the site's own config.
// The audit cannot fix either, but naming the gatekeeper turns "we could not
// read the page" into something the firm's web vendor can actually action.
// Read from response headers only -- no extra request, no guessing.
function blockerFrom(headers) {
  if (!headers) return null;
  const h = n => { try { return headers.get(n) || ''; } catch { return ''; } };
  const server = h('server');
  // Two signals, and they are not interchangeable. Some edges announce
  // themselves in `server`; others put a distinctive header on the response
  // whose mere PRESENCE is the fingerprint -- Imperva's x-iinfo holds an
  // opaque id, so matching its value finds nothing and the block gets
  // misattributed to the origin nginx behind it.
  const byHeader = [
    ['cf-ray',       'Cloudflare'],
    ['x-sucuri-id',  'Sucuri'],
    ['x-iinfo',      'Imperva/Incapsula'],
    ['x-amz-cf-id',  'AWS CloudFront'],
    ['x-akamai-transformed', 'Akamai'],
    ['x-wpe-backend',        'WP Engine']
  ];
  for (const [hdr, name] of byHeader) if (h(hdr)) return name;

  const byServer = [
    [/cloudflare/i,        'Cloudflare'],
    [/sucuri|cloudproxy/i, 'Sucuri'],
    [/akamai/i,            'Akamai'],
    [/incapsula|imperva/i, 'Imperva/Incapsula'],
    [/cloudfront|awselb/i, 'AWS CloudFront'],
    [/fastly/i,            'Fastly'],
    [/wpengine/i,          'WP Engine'],
    [/sitelock/i,          'SiteLock']
  ];
  for (const [re, name] of byServer) if (re.test(server)) return name;
  // Not a known edge. Say what the server called itself rather than nothing.
  return server ? 'origin server (' + server.slice(0, 40) + ')' : null;
}

// Analytics, read from the page itself.
//
// This used to come only from Lighthouse's third-party-summary audit, matched
// on the entity name. That misses a site whenever PageSpeed does not run at
// all -- which on a CDN that refuses Google is every time -- and it misses a
// tag proxied through the firm's own domain, because the entity is then the
// firm, not Google.
//
// The bar here is deliberately LOW: any hint of Google tagging ticks the box.
// The check asks whether the firm is measuring its traffic, and the cost of
// the two mistakes is not symmetric. Missing a tag that is plainly in the
// markup tells a firm to install something they already have, in a document
// they hand to a client. Counting a stray dataLayer on a site with no tag
// costs a recommendation nobody was going to act on anyway. So the specific
// patterns run first, for a note that names what was found and quotes the
// measurement ID, and the loose ones catch everything else.
const GA_HINTS = [
  // Specific first: these carry an ID worth printing.
  ['Google Analytics 4',   /googletagmanager\.com\/gtag\/js\?[^"'<>]*id=(G-[A-Z0-9]+)/i],
  ['Google Tag Manager',   /['"](GTM-[A-Z0-9]{4,})['"]/i],
  // The noscript iframe carries the ID unquoted, in the URL.
  ['Google Tag Manager',   /googletagmanager\.com\/(?:gtm\.js|ns\.html)\?[^"'<>]*id=(GTM-[A-Z0-9]+)/i],
  ['Google Analytics 4',   /['"](G-[A-Z0-9]{6,})['"]/i],
  ['Universal Analytics',  /['"](UA-\d{4,}-\d+)['"]/i],
  ['Google Ads tag',       /['"](AW-\d{6,})['"]/i],
  // Then the hints with no ID attached.
  ['Google Tag Manager',   /googletagmanager\.com\/(?:gtm|ns)\.(?:js|html)()/i],
  ['Google Tag Manager',   /googletagmanager\.com()/i],
  ['Universal Analytics',  /google-analytics\.com()/i],
  ['Universal Analytics',  /\banalytics\.js\b()/i],
  ['gtag on the page',     /\bgtag\s*\(()/i],
  ['ga() tracker',         /\bga\s*\(\s*['"]create['"]()/i],
  ['legacy _gaq queue',    /\b_gaq\b()/],
  ['a dataLayer',          /\bdataLayer\b()/]
];

function readAnalytics(html) {
  const h = String(html);
  const found = [];
  for (const [label, re] of GA_HINTS) {
    const m = re.exec(h);
    if (!m) continue;
    found.push(label + (m[1] ? ' (' + m[1] + ')' : ''));
  }
  // The same tag matches several patterns -- a GA4 site hits its loader, the
  // googletagmanager.com host, gtag() and dataLayer, which would read as four
  // findings for one tag. When anything carrying a measurement ID was found,
  // that is the answer; the loose hints only speak when nothing else did.
  const named = [], loose = [];
  for (const f of found) {
    const id = (f.match(/\(([^)]+)\)/) || [])[1];
    if (!id) { if (!loose.includes(f)) loose.push(f); continue; }
    if (!named.some(u => u.includes('(' + id + ')'))) named.push(f);
  }
  const what = named.length ? named : loose;
  return { found: what.length > 0, what: what.slice(0, 3) };
}

// Every way of finding the tag, tried until one does.
//
// Reading the homepage we fetched is route one, and on a site that refuses this
// server it is the ONLY route the old code had -- so an FMG site behind a CDN
// came back with no analytics while its markup carried three GA4 properties.
// The tag is not hiding; our one way of looking at the page was.
//
// Each route is independent infrastructure, and each only ever FILLS the
// answer. None of them can turn a tag that was found into a tag that was not.
async function analyticsHunt(url, results) {
  const say = (an, via) => {
    results.ga = true;
    results.gaNote = 'found ' + via + ': ' + an.what.join(', ');
    (results.gaRoute = results.gaRoute || []).push(via + ' — found');
    return true;
  };
  const note = (via, why) => (results.gaRoute = results.gaRoute || []).push(via + ' — ' + why);

  // 2. OnPage's parsed copy of the page. DataForSEO crawls from its own
  //    network, so a CDN rule aimed at this server does not apply to it.
  if (DFS_LOGIN) {
    try {
      const r = await dfsPost('/on_page/content_parsing/live', [
        { url, enable_javascript: true, enable_browser_rendering: true }
      ], { timeout: 60000 });
      const blob = JSON.stringify(r?.tasks?.[0]?.result || '');
      const an = readAnalytics(blob);
      if (an.found) return say(an, 'by the OnPage crawler');
      note('OnPage crawler', 'no tag in its copy of the page');
    } catch (e) { note('OnPage crawler', e.message); }
  }

  // 3. The model's fetcher, which demonstrably reads sites that refuse us.
  //    The whole page this time, not just the head: a tag manager snippet can
  //    sit at the end of the body.
  try {
    const ai = await claudeFetchRaw(url, 20000);
    if (!ai.error) {
      const an = readAnalytics(ai.body || '');
      if (an.found) return say(an, 'by the model fetcher');
      note('model fetcher', 'no tag in the first 20k characters');
    } else note('model fetcher', ai.error);
  } catch (e) { note('model fetcher', e.message); }

  // 4. The page rendered. A tag injected by a script after parse is in no copy
  //    of the SOURCE, so ask what the page actually loaded.
  if (DFS_LOGIN) {
    try {
      const r = await dfsPost('/on_page/instant_pages', [
        { url, enable_javascript: true, enable_browser_rendering: true }
      ], { timeout: 60000 });
      const blob = JSON.stringify(r?.tasks?.[0]?.result || '');
      const an = readAnalytics(blob);
      if (an.found) return say(an, 'in the rendered page');
      note('rendered page', 'no tag reported');
    } catch (e) { note('rendered page', e.message); }
  }
  return false;
}

// A 200 that is not the page.
//
// This is the hole every fallback fell through. The chain -- OnPage's crawler,
// the model's fetcher, Google's index -- is triggered by `if (!pr.ok)`, and a
// Cloudflare JavaScript challenge answers HTTP 200. So the proxy believed it
// had read the homepage, found no viewport, no schema and no analytics in an
// interstitial, reported all three as measured negatives, and never asked any
// of the other routes. Three checks failing together on a page that plainly
// has all three is the signature.
//
// Detected by the markers these pages carry, and by shape: an interstitial is
// tiny and titleless, which no real advisory homepage is.
const CHALLENGE_MARKERS = [
  [/Just a moment\s*\.{0,3}/i,                       'Cloudflare "Just a moment" challenge'],
  [/cf-browser-verification|__cf_chl|cf_chl_/i,       'Cloudflare browser verification'],
  [/\/cdn-cgi\/challenge-platform/i,                  'Cloudflare challenge platform'],
  [/Checking (?:your|if the site) (?:browser|connection)/i, 'Cloudflare interstitial'],
  [/Enable JavaScript and cookies to continue/i,      'Cloudflare JavaScript gate'],
  [/Attention Required!\s*\|\s*Cloudflare/i,          'Cloudflare block page'],
  [/Access Denied[\s\S]{0,40}Sucuri|sucuri_cloudproxy/i, 'Sucuri firewall'],
  [/Incapsula incident|_Incapsula_Resource/i,         'Imperva/Incapsula challenge'],
  [/_pxhd|PerimeterX|px-captcha/i,                    'PerimeterX challenge'],
  [/DataDome|datadome\.co/i,                           'DataDome challenge'],
  [/Request unsuccessful\. Incapsula/i,                'Imperva block page'],
  [/<title>\s*(?:403|Forbidden|Access Denied)\s*<\/title>/i, 'an access-denied page'],
  [/captcha-delivery\.com|hcaptcha\.com\/captcha/i,     'a CAPTCHA wall']
];

function challengePage(html, headers) {
  const h = String(html || '');
  for (const [re, name] of CHALLENGE_MARKERS)
    if (re.test(h)) return name;
  // No known marker, but nothing a homepage has either. Kept deliberately
  // narrow -- this is a backstop for a challenge style nobody has catalogued,
  // and calling a real page a decoy would send every check down the fallback
  // routes for nothing. A page under a kilobyte with no title, no viewport,
  // no stylesheet and no JSON-LD is not an advisory firm's homepage.
  const signal = /<title[^>]*>\s*\S/i.test(h)
              || /<meta[^>]*viewport/i.test(h)
              || /<link\b/i.test(h)
              || /application\/ld\+json/i.test(h);
  if (h.length < 1024 && !signal)
    return 'a ' + h.length + '-byte response with nothing a homepage carries';
  return null;
}

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

// ── DataForSEO OnPage — a crawler that gets through ──────────────────────────
// Some sites refuse this proxy's datacenter IP outright: browser headers do not
// help because the User-Agent was never the problem. OnPage is a real crawler
// with its own infrastructure and JS rendering, so it reads pages this server
// cannot. It costs money per call, which is why it is a FALLBACK — the direct
// fetch runs first and is free, and OnPage is only asked when that is refused.
//
// The item field names are not verifiable from outside this proxy, so each
// figure is read by a list of plausible names and anything unmatched reports as
// unmeasured rather than as a finding. /site/onpage/diag prints the real keys.
function opGet(obj, names) {
  if (!obj) return undefined;
  const want = names.map(n => String(n).toLowerCase().replace(/[^a-z0-9]/g, ''));
  for (const k of Object.keys(obj)) {
    if (want.includes(String(k).toLowerCase().replace(/[^a-z0-9]/g, ''))) return obj[k];
  }
  return undefined;
}

// Raw page HTML via OnPage, for the checks that need to read the markup
// itself rather than a summary of it. Tries instant_pages with raw HTML asked
// for, then the content parser, and reports what it got rather than guessing.
async function onPageHtml(url) {
  const attempts = [
    { path: '/on_page/instant_pages',
      body: { url, enable_javascript: true, store_raw_html: true } },
    { path: '/on_page/content_parsing/live',
      body: { url, enable_javascript: true } }
  ];
  const tried = [];
  for (const a of attempts) {
    let d;
    // Also a live crawl, and with JavaScript rendering on it is not quick.
    try { d = await dfsPost(a.path, [a.body], { timeout: 60000 }); }
    catch (e) { tried.push(a.path + ' → ' + e.message); continue; }
    const task = d?.tasks?.[0];
    if (d?.status_code && d.status_code !== 20000) {
      tried.push(a.path + ' → DataForSEO ' + d.status_code + ': ' + d.status_message); continue;
    }
    if (task && task.status_code !== 20000) {
      tried.push(a.path + ' → DataForSEO ' + task.status_code + ': ' + task.status_message); continue;
    }
    const item = task?.result?.[0]?.items?.[0] || task?.result?.[0];
    const html = opGet(item || {}, ['raw_html', 'html', 'page_content', 'content']);
    if (typeof html === 'string' && /<[a-z!]/i.test(html)) return { html, via: a.path };
    tried.push(a.path + ' → no HTML in the response');
  }
  return { error: 'OnPage returned no page HTML', tried };
}

// Last resort for markup: ask Claude to fetch the page and hand back the
// JSON-LD blocks verbatim. Claude's web_fetch runs from different
// infrastructure and demonstrably reads sites that refuse both this server and
// OnPage — the visibility run cites their pages.
//
// Claude is used ONLY as a fetcher. What comes back is parsed by the same
// parser as a direct fetch, so a model that paraphrased or invented a block
// produces JSON that fails to parse, or schema that does not match the site.
// Nothing here trusts its reading of the page.
async function claudeFetchLd(url) {
  if (!ANTHROPIC_KEY) return { error: 'ANTHROPIC_KEY not set' };
  const prompt = `web_fetch ${url} and find every <script type="application/ld+json"> block in the HTML.

Return ONLY this, nothing else:
---LD---
[paste each block's contents here verbatim, one per line, exactly as written in the page]
---END---

Rules:
- Copy the JSON exactly as it appears. Do not reformat, summarise, correct or complete it.
- If there are no JSON-LD blocks, return the markers with nothing between them.
- Do not write any commentary.`;
  try {
    const out = await claudeRun({ prompt, tools: WEB_TOOLS, maxTokens: 8000 });
    if (out.error) return { error: out.error };
    const m = (out.text || '').match(/---LD---([\s\S]*?)---END---/);
    if (!m) return { error: 'the model did not return the block' };
    const body = m[1].trim();
    if (!body) return { html: '', empty: true };
    // Wrap each line back into a script tag so the existing parser reads it.
    const blocks = body.split(/\n(?=\s*[\[{])/).map(b => b.trim()).filter(Boolean);
    return { html: blocks.map(b =>
      '<script type="application/ld+json">' + b + '</script>').join('\n') };
  } catch (e) { return { error: e.message }; }
}

async function onPageFetch(url, opts) {
  const d = await dfsPost('/on_page/instant_pages', [{
    url,
    enable_javascript: (opts && opts.js) !== false,
    load_resources: false
  }], { timeout: 60000 });
  if (d && d.status_code && d.status_code !== 20000)
    return { error: 'DataForSEO ' + d.status_code + ': ' + d.status_message };
  const task = d?.tasks?.[0];
  if (task && task.status_code !== 20000)
    return { error: 'DataForSEO ' + task.status_code + ': ' + task.status_message };
  const item = task?.result?.[0]?.items?.[0];
  if (!item) return { error: 'OnPage returned no page data for ' + url };
  return { item };
}

// Turn an OnPage item into the same shape /site/check already speaks.
function onPageRead(item) {
  const meta   = opGet(item, ['meta']) || {};
  const checks = opGet(item, ['checks']) || {};
  const status = opGet(item, ['status_code', 'statusCode']);

  // Indexability, by whichever of these the response actually carries. A page
  // the crawler could not load says nothing about indexability either way.
  let indexable = null, why = '';
  const noIndex = opGet(checks, ['no_index', 'noindex', 'is_noindex']);
  const follow  = opGet(meta,   ['follow']);
  const robots  = opGet(meta,   ['robots', 'meta_robots', 'robots_directives']);
  if (typeof status === 'number' && status >= 400) {
    why = 'OnPage also could not load the page (HTTP ' + status + ')';
  } else if (typeof noIndex === 'boolean') {
    indexable = !noIndex;
    why = noIndex ? 'OnPage read a noindex directive' : 'OnPage read the page and found no noindex directive';
  } else if (typeof robots === 'string' && robots) {
    indexable = !/\bnoindex\b/i.test(robots);
    why = 'OnPage read robots: ' + robots;
  } else if (typeof follow === 'boolean') {
    // follow is about link-following rather than indexing, so it is only used
    // when nothing better is present, and the note says which signal it was.
    indexable = true;
    why = 'OnPage loaded the page (HTTP ' + status + ') and reported no indexing block';
  } else if (typeof status === 'number' && status < 400) {
    indexable = true;
    why = 'OnPage loaded the page (HTTP ' + status + ') and reported no indexing block';
  }

  const description = opGet(meta, ['description']);
  const title       = opGet(meta, ['title']);
  const noDesc      = opGet(checks, ['no_description', 'nodescription']);
  const hasMeta = typeof noDesc === 'boolean' ? !noDesc
                : typeof description === 'string' ? description.trim().length > 0
                : null;

  return {
    status: status ?? null,
    indexable, indexableNote: why,
    hasMeta,
    title: title || null,
    description: description || null,
    metaFields:  Object.keys(meta),
    checkFields: Object.keys(checks)
  };
}

// The page <head>, fetched by Claude. Same rule as the JSON-LD fetch: Claude is
// a fetcher, not a reader. What comes back is parsed by the same functions a
// direct fetch would go through, so a paraphrase yields no tags rather than a
// believed answer.
async function claudeFetchHead(url) {
  if (!ANTHROPIC_KEY) return { error: 'ANTHROPIC_KEY not set' };
  const prompt = `web_fetch ${url} and copy out the page's <head> section.

Return ONLY this, nothing else:
---HEAD---
[the raw HTML between <head> and </head>, exactly as written]
---END---

Rules:
- Copy the markup verbatim. Do not summarise, reformat, correct or add tags.
- If you cannot load the page, return the markers with nothing between them.
- No commentary.`;
  try {
    const out = await claudeRun({ prompt, tools: WEB_TOOLS, maxTokens: 8000 });
    if (out.error) return { error: out.error };
    const m = (out.text || '').match(/---HEAD---([\s\S]*?)---END---/);
    if (!m) return { error: 'the model did not return the block' };
    const head = m[1].trim();
    if (!head || !/<\s*meta|<\s*title|<\s*link/i.test(head))
      return { error: 'the model returned no markup' };
    return { html: head };
  } catch (e) { return { error: e.message }; }
}

// The route that does not need the site's permission.
//
// Everything above asks the firm's server for the page, and a CDN bot rule can
// refuse all of it -- our proxy, DataForSEO's crawler and Google's Lighthouse
// alike. A prospect is never going to allowlist a tool auditing them without
// their knowledge, so the fix cannot depend on them.
//
// So stop asking the site. Ask Google what it has ALREADY indexed. A
// `site:domain` query is answered by Google's own index, and the firm's CDN
// has no say in it.
//
// It is also better evidence. A robots meta tag states an intention; pages
// sitting in the index are the outcome. A site with pages in Google's index is
// indexable -- that is what the check is asking, and this answers it directly
// rather than by inference.
//
// The reverse does NOT hold: zero results can mean a brand-new site, a SERP
// quirk or a bad query, so it is never reported as "not indexed". Only a
// positive finding is taken from here.
async function indexedPages(domain, opts) {
  if (!DFS_LOGIN) return { error: 'DataForSEO not configured' };
  const d = await dfsPost('/serp/google/organic/live/advanced', [{
    keyword: 'site:' + domain,
    location_code: 2840,
    language_code: 'en',
    depth: 20
  }], { timeout: 45000 });
  if (d?.status_code && d.status_code !== 20000)
    return { error: 'DataForSEO ' + d.status_code + ': ' + d.status_message };
  const task = d?.tasks?.[0];
  if (task && task.status_code !== 20000)
    return { error: 'DataForSEO ' + task.status_code + ': ' + task.status_message };
  const result = task?.result?.[0];
  if (!result) return { error: 'no SERP result returned' };

  // Count only organic rows that really are on this domain: a `site:` query
  // with no matches falls back to showing something else entirely, and
  // counting those rows would report any domain as indexed.
  const root  = String(domain).replace(/^www\./, '').toLowerCase();
  const items = Array.isArray(result.items) ? result.items : [];
  const mine  = items.filter(it => {
    if (it.type !== 'organic') return false;
    const host = String(it.domain || '').replace(/^www\./, '').toLowerCase();
    return host === root || host.endsWith('.' + root);
  });
  return {
    indexedCount: typeof result.se_results_count === 'number' ? result.se_results_count : null,
    shown: mine.length,
    sample: mine.slice(0, 5).map(it => it.url).filter(Boolean),
    // The same rows, kept whole for the rich-result read. One SERP call
    // answers two questions; splitting it would bill twice for one lookup.
    rows: opts && opts.raw ? mine : undefined
  };
}

// Structured data, without reading the page.
//
// There is no API to call for this. schema.org is a vocabulary, not a service;
// Google retired the Structured Data Testing Tool API; the Rich Results Test
// and validator.schema.org have no public endpoint. So there is nothing to ask
// except Google's search results -- and those are useful, because a rich
// result is Google showing what it PARSED out of the site's markup.
//
// Breadcrumbs, review stars, FAQ dropdowns and sitelinks cannot be produced
// without structured data. Seeing one is proof the markup exists and is valid
// enough for Google to build on.
//
// Strictly one-way. Most of what a financial advisory firm marks up
// (FinancialService, LocalBusiness, Person) produces NO visible rich result,
// so an absence here means nothing at all and is never reported as missing
// schema. Only the positive is taken.
//
// Field names are read defensively across the shapes DataForSEO has used,
// because guessing one wrong is how the LLM Mentions integration reported a
// firm with 855 mentions as having none. /site/schema/diag prints the real
// keys so this can be checked against the live API rather than trusted.
const RICH_SIGNALS = [
  ['breadcrumb',      it => it.breadcrumb, 'breadcrumbs'],
  ['rating',          it => it.rating || it.reviews_count || it.rating_value, 'review stars'],
  ['faq',             it => it.faq || it.questions, 'FAQ answers'],
  ['sitelinks',       it => Array.isArray(it.links) && it.links.length, 'sitelinks'],
  ['price',           it => it.price, 'pricing'],
  ['featured',        it => it.is_featured_snippet, 'a featured snippet'],
  ['images',          it => it.images && it.images.length, 'thumbnail images']
];

async function richResults(url) {
  let domain;
  try { domain = new URL(url).hostname; } catch { domain = String(url); }
  const idx = await indexedPages(domain, { raw: true });
  if (idx.error) return { proven: false, note: 'could not read the SERP: ' + idx.error };
  const mine = idx.rows || [];
  if (!mine.length) return { proven: false, note: 'no results for this domain to read' };

  const found = new Set();
  for (const it of mine) {
    for (const [, get, label] of RICH_SIGNALS) {
      let v; try { v = get(it); } catch { v = null; }
      if (v) found.add(label);
    }
  }
  return {
    proven: found.size > 0,
    signals: [...found],
    rows: mine.length,
    // What the rows actually carried, so a signal we are not reading yet is
    // visible rather than silently missed.
    itemKeys: [...new Set(mine.flatMap(it => Object.keys(it || {})))].sort(),
    note: found.size ? null : 'Google shows no rich result for this site, which is ' +
      'not evidence either way — most advisory-firm schema produces none'
  };
}

// Claude as a plain fetcher for any URL, returning the opening bytes verbatim.
//
// The AI assistant in the app reads these sites without trouble -- it quotes
// their viewport tag and their nav markup -- which is proof its fetcher gets
// through where ours, DataForSEO's and Google's are all refused. The rest of
// the audit already leans on that for the <head>; this extends it to files.
//
// It is a FETCHER and nothing else. What comes back is matched by the same
// test a direct fetch would face, so a model that paraphrased or invented the
// content produces something that fails the test rather than a believed
// answer. No prose is ever accepted as evidence.
async function claudeFetchRaw(url, chars) {
  if (!ANTHROPIC_KEY) return { error: 'ANTHROPIC_KEY not set' };
  const n = chars || 600;
  const prompt = `web_fetch ${url} and copy out the first ${n} characters of the response body.

Return ONLY this, nothing else:
---BODY---
[the raw content, exactly as written, no reformatting]
---END---

Rules:
- Copy verbatim. Do not summarise, describe, correct or pretty-print it.
- If the URL does not load, or returns an error page, return the markers with nothing between them.
- No commentary.`;
  try {
    const out = await claudeRun({ prompt, tools: WEB_TOOLS, maxTokens: 4000 });
    if (out.error) return { error: out.error };
    const m = (out.text || '').match(/---BODY---([\s\S]*?)---END---/);
    if (!m) return { error: 'the model did not return the block' };
    const body = m[1].trim();
    if (!body) return { error: 'the model could not load it' };
    return { body };
  } catch (e) { return { error: e.message }; }
}

// The last two routes, tried in order, for a site whose server refuses every
// crawler we have. Neither needs the firm's cooperation.
//
//   1. Claude's fetcher reads the <head>. Different infrastructure, and it
//      demonstrably gets through -- the visibility run cites these pages.
//      Used ONLY as a fetcher: what comes back is parsed by the same readers
//      as a direct fetch, so a paraphrase fails to parse rather than becoming
//      a believed answer.
//   2. Google's index, via a site: query. This asks Google, not the firm, so
//      no CDN rule can block it.
//
// Both only fill nulls. A value the direct fetch established is never
// overwritten -- measured must not lose to a second-hand reading.
async function lastResortRead(url, results, why) {
  const domain = (() => { try { return new URL(url).hostname; } catch { return String(url); } })();

  const ai = await claudeFetchHead(url);
  if (!ai.error) {
    const metas = readRobotsMeta(ai.html);
    const blockers = metas.filter(m => /\bnoindex\b/i.test(m.content));
    if (results.indexable == null) {
      results.indexable     = blockers.length === 0;
      results.indexableNote = why + ' — the head was fetched by the model: ' +
        (blockers.length ? 'it declares ' + blockers.map(b => b.name + ': ' + b.content).join(', ')
                         : metas.length ? 'it declares ' + metas.map(m => m.name + ': ' + m.content).join(', ')
                                        : 'no robots directive found, which means indexable');
    }
    // Positive only. A head the model fetched may stop short of the tag, so
    // its absence there proves nothing -- the same rule the viewport follows.
    const an = readAnalytics(ai.html);
    if (an.found && results.ga == null) {
      results.ga = true;
      results.gaNote = 'found in the model-fetched head: ' + an.what.join(', ');
    }
    const vp = readViewport(ai.html);
    if (vp && results.viewport == null) {
      results.viewport = vp.ok;
      results.viewportNote = 'read from the model-fetched head: ' + vp.content;
    }
    const desc = /<meta\b[^>]*name\s*=\s*["']?description["']?[^>]*content\s*=\s*["']([^"']*)["']/i.exec(ai.html);
    if (desc && results.hasMeta == null) {
      results.hasMeta = desc[1].trim().length > 0;
      results.hasMetaNote = 'read from the model-fetched head';
    }
    results.readVia = 'claude-fetch';
  } else {
    results.modelFetch = 'failed: ' + ai.error;
  }

  // Google's index settles indexability on its own, and outranks a robots tag:
  // pages in the index are the outcome the tag only predicts. So it is allowed
  // to CORRECT a negative read from the head -- a site declaring noindex whose
  // pages Google is serving anyway is indexed, whatever the tag says.
  const idx = await indexedPages(domain);
  if (idx.error) { results.googleIndex = 'failed: ' + idx.error; return; }
  results.indexedShown = idx.shown;
  results.indexedCount = idx.indexedCount;
  results.indexedSample = idx.sample;
  if (idx.shown > 0) {
    const n = idx.indexedCount && idx.indexedCount >= idx.shown ? idx.indexedCount : idx.shown;
    results.indexable = true;
    results.indexableNote = why + ' — but Google has ' + n.toLocaleString() +
      ' page' + (n === 1 ? '' : 's') + ' of this site in its index, which is indexability proven ' +
      'rather than inferred';
    results.readVia = (results.readVia ? results.readVia + '+' : '') + 'google-index';
  } else if (results.indexable == null) {
    // Zero rows is not evidence of absence: a new site, a SERP quirk or a
    // query that did not resolve all look identical from here.
    results.googleIndex = 'no site: results — not treated as a finding';
  }
}

// Ask OnPage for what the direct fetch could not read, and record that it was
// OnPage that answered. Never overwrites a value the direct fetch established:
// it only fills nulls.
async function onPageRescue(url, results, whyDirectFailed) {
  if (!DFS_LOGIN) { results.onPage = 'not configured'; return; }
  const r = await onPageFetch(url, { js: true });
  // OnPage failing is not the end of the chain. It used to return here, so an
  // out-of-credits or timed-out OnPage call silently skipped both remaining
  // routes and the checks stayed unmeasured for a reason that had nothing to
  // do with the site.
  if (r.error) {
    results.onPage = 'failed: ' + r.error;
    await lastResortRead(url, results, whyDirectFailed + ' — OnPage failed: ' + r.error);
    return;
  }

  const op = onPageRead(r.item);
  results.onPage = 'used';
  results.onPageStatus = op.status;

  // OnPage reached the host but was refused the page as well. Claude's fetcher
  // is the one that still gets through — it is reading these sites during the
  // visibility run — so parse its <head> with the same readers.
  if (op.indexable == null && typeof op.status === 'number' && op.status >= 400) {
    await lastResortRead(url, results,
      whyDirectFailed + ' — OnPage was blocked too (HTTP ' + op.status + ')');
    return;
  }
  if (results.indexable == null && op.indexable != null) {
    results.indexable = op.indexable;
    results.indexableNote = whyDirectFailed + ' — ' + op.indexableNote;
  }
  if (results.hasMeta == null && op.hasMeta != null) {
    results.hasMeta = op.hasMeta;
    results.hasMetaNote = 'read by OnPage';
  }
  if (op.title) results.title = op.title;
  if (op.description) results.description = op.description;

  // OnPage answers indexability and the meta description, but its response
  // carries no viewport field at all. So on a site that refuses a direct fetch,
  // a SUCCESSFUL OnPage call used to fill those two and return -- leaving
  // "Mobile optimized" unmeasured for a site whose homepage plainly declares a
  // viewport. The reader never got the chance to look.
  //
  // The mobile declaration is one meta tag in the head, and the model's fetcher
  // reads that head. So anything still unanswered goes on to it instead of
  // stopping here. It only fills nulls, so nothing OnPage established is lost,
  // and it is skipped entirely when there is nothing left to ask.
  const missing = ['viewport', 'indexable', 'hasMeta', 'ga'].filter(k => results[k] == null);
  if (missing.length) {
    // The reason handed on is why the DIRECT read failed, not which fields are
    // outstanding: lastResortRead writes it into whichever note it fills, and
    // an indexability note explaining that OnPage had no viewport field reads
    // as a non-sequitur to whoever is trying to understand the box.
    console.log('OnPage did not report ' + missing.join(', ') + ' — asking the model');
    await lastResortRead(url, results, whyDirectFailed);
  }
}

app.get('/site/onpage', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });
  if (!DFS_LOGIN) return res.status(500).json({ error: 'DataForSEO not configured — OnPage needs it' });
  const r = await onPageFetch(url, { js: req.query.js !== '0' });
  if (r.error) return res.status(502).json({ error: r.error });
  res.json(Object.assign({ source: 'onpage' }, onPageRead(r.item)));
});

// Prints what OnPage actually returns, so the readers above can be pinned to
// the real field names rather than a plausible list.
app.get('/site/onpage/diag', async (req, res) => {
  if (!DFS_LOGIN) return res.json({ error: 'DataForSEO not configured' });
  const url = req.query.url || 'https://totuswm.com';
  const r = await onPageFetch(url, { js: true });
  if (r.error) return res.json({ url, error: r.error });
  const item = r.item;
  res.json({
    url,
    itemKeys: Object.keys(item),
    metaKeys: Object.keys(opGet(item, ['meta']) || {}),
    checkKeys: Object.keys(opGet(item, ['checks']) || {}),
    read: onPageRead(item),
    // A string, not a re-parsed slice: truncating JSON and parsing it back
    // throws far more often than it works.
    sample: JSON.stringify(item).slice(0, 2000)
  });
});

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

// What counts as a sitemap, and why a status code is not enough.
//
// "Just ping /sitemap.xml and look for a 404" fails on the most common case in
// this market: a site with no sitemap that answers /sitemap.xml with its styled
// 404 page and HTTP 200. Status alone would pass every one of those. So the
// body is sniffed -- but the sniff had gaps of its own:
//
//   * a prefixed root element (<sm:urlset) failed a bare '<urlset' match
//   * a .gz sitemap arrives as gzip BYTES, not a gzip-encoded response, so
//     fetch hands back binary and the text match never had a chance
//   * sitemaps.org also allows a plain-text file of one URL per line
const SITEMAP_RE = /<\s*([a-z0-9_.-]+:)?(urlset|sitemapindex)\b/i;

function sitemapBody(buf) {
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try { return zlib.gunzipSync(buf).toString('utf8'); } catch { return ''; }
  }
  return buf.toString('utf8');
}

// The plain-text form, validated strictly: every line a URL and nothing else,
// so an ordinary text file cannot pass for one.
function isSitemapTxt(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(0, 50);
  return lines.length > 0 && lines.every(l => /^https?:\/\/\S+$/i.test(l));
}

    const declared = [...robotsBody.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)].map(m => m[1].trim());
    const candidates = [
      ...declared,
      base + '/sitemap.xml',
      base + '/sitemap_index.xml',     // Yoast, and most WordPress SEO plugins
      base + '/wp-sitemap.xml',        // WordPress 5.5+ core
      base + '/sitemap-index.xml',
      base + '/sitemap1.xml',
      base + '/sitemap.xml.gz',        // served as gzip bytes, not gzip encoding
      base + '/sitemap.txt'            // the plain-text form the spec allows
    ].filter((v, i, a) => a.indexOf(v) === i);
    results.sitemapDeclared = declared;

    // Probed together rather than one after another. Sequentially, a site with
    // no sitemap and a slow 404 spent up to ten seconds per candidate before
    // answering, and adding candidates made that worse; concurrently the whole
    // probe costs one round trip and the list can grow freely. Priority order
    // is preserved by picking from `candidates`, not by arrival.
    const probes = await Promise.all(candidates.map(async cand => {
      try {
        const sr = await fetch(cand, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(10000) });
        if (!sr.ok) return { cand, note: cand + ' → HTTP ' + sr.status };
        const ct   = (sr.headers.get('content-type') || '').split(';')[0].trim();
        const body = sitemapBody(Buffer.from(await sr.arrayBuffer()));
        const ok   = SITEMAP_RE.test(body.slice(0, 20000)) ||
                     (/\.txt$/i.test(cand) && isSitemapTxt(body));
        if (ok) return { cand, ok: true, status: sr.status };
        // Say WHAT came back. "200 but not a sitemap" gave no way to tell a
        // soft 404 from a sitemap this code failed to recognise.
        return { cand, note: cand + ' → 200 ' + (ct || 'no content-type') + ', not a sitemap: "' +
                 body.replace(/\s+/g, ' ').trim().slice(0, 60) + '"' };
      } catch (e) {
        return { cand, note: cand + ' → ' + e.message };
      }
    }));
    const hit = probes.find(p => p.ok);
    results.sitemap = !!hit;
    results.sitemapTried = probes.filter(p => !p.ok).map(p => p.note);
    if (hit) {
      results.sitemapUrl    = hit.cand;
      results.sitemapStatus = hit.status;
      results.sitemapNote   = declared.includes(hit.cand)
        ? 'declared in robots.txt' : 'found at ' + hit.cand.replace(base, '');
    }
    if (!results.sitemap) {
      // Every candidate refused with the same status? That is the WAF blocking
      // this server, not a firm without a sitemap — and calling it "none found"
      // costs them a check they deserve. OnPage crawls from its own
      // infrastructure, so ask it about the likeliest location.
      const allBlocked = results.sitemapTried.length > 0 &&
        results.sitemapTried.every(t => /→ HTTP (40[13]|429|5\d\d)/.test(t));
      if (allBlocked) {
        const probe = declared[0] || base + '/sitemap.xml';
        // Without DataForSEO there is no OnPage step, but a blocked site is
        // still blocked -- falling through to "none found" would report a
        // refusal as a missing sitemap, which is the error this whole branch
        // exists to prevent.
        const r  = DFS_LOGIN ? await onPageFetch(probe, { js: false })
                             : { error: 'OnPage not configured' };
        const st = r.item ? opGet(r.item, ['status_code', 'statusCode']) : null;
        if (typeof st === 'number' && st < 400) {
          results.sitemap       = true;
          results.sitemapUrl    = probe;
          results.sitemapStatus = st;
          results.sitemapNote   = 'this server was blocked, but OnPage loaded it (HTTP ' + st + ')';
          results.onPageSitemap = 'used';
        } else {
          // OnPage was refused too. One fetcher left that demonstrably is not.
          const ai = await claudeFetchRaw(probe, 600);
          if (!ai.error && SITEMAP_RE.test(ai.body)) {
            // The same test a direct fetch would face: prose describing a
            // sitemap fails it, so only real markup can pass.
            results.sitemap     = true;
            results.sitemapUrl  = probe;
            results.sitemapNote = 'this server and OnPage were both blocked; ' +
              'the file was fetched by the model and is a real sitemap';
            results.sitemapVia  = 'claude-fetch';
          } else {
            results.sitemapUrl  = probe;
            results.sitemapNote = 'every location refused this server' +
              (r.error ? ', and OnPage could not check either: ' + r.error
                       : ' and OnPage got HTTP ' + st) +
              (ai.error ? ', and the model fetch failed: ' + ai.error
                        : ', and what the model fetched was not sitemap markup');
            results.sitemapBlocked = true;
          }
        }
      } else {
        results.sitemapUrl  = base + '/sitemap.xml';
        results.sitemapNote = 'none found — tried ' + candidates.length + ' locations' +
                              (declared.length ? ', including the one robots.txt declares' : '');
      }
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
      // Read the body before deciding, because a challenge answers 200 and the
      // only way to tell it from the homepage is to look at it.
      const body200 = pr.ok ? (await pr.text()).slice(0, 5000000) : null;
      const decoy   = pr.ok ? challengePage(body200, pr.headers) : null;
      if (decoy) {
        results.homeBytes    = body200.length;
        results.homeChallenge = decoy;
      }
      if (!pr.ok || decoy) {
        const who = blockerFrom(pr.headers);
        const why = decoy
          ? 'the homepage answered HTTP ' + pr.status + ' with ' + decoy +
            (who ? ' (' + who + ')' : '') + ' — not the page itself'
          : 'homepage returned HTTP ' + pr.status + (who ? ' from ' + who : '');
        results.homeBlockedBy = who;
        results.indexable = null;
        results.indexableNote = why;
        results.viewport = null;
        results.viewportNote = why;
        results.ga = null;
        results.gaNote = why;
        // A refusal is exactly what OnPage is for. It is only asked here, on
        // the failure path, because it is billed per call and the plain fetch
        // costs nothing.
        await onPageRescue(url, results, why);
      } else {
        const xRobots = (pr.headers.get('x-robots-tag') || '').trim();
        // Already read above, to tell a challenge from the real page.
        // The WHOLE page, not the first 300KB of it. That cap is why
        // archstonefinancial.net came back with no analytics: its gtag.js sits
        // at the end of a <head> padded with inline Datadog RUM, past the cut.
        // The tag was in the page and in the reader's patterns; the page was
        // simply handed over with the end missing. Capped far higher only to
        // bound a pathological response.
        const full    = body200;
        const html    = full;
        results.homeBytes = full.length;
        const metas   = readRobotsMeta(html);
        const blockers = [];
        if (/\bnoindex\b/i.test(xRobots)) blockers.push('X-Robots-Tag: ' + xRobots);
        for (const m of metas) {
          if (/\bnoindex\b/i.test(m.content)) blockers.push('<meta name="' + m.name + '" content="' + m.content + '">');
        }
        // The whole homepage was read, so an absent tag here is meaningful --
        // but not final. A tag injected after parse is in no copy of the
        // source, so the other routes still get their turn below.
        const an = readAnalytics(html);
        // The whole page was read. A hint anywhere in it ticks the box; none
        // in 300KB of markup is a finding, and PageSpeed -- which runs anyway
        // and sees what loaded at runtime -- can still overturn it for free.
        // The hunt below is for pages we could NOT read, which is where the
        // gap actually was; running it here would bill a model call and two
        // crawls on every clean site to confirm what the page already said.
        results.ga     = an.found;
        results.gaNote = an.found ? 'found on the homepage: ' + an.what.join(', ')
                                  : 'no analytics tag in the homepage markup';
        // Size on the record: a tag missed because the page was cut short is
        // indistinguishable from a page with no tag unless this is visible.
        results.gaRoute = ['homepage markup, ' + Math.round(full.length / 1024) +
                           'KB — ' + (an.found ? 'found' : 'nothing')];

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
      results.ga = null;
      results.gaNote = 'could not fetch the homepage: ' + e.message;
      await onPageRescue(url, results, 'could not fetch the homepage: ' + e.message);
    }

    // Still no answer on analytics? Try every other way of looking at the page.
    // Only when it is unresolved: a tag already found costs nothing more, and a
    // homepage that was read and plainly had none is settled after the hunt.
    if (results.ga == null) {
      const hit = await analyticsHunt(url, results);
      if (!hit) {
        // Every route looked and none found a tag. That is a finding now, not
        // a shrug -- unless the page itself was never readable, in which case
        // there was nothing to look at and the box stays unmeasured.
        // A challenge answers 200, so the status alone does not mean the page
        // was seen -- which would turn "nobody could read it" back into the
        // finding this whole change exists to prevent.
        const sawThePage = results.homeStatus >= 200 && results.homeStatus < 400
                           && !results.homeChallenge;
        results.ga = sawThePage ? false : null;
        results.gaNote = sawThePage
          ? 'no analytics tag found by any route'
          : (results.gaNote || 'could not read the homepage');
      }
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

// Prints what Google's SERP actually carries for a domain, so the rich-result
// field names above can be confirmed rather than assumed. The LLM Mentions
// integration spent a week reporting zeros because it read the wrong key; this
// is the cheap way to not repeat that.
app.get('/site/schema/diag', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });
  const r = await richResults(url);
  res.json({
    url,
    provenByGoogle: r.proven || false,
    signalsFound: r.signals || [],
    rowsRead: r.rows || 0,
    note: r.note || null,
    // Every key present on the organic rows. A signal we are not reading yet
    // shows up here.
    itemKeys: r.itemKeys || [],
    reading: RICH_SIGNALS.map(x => x[0])
  });
});

// Reading the markup is now separate from fetching it, because the same page
// may have to be read twice: once as served, and again after JavaScript has
// run. Advisory-firm sites overwhelmingly inject their schema from a plugin or
// a tag manager, so the served HTML is frequently bare while the rendered page
// carries a full FinancialService + PostalAddress block.
function readSchemaFrom(html) {
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

  return {
    // readVia is the CALLER's business: this function is handed markup and does
    // not know which of the four routes produced it.
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
  };
}

// How much of what this check is FOR a given read actually found. Used only to
// pick between two reads of the same page -- the richer one wins, so a JS
// render can add what the served HTML lacked but never take anything away.
function schemaDepth(p) {
  if (!p) return -1;
  return (p.hasBusinessType ? 8 : 0) + (p.isFinancialService ? 4 : 0) +
         (p.hasAddress ? 4 : 0) + (p.hasGeo ? 1 : 0) + (p.hasPhone ? 1 : 0) +
         (p.hasHours ? 1 : 0) + (p.types ? p.types.length : 0);
}

app.get('/site/schema', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    // A CDN does not always answer with a status. It can reset the connection
    // or hang until the timeout, and a throw here used to skip every fallback
    // and return a 500 -- the same blocked site reported two completely
    // different ways depending on how the block was delivered.
    let r = null, fetchErr = null;
    try {
      r = await fetch(url, {
        headers: BROWSER_HEADERS,
        redirect: 'follow',
        signal: AbortSignal.timeout(15000)
      });
    } catch (e) {
      fetchErr = e.name === 'TimeoutError' ? 'timed out fetching the page' : e.message;
    }
    let html, via = 'direct';
    if (!r || !r.ok) {
      const whyDirect = r ? 'page returned HTTP ' + r.status : 'could not reach the page (' + fetchErr + ')';
      // A blocked page is not a page without markup. Reporting "no structured
      // data found" for a 403 is a finding the audit did not measure, and it
      // costs the firm a check they may well pass.
      const op = await onPageHtml(url);
      if (!op.error) { html = op.html; via = 'onpage'; }
      else {
        // Claude's fetcher gets through where both of the others are refused.
        const ai = await claudeFetchLd(url);
        if (ai.error) {
          // Everything that reads the page has been refused. One route left,
          // and it does not read the page: ask Google what it already
          // extracted from this site's markup.
          const rich = await richResults(url);
          return res.json({ found: false, blocked: true, readVia: rich.proven ? 'google-serp' : 'none',
            googleParsed: rich.proven || false,
            richSignals: rich.signals || [],
            richNote: rich.note || null,
            note: whyDirect + ', OnPage could not read it' +
                  (op.tried ? ' (' + op.tried.join('; ') + ')' : '') +
                  ', and the model fetch failed: ' + ai.error +
                  (rich.proven ? ' — but Google is showing ' + rich.signals.join(', ') +
                                 ' for this site, which it can only build from structured data'
                               : '') });
        }
        html = ai.html; via = 'claude-fetch';
      }
    } else {
      html = await r.text();
    }

    let parsed = readSchemaFrom(html);

    // The two checks this page is FOR are a business type and a location. If
    // the served HTML did not yield both, read the page again with JavaScript
    // run before concluding they are absent.
    //
    // This is where the audit was losing real schema. The fallback chain above
    // only fires when the FETCH fails, so a site that returns a perfectly good
    // 200 and injects its FinancialService + PostalAddress block from a plugin
    // or tag manager was parsed bare and reported "No structured data found" --
    // a hard failure on an 8-point check, for a firm that has the markup.
    //
    // Only on a short read, never on every audit: OnPage is billed per call,
    // and a page that already declared both has nothing to gain from a second.
    let rendered = null;
    if (via === 'direct' && !(parsed.hasBusinessType && parsed.hasAddress)) {
      const op = await onPageHtml(url);
      if (!op.error) {
        rendered = readSchemaFrom(op.html);
        // Richer wins. A JS render can only ADD what the served HTML lacked --
        // if it somehow reads thinner, the first reading stands.
        if (schemaDepth(rendered) > schemaDepth(parsed)) {
          parsed = rendered;
          via = 'onpage-js';
        }
      }
    }

    res.json(Object.assign({
      readVia: via,
      // Says plainly that a second, JS-rendered read happened and what it
      // changed, so "found after rendering" is never mistaken for the served
      // HTML having carried it.
      renderedRead: rendered ? (via === 'onpage-js' ? 'added markup the served HTML did not have'
                                                    : 'no better than the served HTML')
                             : null
    }, parsed));
  } catch (e) {
    const msg = e.name === 'TimeoutError' ? 'timed out fetching the page' : e.message;
    console.error('schema error:', msg);
    res.status(500).json({ error: msg });
  }
});

// ── Audit history ─────────────────────────────────────────────────────────────
//
// Two things are kept per audit, because they answer different questions:
//
//   state   the ~14KB needed to REBUILD the audit -- reopen it, fix a box,
//           re-run a step, regenerate the report.
//   pdf     the ~300KB file the client actually received. A regenerated report
//           is built by whatever the code does today, which is not necessarily
//           what was sent in March. In a compliance-adjacent context "what did
//           we tell them" has one right answer, and only the stored file is it.
//
// Everything here goes through this proxy. The browser never holds a Supabase
// key of any kind.

// A client is identified by DOMAIN, never by the name typed into the form --
// "Totus wealth Managment" and "Totus Wealth Management" are the same firm and
// must not become two histories.
function auditDomain(url, fallback) {
  let v = String(url || fallback || '').trim().toLowerCase();
  if (!v) return '';
  v = v.replace(/^https?:\/\//, '').replace(/^www\./, '');
  return v.split(/[\/?#]/)[0];
}

// How the key is sent. This was wrong, and it is worth saying exactly how so it
// does not get "fixed" back.
//
// The code used to send the key on the apikey header ALONE for the new
// sb_secret_ format, on the strength of a docs line saying a secret key cannot
// go in Authorization: Bearer. Checked against the reference implementation,
// that is backwards. supabase-js builds its headers like this:
//
//   const allowKeyAsBearer = !omitApiKeyAsBearer && isNewApiKey(supabaseKey)
//   if (!headers.has('apikey'))        headers.set('apikey', supabaseKey)
//   if (!headers.has('Authorization')) {
//     const bearer = realToken ?? (allowKeyAsBearer ? supabaseKey : null)
//     if (bearer) headers.set('Authorization', `Bearer ${bearer}`)
//   }
//
// -- it sends Bearer SPECIFICALLY for a new-format key, and for a legacy JWT
// _getAccessToken falls back to the key itself, so both formats get both
// headers. Storage in particular authenticates on Authorization, which is why
// sending apikey alone filed nothing and uploaded nothing.
//
// So: both headers, as the official client does. And because this has now been
// wrong in each direction, a 401 or 403 is retried once with apikey alone
// rather than taken as final -- whichever combination the platform wants, the
// proxy finds it, and says which one worked.
let SB_AUTH_MODE = null;        // 'both' | 'apikey' once something has answered

function sbHeaders(withBearer) {
  const h = { apikey: SUPABASE_KEY };
  if (withBearer) h.Authorization = 'Bearer ' + SUPABASE_KEY;
  return h;
}

async function sbFetch(path, opts) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    const e = new Error('History is not configured on the proxy — set SUPABASE_URL and SUPABASE_SERVICE_KEY');
    e.unconfigured = true; throw e;
  }
  const o = opts || {};
  // The remembered mode ORDERS the attempts, it does not remove one. Latching
  // it as the only option meant a later refusal could not recover -- and the
  // two stores do not have to agree, so one answering does not settle it for
  // the other. The first attempt is almost always the right one, so the second
  // costs nothing in the ordinary case.
  const first = SB_AUTH_MODE !== 'apikey';
  let last = null;
  for (const withBearer of [first, !first]) {
    const r = await fetch(SUPABASE_URL + path, {
      method: o.method || 'GET',
      headers: Object.assign(sbHeaders(withBearer), o.headers || {}),
      body: o.body,
      signal: AbortSignal.timeout(o.timeout || 20000)
    });
    if (r.ok) {
      const mode = withBearer ? 'both' : 'apikey';
      if (SB_AUTH_MODE !== mode) {
        SB_AUTH_MODE = mode;
        console.log('Supabase auth mode:', mode);
      }
      return r;
    }
    const t = await r.text().catch(() => '');
    last = new Error('Supabase ' + r.status + ': ' + t.slice(0, 300));
    last.status = r.status;
    // Only an auth refusal is worth trying the other way. A 404, a constraint
    // violation or a payload that is too large will fail identically.
    if (r.status !== 401 && r.status !== 403) throw last;
    console.log('Supabase ' + r.status + ' with ' +
                (withBearer ? 'apikey+bearer' : 'apikey only') + ' — trying the other');
  }
  throw last;
}

// The caller's options first, then the merged headers LAST.
//
// These two were the other way round, so Object.assign copied opts.headers
// straight over the object that had just had Content-Type merged into it. The
// only call site that passes headers of its own is the audits insert, which
// sends Prefer: return=representation -- so that one request went out with
// Prefer and no Content-Type, and PostgREST rejected a body it could not type
// with a 400 before Postgres ever saw it. The PDF uploaded, the row did not,
// and History read an empty table while the bucket filled up.
//
// Everything else kept working and hid it: GETs have no body, and the storage
// sign call passes no headers, so its merged Content-Type survived.
// An empty body is not a failure.
//
// PostgREST answers `Prefer: return=minimal` with 204 and no body at all, and
// .json() on that throws "Unexpected end of JSON input". The queue's own
// bookkeeping uses return=minimal, so a finished audit -- seven minutes of
// real work, filed, scored 92 -- was marked failed because the row that
// recorded its success came back empty. The write had already succeeded; only
// the parse failed.
const sbJson = async (path, opts) => {
  const r = await sbFetch(path, Object.assign({}, opts, {
    headers: Object.assign({ 'Content-Type': 'application/json' }, (opts || {}).headers || {})
  }));
  if (r.status === 204) return null;
  const text = await r.text();
  if (!text.trim()) return null;
  try { return JSON.parse(text); }
  catch (e) {
    // Named, because "Unexpected end of JSON input" says nothing about which
    // call produced it or what came back instead.
    throw new Error('Supabase sent a reply that is not JSON for ' +
      path.split('?')[0] + ' (HTTP ' + r.status + '): ' + text.slice(0, 120));
  }
};

// Where an audit can come from. Mirrors the database's check constraint; kept
// here as well so a bad value is refused with a list of the good ones rather
// than as a Postgres error the app has to parse.
const SOURCES = ['internal', 'public', 'airtable'];

// Save one audit. The PDF arrives base64 in the same request so a save is
// atomic from the app's point of view: it cannot end up with a row whose file
// never uploaded, because the row is written last.
app.post('/history/save', async (req, res) => {
  const b = req.body || {};
  const domain = auditDomain(b.clientUrl, b.clientDomain);
  if (!domain) return res.status(400).json({ error: 'a client URL is required to file an audit' });
  if (!b.state)  return res.status(400).json({ error: 'no audit state supplied' });
  if (b.source && !SOURCES.includes(b.source))
    return res.status(400).json({ error: 'unknown source "' + b.source +
      '" — an audit comes from: ' + SOURCES.join(', ') });
  if (b.template && !templateNames().includes(b.template))
    return res.status(400).json({ error: 'unknown report template "' + b.template +
      '" — this proxy builds: ' + templateNames().join(', ') });

  try {
    let pdfPath = null, pdfBytes = null;
    if (b.pdfBase64) {
      const buf = Buffer.from(b.pdfBase64, 'base64');
      // Foldered by domain so a firm's reports sit together in the bucket, and
      // stamped so two runs on the same day do not overwrite each other.
      pdfPath = domain + '/' + new Date().toISOString().replace(/[:.]/g, '-') + '.pdf';
      await sbFetch('/storage/v1/object/' + HIST_BUCKET + '/' + encodeURI(pdfPath), {
        method: 'POST',
        headers: { 'Content-Type': 'application/pdf', 'x-upsert': 'true' },
        body: buf, timeout: 60000
      });
      pdfBytes = buf.length;
    }

    const row = {
      client_domain: domain,
      client_name:   String(b.clientName || '').slice(0, 300),
      client_url:    String(b.clientUrl  || '').slice(0, 600),
      client_city:   String(b.clientCity || '').slice(0, 300),
      score_overall: b.scores ? b.scores.overall : null,
      score_v:       b.scores ? b.scores.v : null,
      score_w:       b.scores ? b.scores.w : null,
      score_s:       b.scores ? b.scores.s : null,
      kpis_passed:   b.kpisPassed ?? null,
      kpis_total:    b.kpisTotal ?? null,
      state:         b.state,
      pdf_path:      pdfPath,
      pdf_bytes:     pdfBytes,
      prepared_by:   String(b.preparedBy || '').slice(0, 200),
      build:         String(b.build || '').slice(0, 40),
      // Where it came from and what it renders. Rejected here rather than by
      // the database's own check constraint, so a bad value says which ones
      // are allowed instead of surfacing as a Postgres 400.
      source:        b.source   || 'internal',
      template:      b.template || 'growthline',
      // The assembled report data. Without it a filed audit can be reopened
      // but its PDF can never be rebuilt -- only the stored file would exist.
      report:        b.report || null,
      note:          String(b.note || '').slice(0, 1000)
    };
    const saved = await sbJson('/rest/v1/audits', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(row)
    });
    const id = saved[0] && saved[0].id;

    // ── A reviewed audit replaces the run it came from ───────────────────────
    // A save INSERTS; it never updates. So when a reviewer opens a queued job,
    // fills what the headless run could not reach, corrects what it got wrong
    // and saves, the result is a NEW row -- and the job still points at the
    // run's original one. Approving then pushed the robot's numbers to
    // Airtable with no report link, discarding the review entirely.
    //
    // Re-pointing the job here keeps that in one place: whatever the reviewer
    // last saved is what the job means, and therefore what gets pushed.
    let rePointed = null;
    if (b.jobId && id) {
      try {
        await sbJson('/rest/v1/audit_jobs?id=eq.' + encodeURIComponent(b.jobId), {
          method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ audit_id: id }) });
        rePointed = b.jobId;
      } catch (e) {
        // Reported, not thrown. The audit is filed either way, and losing the
        // save because the bookkeeping failed would be the worse trade.
        console.error('history save: could not re-point job ' + b.jobId +
                      ' at audit ' + id + ' — ' + e.message);
      }
    }
    res.json({ ok: true, id, domain, pdfPath, pdfBytes, rePointed });
  } catch (e) {
    console.error('history save error:', e.message);
    res.status(e.unconfigured ? 501 : 502).json({ error: e.message });
  }
});

// The history list. Deliberately does NOT select `state`: 200 audits of 14KB
// each is 3MB to render a list of names.
// Why history is not working, answered from the proxy rather than guessed at
// from the browser. It reports the two things that can be wrong without saying
// so out loud -- the env vars are missing, or the key is refused -- and tries
// BOTH stores, because a save writes to storage first and the table second, so
// a storage refusal leaves the table empty and looks like nothing ran.
app.get('/history/diag', async (req, res) => {
  const out = {
    urlSet: !!SUPABASE_URL,
    keySet: !!SUPABASE_KEY,
    // Enough to tell which key was pasted, never enough to use it.
    keyKind: !SUPABASE_KEY ? 'none'
           : /^eyJ/.test(SUPABASE_KEY) ? 'legacy JWT'
           : /^sb_secret_/.test(SUPABASE_KEY) ? 'new secret (sb_secret_)'
           : /^sb_publishable_/.test(SUPABASE_KEY) ? 'PUBLISHABLE — this is the wrong key, it cannot write'
           : 'unrecognised format',
    keyTail: SUPABASE_KEY ? '…' + SUPABASE_KEY.slice(-4) : null,
    bucket: HIST_BUCKET,
    authMode: SB_AUTH_MODE
  };
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    out.ok = false;
    out.problem = 'The proxy has no Supabase credentials. Set SUPABASE_URL and ' +
                  'SUPABASE_SERVICE_KEY in the Render environment and redeploy.';
    return res.json(out);
  }
  // The table: can we read it, and how many rows are already filed?
  try {
    const r = await sbFetch('/rest/v1/audits?select=id&limit=1', { headers: { Prefer: 'count=exact' } });
    out.table = 'ok';
    const range = r.headers.get('content-range') || '';
    out.rows = range.includes('/') ? range.split('/').pop() : null;
  } catch (e) { out.table = 'FAILED: ' + e.message; }
  // Storage: a save uploads the PDF before it inserts the row, so this is the
  // half that fails first and the half that leaves no trace when it does.
  try {
    await sbFetch('/storage/v1/object/list/' + HIST_BUCKET, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix: '', limit: 1 })
    });
    out.storage = 'ok';
  } catch (e) { out.storage = 'FAILED: ' + e.message; }

  out.authMode = SB_AUTH_MODE;
  out.ok = out.table === 'ok' && out.storage === 'ok';
  if (!out.ok) out.problem = 'Supabase refused the proxy. Check the key is the ' +
    'SECRET (service) key, not the publishable one, and that it belongs to this project.';
  res.json(out);
});

app.get('/history/list', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const cols = 'id,created_at,client_domain,client_name,client_url,score_overall,' +
               'score_v,score_w,score_s,kpis_passed,kpis_total,pdf_path,pdf_bytes,prepared_by,build';
  let path = '/rest/v1/audits?select=' + cols + '&order=created_at.desc&limit=' +
             Math.min(parseInt(req.query.limit, 10) || 100, 500);
  if (q) {
    // Search the domain OR the typed name, so both "totuswm" and "Totus" find it.
    const like = '*' + q.replace(/[*,()]/g, '') + '*';
    path += '&or=(client_domain.ilike.' + encodeURIComponent(like) +
            ',client_name.ilike.' + encodeURIComponent(like) + ')';
  }
  try { res.json({ audits: await sbJson(path) }); }
  catch (e) {
    console.error('history list error:', e.message);
    res.status(e.unconfigured ? 501 : 502).json({ error: e.message });
  }
});

// One audit, with its state, for reopening.
app.get('/history/get', async (req, res) => {
  const id = String(req.query.id || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'a valid audit id is required' });
  try {
    const rows = await sbJson('/rest/v1/audits?id=eq.' + id + '&select=*&limit=1');
    if (!rows.length) return res.status(404).json({ error: 'no audit with that id' });
    res.json(rows[0]);
  } catch (e) {
    console.error('history get error:', e.message);
    res.status(e.unconfigured ? 501 : 502).json({ error: e.message });
  }
});

// The stored PDF. Signed for ten minutes rather than made public: these are
// client-identifying documents and the bucket stays private.
app.get('/history/pdf', async (req, res) => {
  const p = String(req.query.path || '');
  if (!p || p.includes('..')) return res.status(400).json({ error: 'a valid report path is required' });
  try {
    const d = await sbJson('/storage/v1/object/sign/' + HIST_BUCKET + '/' + encodeURI(p), {
      method: 'POST', body: JSON.stringify({ expiresIn: 600 })
    });
    res.json({ url: SUPABASE_URL + '/storage/v1' + d.signedURL });
  } catch (e) {
    console.error('history pdf error:', e.message);
    res.status(e.unconfigured ? 501 : 502).json({ error: e.message });
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
// DataForSEO matches location_name against its own list and nothing else: the
// canonical form is "Houston,Texas,United States" -- no space after the comma,
// the state spelled out in full, the country on the end. The audit asks for
// "City, State" in free text, so the obvious thing to type, "Houston, Texas",
// is not in that list and comes back as
//
//   40501 Invalid Field: 'location_name'
//
// which killed the whole Google Business check, and no amount of retrying the
// same string was ever going to fix it.
//
// So normalise what was typed into the form DataForSEO accepts, and if it still
// will not take it, fall back to the country rather than losing the check. A
// national lookup on an advisory firm's name usually finds the same listing --
// the city only disambiguates -- so the degraded answer is worth having, and
// the caller is told which one it got.
const US_STATES = {
  al:'Alabama', ak:'Alaska', az:'Arizona', ar:'Arkansas', ca:'California',
  co:'Colorado', ct:'Connecticut', de:'Delaware', fl:'Florida', ga:'Georgia',
  hi:'Hawaii', id:'Idaho', il:'Illinois', in:'Indiana', ia:'Iowa', ks:'Kansas',
  ky:'Kentucky', la:'Louisiana', me:'Maine', md:'Maryland', ma:'Massachusetts',
  mi:'Michigan', mn:'Minnesota', ms:'Mississippi', mo:'Missouri', mt:'Montana',
  ne:'Nebraska', nv:'Nevada', nh:'New Hampshire', nj:'New Jersey',
  nm:'New Mexico', ny:'New York', nc:'North Carolina', nd:'North Dakota',
  oh:'Ohio', ok:'Oklahoma', or:'Oregon', pa:'Pennsylvania', ri:'Rhode Island',
  sc:'South Carolina', sd:'South Dakota', tn:'Tennessee', tx:'Texas',
  ut:'Utah', vt:'Vermont', va:'Virginia', wa:'Washington', wv:'West Virginia',
  wi:'Wisconsin', wy:'Wyoming', dc:'District of Columbia'
};
const GBP_FALLBACK_LOCATION = 'United States';

// "Houston, TX" -> "Houston,Texas,United States". Returns null for empty input
// so the caller uses the country on its own.
function dfsLocation(raw) {
  const t = String(raw || '').trim();
  if (!t) return null;
  // Split on commas, drop the empties, and tidy each part.
  let parts = t.split(',').map(x => x.trim()).filter(Boolean);
  if (!parts.length) return null;
  // Already carries a country we recognise? Leave it to the caller's hands.
  const last = parts[parts.length - 1].toLowerCase();
  const hasCountry = last === 'united states' || last === 'usa' || last === 'us';
  if (hasCountry) parts = parts.slice(0, -1);
  // Expand a two-letter state. "TX" and "Tx" both arrive.
  parts = parts.map(x => US_STATES[x.toLowerCase()] || x);
  return parts.concat('United States').join(',');
}

// True when DataForSEO rejected the location rather than the request as a
// whole -- the one failure a different location can recover from.
// Two different refusals are both worth asking again with a wider location.
//
//   40501 Invalid Field: 'location_name'   -- it would not accept the place
//   40102 No Search Results                -- it accepted the place and found
//                                             nothing in it
//
// The second is not an error in the usual sense: the request was understood.
// But a firm's listing is registered at one address, and a city that is not
// where Google has it filed returns nothing while a nationwide search for the
// same name finds it immediately. So it gets the same second attempt.
const isRetryableLocation = (code, msg) =>
  code === 40102 || /location|no search results/i.test(String(msg || ''));

// Finding the listing when my_business_info will not.
//
// Archstone Financial is in Google Maps -- name, address, phone, category,
// four reviews, a website link -- and my_business_info answered "No Search
// Results". The Business Data endpoint matches a business name against its own
// records; the Maps SERP endpoint runs the search a person runs, against the
// same index Maps itself serves, and its location list is the full SERP one
// rather than the narrower business-data list. So when the first comes back
// empty, search Maps.
//
// Every field is read by several possible names and only ever FILLED, never
// asserted from absence: this endpoint's exact shape cannot be verified from
// here, so a field that is missing leaves its check unmeasured rather than
// failing it.
const pick = (o, keys) => {
  for (const k of keys) {
    const v = k.split('.').reduce((a, part) => (a == null ? a : a[part]), o);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
};

async function mapsLookup(name, location, url) {
  const loc = dfsLocation(location);
  const want = rootDomain(url || '');
  const body = { keyword: name, language_code: 'en', depth: 20 };
  if (loc) body.location_name = loc;
  const d = await dfsPost('/serp/google/maps/live/advanced', [body], { timeout: 60000 });

  const top = d && d.status_code && d.status_code !== 20000 ? d : null;
  const task = d?.tasks?.[0];
  const err = top || (task && task.status_code !== 20000 ? task : null);
  if (err) return { error: 'Maps ' + err.status_code + ': ' + err.status_message };

  const items = (task?.result || []).flatMap(r => r.items || [])
    .filter(i => i && (i.title || i.name));
  if (!items.length) return { error: 'no Maps result for ' + name + (loc ? ' in ' + loc : '') };

  // The audited domain is what tells this firm's listing from a neighbour's.
  const byDomain = want
    ? items.find(i => rootDomain(pick(i, ['url', 'domain', 'website'])) === want)
    : null;
  const item = byDomain || items[0];
  return { item, verified: !!byDomain, candidates: items.length, searched: loc };
}

// A Maps result in the shape /gbp/info returns. Only what is present is
// claimed; anything the endpoint did not carry stays null, which the page
// reads as unmeasured rather than as a finding.
function gbpFromMaps(item, verified) {
  const rating = pick(item, ['rating.value', 'rating_value']);
  const votes  = pick(item, ['rating.votes_count', 'rating_votes_count', 'reviews_count', 'rating.reviews_count']);
  const photos = pick(item, ['total_photos', 'photos_count', 'main_image', 'photos']);
  const desc   = pick(item, ['description', 'snippet', 'about']);
  return {
    found: true, verified,
    matchedOn: verified ? 'domain' : 'maps-name-only',
    source: 'maps',
    title:       pick(item, ['title', 'name']) || '',
    address:     pick(item, ['address', 'address_info.address']) || '',
    phone:       pick(item, ['phone']) || '',
    rating:      rating != null ? rating : null,
    reviewCount: votes != null ? Number(votes) : 0,
    // Maps does not report claim status. Null, so the box reads unmeasured --
    // it is not evidence either way.
    claimed:     pick(item, ['is_claimed']) == null ? null : !!item.is_claimed,
    hasLogo:     pick(item, ['logo']) ? true : null,
    hasPhotos:   photos == null ? null : !!(typeof photos === 'number' ? photos : String(photos).length),
    description: typeof desc === 'string' ? desc : '',
    hasDescription: desc == null ? null : !!String(desc).trim(),
    category:    pick(item, ['category', 'category_ids.0']) || '',
    url:         pick(item, ['url', 'domain', 'website']) || '',
    cid:         pick(item, ['cid']) || null
  };
}

// The firm's own website usually points at its Google listing, and nobody
// links to a profile that does not exist. A "Review us on Google" button, a
// Maps embed, a g.page short link -- each one is proof the listing is there,
// and most of them carry the CID, which my_business_info accepts as a keyword.
// So when every search has failed, stop searching and follow the link the firm
// put there themselves.
const GBP_LINKS = [
  // CID, the number that identifies a listing. Best case: it can be looked up.
  [/maps\.google\.[a-z.]{2,8}\/[^"'<>\s]*[?&]cid=(\d{5,})/i,                 'cid'],
  [/google\.[a-z.]{2,8}\/maps[^"'<>\s]*[?&]cid=(\d{5,})/i,                    'cid'],
  [/[?&]ludocid=(\d{5,})/i,                                                     'cid'],
  // The review link Google itself generates, which carries a place id.
  [/search\.google\.com\/local\/(?:writereview|reviews)\?[^"'<>\s]*placeid=([A-Za-z0-9_-]{10,})/i, 'place'],
  [/[?&]place_?id=(ChI[A-Za-z0-9_-]{10,})/i,                                     'place'],
  // No identifier, but still proof somebody linked to a listing.
  [/google\.[a-z.]{2,8}\/maps\/place\/[^"'<>\s]+/i,                          'link'],
  [/\bg\.page\/[^"'<>\s]+/i,                                                  'link'],
  [/goo\.gl\/maps\/[^"'<>\s]+/i,                                              'link'],
  [/google\.[a-z.]{2,8}\/maps\/embed\?pb=[^"'<>\s]+/i,                       'link']
];

function readGbpLinks(html) {
  const h = String(html);
  const out = { cid: null, placeId: null, links: [] };
  for (const [re, kind] of GBP_LINKS) {
    const m = re.exec(h);
    if (!m) continue;
    if (kind === 'cid'   && !out.cid)     out.cid = m[1];
    if (kind === 'place' && !out.placeId) out.placeId = m[1];
    const shown = m[0].slice(0, 90);
    if (!out.links.includes(shown)) out.links.push(shown);
  }
  out.found = !!(out.cid || out.placeId || out.links.length);
  return out;
}

// Fetch the homepage and look for those links. Only ever called once every
// search has already come back empty, so the extra request costs nothing on
// the ordinary path.
async function gbpLinksFromSite(url) {
  if (!url) return { found: false };
  try {
    // BROWSER_HEADERS, not UA: UA is a local inside the site-check route, so
    // referencing it here threw ReferenceError on every call and the whole
    // route reported "no links found" when it had never read the page.
    const r = await fetch(url, { headers: BROWSER_HEADERS, redirect: 'follow',
                                 signal: AbortSignal.timeout(15000) });
    if (!r.ok) {
      // Blocked. The model's fetcher reads these sites, so ask it instead.
      const ai = await claudeFetchHead(url);
      return ai.error ? { found: false, note: 'homepage ' + r.status + ', model fetch failed' }
                      : readGbpLinks(ai.html);
    }
    return readGbpLinks((await r.text()).slice(0, 5000000));
  } catch (e) {
    return { found: false, note: e.message };
  }
}

// One live my_business_info call, retried at country level when the location
// is what DataForSEO objected to. Returns the task plus the location actually
// used, so the caller can say which answer it has.
async function gbpLookup(name, location, opts) {
  const tried = [];
  const wanted = dfsLocation(location);
  for (const loc of [wanted, GBP_FALLBACK_LOCATION].filter(Boolean)) {
    if (tried.includes(loc)) continue;
    tried.push(loc);
    const d = await dfsPost('/business_data/google/my_business_info/live', [
      { keyword: name, location_name: loc, language_name: 'English' }
    ], opts);
    const top  = d && d.status_code && d.status_code !== 20000 ? d : null;
    const task = d?.tasks?.[0];
    const err  = top ? top : (task && task.status_code !== 20000 ? task : null);
    if (!err) return { task, location: loc, tried, degraded: loc !== wanted };
    // Only a location complaint is worth another call; anything else (auth,
    // credits, a bad keyword) will fail identically at country level.
    if (!isRetryableLocation(err.status_code, err.status_message)) {
      return { error: 'DataForSEO ' + err.status_code + ': ' + err.status_message,
               location: loc, tried };

    }
    console.log('DFS GBP location rejected:', loc, '-', err.status_message);
  }
  // Both attempts came back empty. Say it in words a reader can act on rather
  // than handing them a vendor error code: "40102: No Search Results" told
  // nobody what had happened or what to do about it.
  return { error: 'no Google listing found for this firm name — searched ' +
                  tried.join(' and ') + '. Check the name matches how Google ' +
                  'lists the business, or confirm the listing by hand.',
           noResults: true, tried };
}

// Endpoint: /v3/business_data/google/my_business_info/live  (no polling!)
// Two checks hang off image fields we have never actually seen the shape of,
// and the code cannot currently tell "this firm uploaded no photos" from
// "DataForSEO does not return that field". This prints what the listing really
// carries so the difference can be settled from data.
//
// The specific question: Google itself categorises profile photos as by the
// owner, by visitors, or Street View. A Street View capture of the building is
// on almost every listing and says nothing about the firm -- crediting it as
// "has photos" hides the exact gap this audit exists to find. If DataForSEO
// passes that category (or a distinguishing image host) through, the
// distinction is free and deterministic. If it does not, no amount of looking
// at the picture makes it a measurement.
// Which request shape actually finds a listing. Archstone Financial is plainly
// in Google Maps -- name, address, phone, category, four reviews -- and
// my_business_info answered "No Search Results" for it. That is this proxy
// asking the wrong way, not a firm without a profile, and the difference
// cannot be guessed at from outside: it has to be asked.
//
// So ask every plausible shape in one go and report which ones answer. Each
// variant is a billed call, which is why this runs only when a human presses
// the button, never during an audit.
app.get('/gbp/probe', async (req, res) => {
  const { name, location, url } = req.query;
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!DFS_LOGIN) return res.status(500).json({ error: 'DataForSEO not configured' });

  const city    = dfsLocation(location);
  const domain  = rootDomain(url || '');
  // Firms are listed under a shorter name than the one on their letterhead
  // more often than not: "Archstone Financial" rather than "Archstone
  // Financial Group LLC".
  const short   = String(name).replace(/\b(llc|inc|ltd|l\.l\.c\.|group|partners|associates|advisors?|wealth management)\b/gi, '')
                              .replace(/[,.]/g, ' ').replace(/\s+/g, ' ').trim();

  const variants = [
    { label: 'name + city',                  body: { keyword: name,  location_name: city } },
    { label: 'name + country',               body: { keyword: name,  location_name: GBP_FALLBACK_LOCATION } },
    { label: 'name + US location_code 2840', body: { keyword: name,  location_code: 2840 } },
    { label: 'name, no location at all',     body: { keyword: name } },
    ...(short && short.toLowerCase() !== String(name).toLowerCase()
      ? [{ label: 'shortened name + city',   body: { keyword: short, location_name: city } }] : []),
    ...(domain
      ? [{ label: 'domain as the keyword',   body: { keyword: domain, location_name: city } },
         { label: 'name + city, domain too', body: { keyword: name + ' ' + domain, location_name: city } }] : []),
    ...(location
      ? [{ label: 'city exactly as typed',   body: { keyword: name, location_name: String(location).trim() } }] : [])
  ];

  const out = { name, short, city, domain, tried: [] };
  for (const v of variants) {
    const body = Object.assign({ language_name: 'English' }, v.body);
    try {
      const d = await dfsPost('/business_data/google/my_business_info/live', [body]);
      const task = d?.tasks?.[0];
      const code = (d && d.status_code !== 20000) ? d.status_code : task?.status_code;
      const items = task?.result?.[0]?.items || [];
      out.tried.push({
        label: v.label, sent: body, status: code,
        message: code === 20000 ? null : (task?.status_message || d?.status_message),
        listings: items.length,
        // The title and site of whatever came back, so a wrong firm is obvious.
        found: items.slice(0, 3).map(i => (i.title || '?') + (i.url ? ' — ' + i.url : ''))
      });
    } catch (e) {
      out.tried.push({ label: v.label, sent: body, error: e.message });
    }
  }
  const winners = out.tried.filter(t => t.listings > 0);
  out.verdict = winners.length
    ? 'These shapes return a listing: ' + winners.map(w => w.label).join(', ') +
      '. The live call should use the first of them.'
    : 'No shape returned a listing. This firm is not in DataForSEO\'s business database, ' +
      'whatever Google Maps shows — the audit cannot read it and the GBP boxes must be ticked by hand.';
  res.json(out);
});

app.get('/gbp/diag', async (req, res) => {
  const { name, location, url } = req.query;
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!DFS_LOGIN) return res.status(500).json({ error: 'DataForSEO not configured' });
  try {
    const r = await gbpLookup(name, location);
    if (r.error) return res.json({ error: r.error });
    const items = r.task?.result?.[0]?.items || [];
    if (!items.length) return res.json({ error: 'no listing returned for that name/location' });

    const want = rootDomain(url || '');
    const biz  = (want && items.find(i => rootDomain(i.url || i.domain) === want)) || items[0];

    // Anything that looks image-shaped, whatever it is called.
    const imageKeys = Object.keys(biz).filter(k => /image|photo|logo|picture|thumb|media/i.test(k));
    const detail = {};
    for (const k of imageKeys) {
      const v = biz[k];
      detail[k] = Array.isArray(v)
        ? { type: 'array', length: v.length,
            // An array of objects may carry the attribution; an array of URL
            // strings carries it only in the host.
            firstItem: v[0] === undefined ? null
                     : (typeof v[0] === 'object' ? { keys: Object.keys(v[0]), sample: v[0] }
                                                 : String(v[0]).slice(0, 200)) }
        : (v && typeof v === 'object') ? { type: 'object', keys: Object.keys(v), sample: v }
        : { type: typeof v, value: v == null ? null : String(v).slice(0, 200) };
    }

    res.json({
      matchedOn: want && rootDomain(biz.url || biz.domain) === want ? 'domain' : 'name-only',
      title: biz.title || '',
      // What the current checks would conclude, beside the raw data they read.
      currentReading: {
        hasPhotos: !!(biz.main_image || (biz.images && biz.images.length > 0)),
        hasLogo:   !!biz.logo
      },
      imageKeys,
      imageFields: detail,
      // Anything naming a photo count or category would settle it outright.
      countLikeKeys: Object.keys(biz).filter(k => /count|total/i.test(k)),
      allKeys: Object.keys(biz).sort()
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// One my_business_info item list, in the shape the page expects. Shared so a
// listing found by name and one found by its id through the firm's own site
// are read by exactly the same rules.
function gbpRead(items, url) {
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

  return {
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
  };
}

app.get('/gbp/info', async (req, res) => {
  const { name, location, url } = req.query;
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!DFS_LOGIN) return res.status(500).json({ error: 'DataForSEO not configured' });
  try {
    // The slowest call in the audit: Google Business data is fetched live.
    // gbpLookup normalises the typed location and retries at country level if
    // DataForSEO will not accept it, so a "Houston, Texas" in the form no
    // longer takes the whole check down with it.
    const r = await gbpLookup(name, location, { timeout: 90000 });
    const route = ['my_business_info: ' + (r.error ? r.error : 'ok')];
    const items = r.error ? null : r.task?.result?.[0]?.items;

    // Business Data had nothing. It matches a name against its own records,
    // and a listing it has not got is not a listing Google has not got --
    // Archstone Financial is in Maps with an address, a phone number and four
    // reviews, and this endpoint has never heard of it. So keep looking.
    // An account-level refusal -- auth, credits, access -- will refuse Maps in
    // exactly the same way, because it is the same account. Trying the rest of
    // the chain would bill for a second identical failure and report the same
    // thing more slowly.
    if (r.error && /DataForSEO 40[123]\d\d/.test(r.error))
      return res.json({ found: false, note: r.error, route });

    if (!items || items.length === 0) {
      // 1. Maps itself, the search a person would run.
      const m = await mapsLookup(name, location, url);
      route.push('maps: ' + (m.error || (m.verified ? 'matched by domain' : 'name-only match')));
      if (!m.error && m.verified)
        return res.json(Object.assign(gbpFromMaps(m.item, true),
          { candidates: m.candidates, searchedLocation: m.searched, route }));

      // 2. The firm's own site. Nobody links to a listing that is not there,
      //    and the link usually carries the id to look it up with.
      const l = await gbpLinksFromSite(url);
      route.push('site links: ' + (l.found ? (l.cid ? 'cid ' + l.cid
                                  : l.placeId ? 'place ' + l.placeId : l.links[0])
                                  : 'none' + (l.note ? ' (' + l.note + ')' : '')));
      if (l.cid || l.placeId) {
        const key = l.cid ? 'cid:' + l.cid : 'place_id:' + l.placeId;
        const byId = await gbpLookup(key, location, { timeout: 60000 });
        const idItems = byId.error ? null : byId.task?.result?.[0]?.items;
        route.push('lookup by id: ' + (byId.error || (idItems && idItems.length ? 'ok' : 'empty')));
        if (idItems && idItems.length)
          return res.json(Object.assign(gbpRead(idItems, url), { route, foundVia: 'website link' }));
      }
      // 3. A Maps name-only hit, or a bare link, still proves a listing EXISTS
      //    even though nothing can be scored from it automatically.
      if (!m.error || l.found) {
        const base = !m.error ? gbpFromMaps(m.item, false) : { found: true, verified: false };
        return res.json(Object.assign(base, {
          found: true, verified: false,
          matchedOn: !m.error ? 'maps-name-only' : 'website-link',
          listingExists: true,
          siteLinks: l.links || [],
          note: 'a Google listing exists — ' + (!m.error
                  ? 'found in Maps, but its website does not match the audited domain'
                  : 'the firm\'s own site links to it') +
                '. Confirm it is the right one, then tick the boxes by hand.',
          route
        }));
      }
      return res.json({ found: false, searchedLocation: r.location, degraded: r.degraded,
                        note: r.error, route });
    }

    return res.json(Object.assign(gbpRead(items, url), { route, searchedLocation: r.location, degraded: !!r.degraded }));
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
    // LLM Mentions is a SAMPLE of tracked prompts, not a census of every answer
    // the models give. So the aggregate block carrying no `total` row does not
    // mean the firm is absent from AI — it means the firm is absent from
    // DataForSEO's sample. Those are different claims, and only the first one
    // is ours to make. Calling it a measured zero told a firm that is cited by
    // name on ChatGPT, Claude and Google that they have no AI presence.
    //
    // The line is drawn at the `total` row: present with a figure (0 included)
    // is a real measurement; absent is a coverage gap, reported as unmeasured.
    const covered  = aimNum(total, 'mentions') != null;
    const num = k => (covered ? (aimNum(total, k) != null ? aimNum(total, k) : 0) : null);
    const cited    = aimSources(agg.sources_domain, target);
    const retrieved = aimSources(agg.search_results_domain, target);
    const ownCited = cited.find(x => x.own) || null;
    const mentions = num('mentions');

    out.platforms[platform] = {
      targetShape:  r.shape,
      mentions,
      searchVolume: num('ai_search_volume'),
      // Says which of the two zero-shaped answers this is: `covered` false
      // means the firm has no rows in the sampled prompt database, which is
      // NOT a finding about their AI presence.
      answered: covered,
      covered,
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

  // Zero rows for a firm that plainly IS discussed by AI could be coverage —
  // the database indexes prompts people actually asked — or it could be this
  // proxy asking the wrong question. Each target object takes a per-entity
  // search_scope, and the live call sends none. Probe the variants so the two
  // can be told apart rather than assumed.
  const name = req.body?.name || null;
  const variants = [
    { label: 'domain, no scope',              t: { domain: target } },
    { label: 'domain, scope=citations',       t: { domain: target, search_scope: 'citations' } },
    { label: 'domain, scope=mentions',        t: { domain: target, search_scope: 'mentions' } },
    { label: 'www domain, no scope',          t: { domain: 'www.' + target } },
    ...(name ? [
      { label: 'brand keyword, no scope',     t: { keyword: name } },
      { label: 'brand keyword, brand_entities', t: { keyword: name, search_scope: 'brand_entities' } }
    ] : [])
  ];
  out.scopeProbe = [];
  for (const v of variants) {
    const d = await dfsPost(AIM_BASE + '/target_metrics/live', [{
      target: [v.t], platform: 'google', location_code: 2840, language_code: 'en', internal_list_limit: 5
    }]);
    const task = d?.tasks?.[0];
    const agg  = task?.result?.[0]?.aggregated_metrics || null;
    out.scopeProbe.push({
      label: v.label,
      sent: v.t,
      status: task?.status_code ?? d?.status_code ?? null,
      message: (task?.status_code !== 20000 ? task?.status_message : null) || null,
      aggKeys: agg ? Object.keys(agg) : null,
      mentions: agg && agg.total ? agg.total.mentions ?? null : null,
      sources: agg && Array.isArray(agg.sources_domain) ? agg.sources_domain.length : null
    });
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
// These ask for LONG lists on purpose.
//
// "Who are the best financial advisors in Houston" returns three or four
// national names, so every independent firm in the country scores 0% and the
// measurement says nothing about any of them. A prospect comparing options
// does not stop at the first answer either — they ask for a list, then narrow.
//
// Asking for fifty, and asking in the specific terms a small firm can actually
// win on — independent, fee-only, fiduciary, a named niche — measures
// something a firm can move. Appearing 34th of 50 is a real, improvable
// position; being absent from a list of four is noise.
function visibilityPrompts(city) {
  const where = city ? ' in ' + city : '';
  const forCity = city ? ` for ${city}-related searches` : '';
  return [
    `Who are the 50 financial advisory firms most visible${forCity}? List them.`,
    `List 25 independent registered investment advisers serving ${city || 'clients in the US'}.`,
    `Name 20 fee-only fiduciary financial planners${where}.`,
    `Which financial advisory firms${where} work with clients approaching retirement? List as many as you can find.`,
    `List the wealth management and financial planning firms headquartered${where || ' in the US'}.`
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
  const b = req.body || {};
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
  // The headlines page 2 will print, word for word. They are approved copy, so
  // the summary may quote one but never reword it -- a paraphrase of approved
  // language is unapproved language, and it would also leave page 1 and page 2
  // describing the same fix in two different vocabularies.
  const titles = Array.isArray(b.actionTitles) ? b.actionTitles.filter(Boolean) : [];
  if (titles.length) {
    lines.push('Recommendation headlines, as page 2 prints them (exact wording):');
    titles.forEach(t => lines.push(`  - ${t}`));
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
  score back, then say that fixing it is achievable.${titles.length ? `
- When you refer to a recommendation, use a headline from the list above
  EXACTLY as written — same words, same order, same capitalisation. Do not
  reword, shorten, expand or paraphrase one. These are approved copy. If a
  headline will not fit the sentence you are writing, write a different
  sentence rather than altering the headline.` : ''}
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

  // Search stays ON. ChatGPT, Claude and Google's AI Overview all search by
  // default now, so a no-search run measures a mode no prospect uses: it asks
  // what the model memorised at training time, which for any firm founded in
  // the last few years is nothing, and which no amount of marketing changes
  // before the next training run. Answering "0%" to that and printing it next
  // to the word "AI" made a normal firm look invisible.
  //
  // knowledgeMode: true brings the no-search runs back for comparison; nothing
  // in the app asks for it.
  const withKnowledge = req.body.knowledgeMode === true;
  const modes = withKnowledge ? ['knowledge', 'citation'] : ['citation'];

  // One job per prompt per repetition per mode, across both prompt sets.
  const jobs = [];
  for (const p of prompts) {
    for (let i = 0; i < repeats; i++) {
      for (const mode of modes) jobs.push({ prompt: p, kind: 'discovery', mode });
    }
  }
  for (const p of branded) {
    for (let i = 0; i < repeats; i++) {
      for (const mode of modes) jobs.push({ prompt: p, kind: 'branded', mode });
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
      searchOn: true,
      knowledgeMode: withKnowledge,
      brandedPrompts: branded.length,
      // Discovery — the firm is never named in the question.
      //
      // Two different questions, and conflating them is how a firm that Claude
      // read six times scored 0%:
      //   named — the firm appears in the answer. This is "did we make the list".
      //   cited — their DOMAIN is among the sources the model read. Stricter:
      //           a firm can be listed from a directory page without its own
      //           site ever being opened.
      //
      // Both are now measured over the searched runs. The name rate used to be
      // computed only over the no-search runs, so turning search on left it
      // dividing by zero and the tile fell back to the citation figure.
      namedScore: pct(citation.filter(r => r.hit).length, citation.length),
      namedHits:  citation.filter(r => r.hit).length,
      namedRuns:  citation.length,
      // Kept for the opt-in knowledge comparison; null when those runs are off.
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

// ── The queue ───────────────────────────────────────────────────────────────
// Audits stack here and run a phase at a time. See queue.js for why the pacing
// matters; these routes are the thin part.
//
// Built lazily for the same reason as the runner: a deploy missing queue.js
// should lose the queue, not the proxy.
let _q = null;
function queue() {
  if (_q) return _q;
  const { makeQueue } = require('./queue.js');
  return (_q = makeQueue({
    sbJson,
    log: m => console.log(m),
    // Mirror each transition onto the Airtable row the job came from, so the
    // grid shows Queued -> Running -> Needs review without anybody asking.
    // queue.js wraps this: if Airtable is down the audit still completes.
    onStatus: async (job, status) => {
      if (!job.external_ref) return;          // added by hand, not from Airtable
      await airtable().setStatus(job.external_ref, status);
    },
    runAudit: j => runner().runAudit(Object.assign(
      { proxy: 'http://127.0.0.1:' + PORT, auditKey: AUDIT_KEY }, j)),
    // Files the finished run. No PDF: the document is the reviewer's to
    // approve, and a report nobody has looked at is not one to produce.
    saveAudit: async a => {
      const domain = auditDomain(a.clientUrl);
      const rows = await sbJson('/rest/v1/audits', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          client_domain: domain,
          client_name: String(a.clientName || '').slice(0, 300),
          client_url:  String(a.clientUrl  || '').slice(0, 600),
          client_city: String(a.clientCity || '').slice(0, 300),
          score_overall: a.scores && a.scores.overall,
          score_v: a.scores && a.scores.v, score_w: a.scores && a.scores.w,
          score_s: a.scores && a.scores.s,
          kpis_passed: a.kpisPassed ?? null, kpis_total: a.kpisTotal ?? null,
          state: a.state, report: a.report || null,
          source: a.source || 'airtable', template: a.template || 'growthline',
          build: BUILD, prepared_by: '',
          // The caller's note when it has one. An ungrounded run says why it
          // was not scored, and that belongs on the record rather than only in
          // the job row somebody has to go looking for.
          note: a.note || 'run automatically — not yet reviewed'
        })
      });
      return (rows || [])[0] || null;
    }
  }));
}

// ── The Airtable loop ───────────────────────────────────────────────────────
// A row appears with Catelogue = Audit; the poller turns it into a queued job
// and stamps AUDIT STATUS so the grid shows where it got to. When a reviewer
// approves the finished audit, the four scores, the report link and the date go
// back to the same row.
//
// Lazy like the runner and the renderer: a deploy missing airtable.js should
// lose the Airtable loop, not the proxy.
let _at = null;
function airtable() {
  if (_at) return _at;
  const { makeAirtable } = require('./airtable.js');
  return (_at = makeAirtable({
    token: AIRTABLE_TOKEN, baseId: AIRTABLE_BASE, tableId: AIRTABLE_TABLE,
    sbJson, log: m => console.log(m),
    scoreFormat: AIRTABLE_SCORE_FORMAT, gradeBands: AIRTABLE_GRADE_BANDS,
    reportUrlDays: AIRTABLE_URL_DAYS, pushReportUrl: AIRTABLE_PUSH_URL
  }));
}

let _lastPoll = null;

// The last pass, kept in the database as well as in memory.
//
// /health reports _lastPoll, but reaching /health needs network access to this
// host, and the first time the loop sat silent that was exactly what nobody
// debugging it had. The row costs one write per pass and turns "it polls and
// nothing happens" into a readable answer from the database side.
async function notePoll(summary) {
  _lastPoll = summary;
  try {
    await sbJson('/rest/v1/app_settings?on_conflict=key', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ key: 'airtable_last_poll',
        value: JSON.stringify(summary).slice(0, 4000),
        updated_at: new Date().toISOString() }) });
  } catch (e) {
    // Never allowed to fail a pass. A note about the work is not the work.
    console.error('airtable: could not record the poll summary — ' + e.message);
  }
}

function airtableHealth() {
  const out = { configured: !!(AIRTABLE_TOKEN && AIRTABLE_BASE && AIRTABLE_TABLE),
                polling: AIRTABLE_POLL_ON, everyMs: AIRTABLE_POLL_MS,
                scoreFormat: AIRTABLE_SCORE_FORMAT, pushesReportUrl: AIRTABLE_PUSH_URL,
                // Whether a queued job runs without anybody pressing anything.
                autorun: QUEUE_AUTORUN,
                last: _lastPoll };
  // A misconfigured score format is a startup problem, not a per-record one,
  // and it should be visible here rather than at the first approval.
  try { require('./airtable.js').makeFormatter(AIRTABLE_SCORE_FORMAT, AIRTABLE_GRADE_BANDS); }
  catch (e) { out.problem = e.message; }
  return out;
}

// One pass.
//
// Rows are handled oldest first, and the watermark only advances over rows that
// were actually dealt with -- queued, or refused for a stated reason. It never
// advances past a row we could not handle, so a bad pass costs a delay rather
// than a lost audit.
async function pollAirtable(opts) {
  const o = opts || {};
  const A = airtable();
  const since = await A.watermark();
  // First ever pass: the mark has just been seeded to now, so there is by
  // definition nothing after it. Taking nothing here is the point -- it is what
  // keeps the 2,699 existing Audit rows permanently out of reach.
  if (!since) {
    await notePoll({ at: new Date().toISOString(), seeded: true, taken: 0 });
    return { seeded: true, taken: 0, queued: [], rejected: [], problems: [] };
  }

  const recs = await A.candidates(since, o.limit || 25);
  const { take, rejected } = A.triage(recs, since);
  const byId = new Map();
  take.forEach(t => byId.set(t.recordId, { kind: 'take', job: t }));
  rejected.forEach(r => byId.set(r.recordId, { kind: 'reject', why: r.why,
                                              company: r.company, stale: r.stale }));

  const queued = [], refused = [], problems = [];
  let mark = since, stopped = null;
  // The mark only ever goes forward. A stale row below is the fence working
  // rather than a decision, and moving the mark onto one would move it
  // BACKWARDS -- the next pass would then pull in more old rows, reject those
  // too, move back further, and walk down into the 83 dead records. The only
  // reason that has not happened is that the query has never returned an old
  // row, which is not a guarantee.
  const advance = iso => {
    const t = Date.parse(iso || '');
    if (t && t > Date.parse(mark)) mark = new Date(t).toISOString();
  };

  for (const rec of recs) {
    const d = byId.get(rec.id);
    if (!d) continue;
    if (d.kind === 'reject') {
      refused.push({ recordId: rec.id, company: d.company, why: d.why });
      // A refusal is a decision the mark may move past -- except a stale row,
      // which is the fence itself and must never drag the mark backwards.
      if (!d.stale) advance(rec.createdTime);
      continue;
    }
    const j = d.job;
    try {
      // Airtable first, deliberately. If this write fails the pass stops and
      // nothing is queued: a row marked Queued with no job is a visible stuck
      // cell somebody can clear, whereas a job with no mark gets picked up
      // again next pass and the audit runs -- and is billed -- twice.
      await A.setStatus(rec.id, 'queued');
    } catch (e) {
      stopped = 'could not write AUDIT STATUS on ' + (j.clientName || rec.id) +
                ' — ' + e.message + '. Stopping this pass with the watermark ' +
                'where it was, so nothing is skipped.';
      break;
    }
    try {
      const rows = await sbJson('/rest/v1/audit_jobs', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify([{
          client_name: j.clientName.slice(0, 300),
          client_url:  j.clientUrl.slice(0, 600),
          client_city: j.clientCity.slice(0, 300),
          source: 'airtable', template: 'growthline',
          external_ref: j.recordId, priority: 0
        }]) });
      queued.push({ recordId: j.recordId, company: j.clientName,
                    url: j.clientUrl, city: j.clientCity || null,
                    jobId: (rows || [])[0] && rows[0].id });
      advance(rec.createdTime);
    } catch (e) {
      // The job could not be created. The row is already marked, so mark it
      // Failed rather than leaving it saying Queued for ever, and carry on --
      // one bad row is not the pass's problem.
      const dup = /duplicate key|already exists/i.test(e.message);
      try { await A.setStatus(rec.id, dup ? 'queued' : 'failed'); } catch (e2) {}
      problems.push({ recordId: rec.id, company: j.clientName,
                      error: dup ? 'already queued or running' : e.message });
      advance(rec.createdTime);
    }
  }

  if (mark !== since) await A.setWatermark(new Date(mark).toISOString());
  const out = { taken: queued.length, queued, rejected: refused, problems,
                watermark: new Date(mark).toISOString(), stopped,
                at: new Date().toISOString() };
  await notePoll({ at: out.at, taken: out.taken, rejected: refused.length,
                   problems: problems.length, stopped,
                   // The refusals themselves, not just how many. "0 taken,
                   // 1 refused" says nothing; "refused: not the firm's
                   // website" says what to fix.
                   why: refused.slice(0, 5).map(r => r.company + ': ' + r.why),
                   candidates: recs.length });
  if (queued.length || problems.length || stopped)
    console.log('airtable: ' + queued.length + ' queued, ' + refused.length +
                ' refused, ' + problems.length + ' problems' +
                (stopped ? ' — ' + stopped : ''));
  return out;
}

// What the next pass WOULD take, changing nothing. The first thing to run
// before trusting the loop with a real request.
app.get('/airtable/preview', async (req, res) => {
  try {
    const A = airtable();
    const rows = await sbJson('/rest/v1/app_settings?key=eq.airtable_watermark&select=value');
    const v = (rows || [])[0] && (rows || [])[0].value;
    if (!v) return res.json({ watermark: null,
      note: 'no watermark yet — the first poll will seed it to now and take nothing' });
    const since = new Date(v).toISOString();
    const recs = await A.candidates(since, Math.min(+req.query.limit || 25, 100));
    const t = A.triage(recs, since);
    res.json({ watermark: since, candidates: recs.length,
               wouldQueue: t.take, wouldRefuse: t.rejected });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Run a pass now rather than waiting for the timer.
app.post('/airtable/poll', async (req, res) => {
  try {
    const out = await pollAirtable({ limit: (req.body || {}).limit });
    // Same as the timer: polling and running are one action, so a hand-run
    // pass behaves exactly like an automatic one.
    out.autorun = await autoRunQueue();
    res.json(out);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Move the watermark. Needed to test with a row that already exists, and
// capped on purpose: the base holds 83 dead Audit rows with no score, so a mark
// set carelessly into the past queues every one of them.
app.post('/airtable/watermark', async (req, res) => {
  const b = req.body || {};
  if (!b.at) return res.status(400).json({ error: 'an ISO timestamp is required' });
  const t = Date.parse(b.at);
  if (!t) return res.status(400).json({ error: 'not a date I can read: ' + b.at });
  const daysBack = (Date.now() - t) / 86400000;
  if (daysBack > 30 && !b.force) return res.status(400).json({
    error: 'that mark is ' + Math.round(daysBack) + ' days back. The base holds ' +
           '83 Catelogue=Audit rows with no score, all of them dead records, and ' +
           'a mark that far back queues them. Send force: true if you mean it.' });
  try {
    await airtable().setWatermark(new Date(t).toISOString());
    res.json({ ok: true, watermark: new Date(t).toISOString() });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Push one finished audit back by hand -- a repair path for a push that failed
// while Airtable was unreachable, and how a re-push is done.
app.post('/airtable/push', async (req, res) => {
  const b = req.body || {};
  if (!b.jobId) return res.status(400).json({ error: 'which job?' });
  try { res.json(await pushJob(b.jobId, { force: !!b.force })); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// The push itself. Separate from the route because approval calls it too.
async function pushJob(jobId, opts) {
  const o = opts || {};
  const jobs = await sbJson('/rest/v1/audit_jobs?id=eq.' +
    encodeURIComponent(jobId) + '&select=*');
  const job = (jobs || [])[0];
  if (!job) throw new Error('no such job: ' + jobId);
  if (!job.external_ref) return { skipped: 'this job did not come from Airtable' };
  if (job.pushed_at && !o.force) return { skipped: 'already pushed at ' +
    job.pushed_at + ' — send force: true to write it again', pushedAt: job.pushed_at };
  if (!job.audit_id) throw new Error('that job has no saved audit to push');

  const rows = await sbJson('/rest/v1/audits?id=eq.' +
    encodeURIComponent(job.audit_id) +
    '&select=id,score_overall,score_v,score_w,score_s,pdf_path');
  const audit = (rows || [])[0];
  if (!audit) throw new Error('the audit this job points at is gone: ' + job.audit_id);

  const A = airtable();
  // A link that is still alive when somebody clicks it months later.
  // /history/pdf signs for ten minutes, which is right for a download button
  // and useless in a database row.
  let reportUrl = null;
  if (AIRTABLE_PUSH_URL && audit.pdf_path) {
    try { reportUrl = await A.reportLink(audit.pdf_path, HIST_BUCKET, SUPABASE_URL); }
    catch (e) { console.error('airtable: could not sign the report link — ' + e.message); }
  }

  try {
    const wrote = await A.pushApproved({ recordId: job.external_ref, audit, reportUrl });
    await sbJson('/rest/v1/audit_jobs?id=eq.' + encodeURIComponent(jobId), {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ pushed_at: new Date().toISOString(), push_error: null }) });
    return Object.assign({ ok: true, jobId, reportUrl }, wrote);
  } catch (e) {
    // Recorded against the job and nowhere else. A failed push is a failed
    // push: it does not make an approved audit unapproved.
    await sbJson('/rest/v1/audit_jobs?id=eq.' + encodeURIComponent(jobId), {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ push_error: e.message.slice(0, 900) }) }).catch(() => {});
    throw e;
  }
}

// Stack one. Deliberately minimal: the three fields an audit needs, plus a
// reference back to wherever it came from.
app.post('/queue/add', async (req, res) => {
  const b = req.body || {};
  const urls = Array.isArray(b.items) ? b.items : [b];
  const rows = urls.filter(x => x && x.clientUrl).map(x => ({
    client_name: String(x.clientName || '').slice(0, 300),
    client_url:  String(x.clientUrl).slice(0, 600),
    client_city: String(x.clientCity || '').slice(0, 300),
    source: x.source || 'airtable', template: x.template || 'growthline',
    external_ref: x.externalRef || null, assigned_to: x.assignedTo || null,
    priority: x.priority || 0
  }));
  if (!rows.length) return res.status(400).json({ error: 'a website URL is required' });
  try {
    const out = await sbJson('/rest/v1/audit_jobs', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify(rows) });
    res.json({ ok: true, added: (out || []).length, jobs: out });
  } catch (e) {
    // One live job per site is a database constraint, so a double-add comes
    // back as a conflict rather than quietly spending the API budget twice.
    const dup = /duplicate key|already exists/i.test(e.message);
    res.status(dup ? 409 : 502).json({ error: dup
      ? 'that site is already queued or running' : e.message });
  }
});

// What is waiting, running, or wants a person.
app.get('/queue', async (req, res) => {
  try {
    const sel = 'id,created_at,client_name,client_url,client_city,status,attempts,' +
                'started_at,finished_at,audit_id,error,measured,assigned_to,source,' +
                // Where it came from and whether the result got back there. An
                // approved audit whose push failed looks finished otherwise.
                'external_ref,pushed_at,push_error,ungrounded';
    const jobs = await sbJson('/rest/v1/audit_jobs?select=' + sel +
      '&order=created_at.desc&limit=' + Math.min(+req.query.limit || 100, 200));
    const by = st => (jobs || []).filter(j => j.status === st).length;
    let running = false;
    try { running = queue().isRunning(); } catch (e) {}
    res.json({ jobs: jobs || [], running, lastDrain: _lastDrain,
      counts: { queued: by('queued'), running: by('running'),
                needsReview: by('needs_review'), failed: by('failed'),
                approved: by('approved') } });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Start the queue and answer immediately.
//
// This used to hold the connection open until the whole phase finished, and
// that cannot work: a phase is six audits at two at a time, so the request
// sends nothing for ten minutes and the platform cuts it as dead. The first
// real attempt died before a single job was even claimed, with the page
// reporting a dropped connection and the queue untouched.
//
// So the drain runs in the background and this says "started". Progress is
// read from /queue, which is where it was always visible anyway.
let _lastDrain = null;

// Starting a drain, from wherever. The route and the poller both end up here
// so a background run is recorded the same way whoever began it.
function startDrain(opts, why) {
  const q = queue();                       // throws if the runner is missing
  if (q.isRunning()) return { skipped: 'already running', last: _lastDrain };
  q.drain(opts || {})
    .then(r => { _lastDrain = Object.assign({ at: new Date().toISOString(), why }, r);
                 console.log('queue: finished — ' + r.ran + ' ran, ' +
                             r.needsReview + ' waiting, ' + r.failed + ' failed'); })
    .catch(e => { _lastDrain = { at: new Date().toISOString(), why, error: e.message };
                  console.error('queue drain error:', e.message); });
  return { started: true, why };
}

// ── The queue starting itself ───────────────────────────────────────────────
// Called after every poll. Deliberately NOT "start a drain because this pass
// queued something": it starts one whenever anything is waiting and nothing is
// draining. That covers the case a narrower version would miss -- jobs left
// queued by a restart, or by a drain that died -- which would otherwise sit
// there for ever with the poller cheerfully adding more beside them.
async function autoRunQueue() {
  if (!QUEUE_AUTORUN) return { skipped: 'autorun is off' };
  let q;
  try { q = queue(); }
  catch (e) { return { error: e.message }; }   // no runner on this deploy
  if (q.isRunning()) return { skipped: 'already running' };
  let waiting;
  try {
    waiting = await sbJson('/rest/v1/audit_jobs?status=eq.queued&select=id&limit=1');
  } catch (e) { return { error: e.message }; }
  if (!waiting || !waiting.length) return { skipped: 'nothing queued' };
  try { return startDrain({}, 'queue autorun'); }
  catch (e) { return { error: e.message }; }
}

app.post('/queue/run', (req, res) => {
  const b = req.body || {};
  let out;
  // Nothing awaits the drain: the response goes out first and the work
  // outlives the request. Errors are kept for /queue rather than thrown into a
  // handler that has already answered.
  try {
    out = startDrain({ concurrency: b.concurrency, batchSize: b.batchSize,
                       pauseMs: b.pauseMs, maxJobs: b.maxJobs }, 'pressed Run');
  } catch (e) { return res.status(e.runnerMissing ? 503 : 500).json({ error: e.message }); }
  if (out.skipped) return res.status(409).json({
    error: 'the queue is already running', running: true, last: _lastDrain });

  res.status(202).json({ ok: true, started: true,
    note: 'running in the background — watch the queue for progress' });
});

// Stop after the runs already in flight finish. Not a kill: a half-written
// audit is worse than a slow one.
app.post('/queue/stop', (req, res) => {
  try { queue().stop(); res.json({ ok: true, stopping: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// A reviewer finishing with one, or dropping it.
app.post('/queue/status', async (req, res) => {
  const b = req.body || {};
  const ALLOWED = ['approved', 'cancelled', 'queued'];
  if (!b.id) return res.status(400).json({ error: 'which job?' });
  if (!ALLOWED.includes(b.status)) return res.status(400).json({
    error: 'a reviewer can set: ' + ALLOWED.join(', ') });
  try {
    const rows = await sbJson('/rest/v1/audit_jobs?id=eq.' + encodeURIComponent(b.id), {
      method: 'PATCH', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ status: b.status,
        // Re-queueing clears the last run's verdict, so a retry is not read
        // through the failure that prompted it.
        error: b.status === 'queued' ? null : undefined,
        finished_at: b.status === 'queued' ? null : new Date().toISOString() }) });
    const job = (rows || [])[0] || null;

    // Approval is the only thing that writes a result back to Airtable. Not the
    // run finishing -- a run finishing means a person still has to look at it.
    //
    // The push is reported but never allowed to fail the approval: the reviewer
    // approved the audit, and Airtable being unreachable does not un-approve it.
    // A failure here is recorded on the job and retried with /airtable/push.
    let push = null;
    if (job && job.external_ref) {
      if (b.status === 'approved') {
        try { push = await pushJob(job.id, { force: !!b.force }); }
        catch (e) { push = { error: e.message,
          note: 'the audit is approved — only the write to Airtable failed. ' +
                'Retry with POST /airtable/push {"jobId":"' + job.id + '"}' }; }
      } else {
        // Re-queued or dropped: keep the grid honest about it.
        try { await airtable().setStatus(job.external_ref,
          b.status === 'queued' ? 'queued' : 'cancelled'); }
        catch (e) { push = { error: 'could not update AUDIT STATUS — ' + e.message }; }
      }
    }
    res.json({ ok: true, job, push });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Run an audit with nobody watching.
//
// Takes the same three things a person types -- firm, website, city -- and
// returns what the page would have on screen: the report data, the saved
// state, the scores and, named rather than hidden, every check that could not
// be measured. A headless run has no browser extension behind it, so a site
// that refuses the server leaves more of those than a hand-run audit would,
// and the caller has to be able to see that.
//
// It does NOT file the audit or build a PDF. Those are separate decisions --
// a prospect's run is not automatically a document anyone should send -- and
// /history/save and /report/build already do them.
app.post('/audit/run', async (req, res) => {
  const b = req.body || {};
  if (!b.clientUrl) return res.status(400).json({ error: 'a website URL is required' });

  const started = Date.now();
  try {
    const out = await runner().runAudit({
      clientName: b.clientName, clientUrl: b.clientUrl, clientCity: b.clientCity,
      preparedBy: b.preparedBy,
      // Back to this same process, so the page's calls do not leave the box.
      proxy: 'http://127.0.0.1:' + PORT,
      auditKey: AUDIT_KEY,
      timeout: b.timeout
    });
    // Refused, not returned with a warning. An unattended caller that gets a
    // 200 with a score will use the score; this is the one case where the
    // honest answer is that there is no result.
    if (out.ungrounded) return res.status(422).json({
      error: 'this audit learned too little to score. ' + out.silentlyFailed.length +
             ' of ' + (out.state.checks || []).length + ' checks would have been ' +
             'counted against this firm without anything having been checked, ' +
             'against only ' + out.grounded + ' that rest on something. Reporting ' +
             'a score from that would be a guess presented as a measurement.',
      measured: out.measured, grounded: out.grounded,
      silentlyFailed: out.silentlyFailed, unmeasured: out.unmeasured,
      ranMs: Date.now() - started
    });
    res.json(Object.assign({ ok: true, ranMs: Date.now() - started }, out));
  } catch (e) {
    console.error('audit run error:', e.message);
    res.status(e.badRequest ? 400 : e.runnerMissing ? 503 : 500)
       .json({ error: e.message, ranMs: Date.now() - started });
  }
});

// Build a report without a browser.
//
// Two ways to ask: `id` rebuilds a filed audit from the report data stored with
// it, and `report` renders data sent in the request -- which is what an
// unattended run will use once there is one. `template` names the document; an
// unknown name is refused rather than quietly rendered as the default, because
// the default footer reads "For financial professional use only. Not for use
// with the public." and the cost of getting that wrong is handing a prospect a
// document that says it is not for them.
app.post('/report/build', async (req, res) => {
  const b = req.body || {};
  try {
    let d = b.report || null, template = b.template || null;

    if (!d && b.id) {
      const rows = await sbJson('/rest/v1/audits?id=eq.' + encodeURIComponent(b.id) +
                                '&select=report,template,client_name&limit=1');
      const row = (rows || [])[0];
      if (!row) return res.status(404).json({ error: 'no audit with that id' });
      if (!row.report) return res.status(409).json({
        error: 'that audit was filed before the report data was kept, so its PDF ' +
               'cannot be rebuilt. The report delivered at the time is still stored.' });
      d = row.report;
      template = template || row.template;
    }

    const bad = checkReport(d);
    if (bad) return res.status(400).json({ error: bad });

    const pdf = await renderReport(d, { template, draft: !!b.draft });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      'attachment; filename="' + reportName(d).replace(/"/g, '') + '"');
    res.send(pdf);
  } catch (e) {
    console.error('report build error:', e.message);
    res.status(e.badRequest ? 400 : e.rendererMissing ? 503 : 500).json({ error: e.message });
  }
});

// What this proxy can build, so the app can show the choice rather than
// hard-coding a list that drifts from the server's.
app.get('/report/templates', (req, res) =>
  res.json({ templates: templateInfo(), sources: SOURCES, renderer: rendererStatus() }));

// ── The poll timer ──────────────────────────────────────────────────────────
// unref'd: a pending timer must not be the reason the process will not exit,
// which matters for the tests that require this file.
//
// Errors are logged and swallowed. This runs detached from any request, so a
// throw here would surface as an unhandled rejection and the loop would simply
// stop with nothing said -- /health reports the last pass instead.
if (AIRTABLE_POLL_ON) {
  const tick = async () => {
    try { await pollAirtable({}); }
    catch (e) {
      // Recorded in the database as well, because an error only visible on a
      // host nobody can reach is an error nobody can read.
      notePoll({ at: new Date().toISOString(), error: e.message });
      console.error('airtable poll: ' + e.message);
    }
    // Deliberately outside that catch. Airtable being unreachable is no reason
    // to stop auditing what is already queued -- those jobs are here, paid for
    // and waiting, and the poll failing says nothing about them.
    try {
      const r = await autoRunQueue();
      if (r && r.started) console.log('queue: started automatically');
      else if (r && r.error) console.error('queue autorun: ' + r.error);
    } catch (e) { console.error('queue autorun: ' + e.message); }
  };
  const t = setInterval(tick, AIRTABLE_POLL_MS);
  if (t.unref) t.unref();
  // Not on the first tick of the clock: let the process finish booting, and
  // let the watermark be seeded before anything is looked for.
  const first = setTimeout(tick, 15000);
  if (first.unref) first.unref();
}

app.listen(PORT, () => console.log('Proxy running on port ' + PORT));
