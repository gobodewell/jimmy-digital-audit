// ── Airtable in, Airtable out ────────────────────────────────────────────────
// Two directions, deliberately asymmetric.
//
// IN: a row appears in `GrowthLine Program (All)` with Catelogue = Audit, and
// the poller turns it into a queued job. This is the half that can do damage,
// so most of this file is about not doing any.
//
// OUT: a reviewer approves an audit and its four scores, its report link and
// the date go back to the same row. This half is easy, and it is allowed to
// fail: Airtable being unreachable must never change what an audit found.
//
// Nothing here decides an audit is finished. The run leaves it at needs_review
// and a person approves it; the push is a consequence of that approval, never
// a substitute for it.

// ── Why the poller is fenced by time ────────────────────────────────────────
// `Catelogue = Audit` is on 2,699 rows -- it marks a record as an audit job,
// not as a job wanting doing. `ASSIGNED FOR AUDIT` is ticked on 1,038, same
// problem. Narrowing to "Audit, no score, no report URL" leaves 83, and every
// one of those is dead: `removed from list (error or duplicate)`, `ON HOLD`,
// one of them with a LinkedIn profile in the WEBSITE field. The newest is
// fifteen days old, which is close enough to any rolling window to be a trap.
//
// So no combination of field values means "now". The fence is CREATED time,
// against a mark seeded at the moment the poller first runs. Rows that already
// exist are permanently out of reach, and that property does not decay.

// Fields are addressed by ID, not name. Someone renaming a column in Airtable
// should not silently stop the audits -- and `Index Score| Overall` has a
// space and a pipe in it, which is exactly the kind of name that gets tidied.
const F = {
  catalogue: 'fldneOMbEne6Jaqkp',   // Catelogue (sic -- their spelling)
  company:   'fldyAu3ufO23nAE0i',   // COMPANY NAME
  website:   'fldpOUc8EOeTq3h2K',   // WEBSITE
  city:      'fldofqUVrOj8QoWC0',   // City
  stage:     'fldhH7yLKxxChXYr0',   // STAGE
  status:    'fldOzJk0hBseUT4XN',   // AUDIT STATUS   (server-written)
  completed: 'fldXDzl0EaOnSMRaa',   // AUDIT COMPLETED (server-written)
  reportUrl: 'fldRSXPtgbTaX9BUo',   // AUDIT REPORT URLS
  scoreAll:  'fldfyxPtgQ1bHGMrb',   // Index Score| Overall
  scoreVis:  'fldNMrRgA59z13sH5',   // Index Score| Visibility
  scoreWeb:  'fld1rDYl3uRFxwrtH',   // Index Score|Website
  scoreSoc:  'fldx6HdPnDNkyweUG'    // Index Score|Social
};

// The states the server writes into AUDIT STATUS. These are the option names
// in the field, so they have to match it exactly.
const STATUS = {
  queued: 'Queued', running: 'Running',
  needs_review: 'Needs review', approved: 'Approved', failed: 'Failed',
  // A reviewer deciding this one is not worth delivering. Distinct from Failed,
  // which means the run could not do its job -- the difference matters when you
  // are looking at the grid trying to work out what needs chasing.
  cancelled: 'Cancelled'
};

// STAGE values that mean the row is not a live job. A human marking something
// a duplicate and the poller taking it anyway is the failure this prevents.
const DEAD_STAGES = [
  'removed from list (error or duplicate)',
  'removed from anniv. audit',
  'ANNIV. AUDITS CANCELED 7/15/24',
  'Canceled Project',
  'ON HOLD'
];

// Hosts that are somebody's profile, not a firm's website. There is a real row
// in the base with a LinkedIn URL in WEBSITE; auditing that would score the
// firm on LinkedIn's site.
const NOT_A_SITE = [
  'linkedin.com', 'facebook.com', 'instagram.com', 'twitter.com', 'x.com',
  'youtube.com', 'tiktok.com', 'google.com', 'docs.google.com',
  'sites.google.com', 'mailchi.mp', 'calendly.com'
];

// ── The website field, as it actually arrives ────────────────────────────────
// Observed in the base: leading and trailing spaces, UPPERCASE, a trailing
// full stop ("www.millerickassociates.com."), a query string with a
// disclaimer accept, a bare domain with no scheme, and a LinkedIn profile.
function normaliseSite(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return { reject: 'no website on the record' };
  // Quotes and angle brackets people paste in alongside a URL.
  s = s.replace(/^["'<\s]+|["'>\s]+$/g, '');
  // Trailing sentence punctuation. A trailing slash is legitimate and stays.
  s = s.replace(/[.,;:]+$/, '');
  if (!s) return { reject: 'no website on the record' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return { reject: 'not a web address: ' + s };
    s = 'https://' + s;
  }
  let u;
  try { u = new URL(s); } catch (e) { return { reject: 'not a usable URL: ' + raw }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:')
    return { reject: 'not a web address: ' + raw };
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host))
    return { reject: 'not a real domain: ' + u.hostname };
  if (NOT_A_SITE.some(d => host === d || host.endsWith('.' + d)))
    return { reject: 'that is a ' + host + ' profile, not the firm\'s website' };
  u.hash = '';
  return { url: u.toString() };
}

// ── Score formatting ────────────────────────────────────────────────────────
// The four Index Score fields are text, and the base holds two conventions:
// numbers in the 2021 rows ("67.5", "70") and letter grades since 2023
// ("B (overall)"). The audit computes a number, 60-100.
//
// Default is the number, because it is what was measured and a grade can
// always be derived from it. Grades are available but refuse to guess: the
// bands have to be stated, or this throws rather than inventing boundaries
// and writing a confident B over something that was never agreed.
function parseBands(spec) {
  const bands = String(spec || '').split(',').map(s => s.trim()).filter(Boolean)
    .map(s => {
      const m = /^(\d+(?:\.\d+)?)\s*:\s*(.+)$/.exec(s);
      if (!m) throw new Error('AIRTABLE_GRADE_BANDS is malformed near "' + s +
        '" — expected "90:A,80:B,70:C,60:D"');
      return { min: Number(m[1]), grade: m[2] };
    })
    .sort((a, b) => b.min - a.min);
  if (!bands.length) throw new Error(
    'grades were asked for but AIRTABLE_GRADE_BANDS is not set — ' +
    'set it to something like "90:A,80:B,70:C,60:D" and nothing will be guessed');
  return bands;
}

function makeFormatter(mode, bandSpec) {
  const m = String(mode || 'number').trim().toLowerCase();
  if (m === 'number') return n => (n == null ? null : String(n));
  const bands = parseBands(bandSpec);          // throws early, not per record
  const grade = n => (bands.find(b => n >= b.min) || bands[bands.length - 1]).grade;
  if (m === 'grade') return n => (n == null ? null : grade(n));
  if (m === 'number+grade') return n => (n == null ? null : n + ' (' + grade(n) + ')');
  throw new Error('AIRTABLE_SCORE_FORMAT must be number, grade or number+grade — ' +
                  'got "' + mode + '"');
}

function makeAirtable(deps) {
  const {
    token, baseId, tableId, sbJson, log,
    scoreFormat, gradeBands,
    reportUrlDays,        // how long the pushed report link stays valid
    pushReportUrl         // false to leave AUDIT REPORT URLS alone
  } = deps;
  const say = log || (() => {});
  const fmt = makeFormatter(scoreFormat, gradeBands);
  const urlDays = Number(reportUrlDays) > 0 ? Number(reportUrlDays) : 3650;

  function need() {
    if (!token) throw new Error('Airtable is not configured on the proxy — set AIRTABLE_TOKEN');
    if (!baseId || !tableId) throw new Error(
      'Airtable is not configured on the proxy — set AIRTABLE_BASE and AIRTABLE_TABLE');
  }

  const API = 'https://api.airtable.com/v0/';

  async function at(path, opts) {
    need();
    const o = opts || {};
    const r = await fetch(API + baseId + '/' + tableId + path, {
      method: o.method || 'GET',
      headers: Object.assign({ Authorization: 'Bearer ' + token },
        o.body ? { 'Content-Type': 'application/json' } : {}),
      body: o.body
    });
    const text = await r.text();
    let d = null;
    if (text.trim()) {
      // Same shape of bug that cost us an audit on the Supabase side: never
      // call .json() on a body that might be empty or an HTML error page.
      try { d = JSON.parse(text); }
      catch (e) {
        throw new Error('Airtable sent a reply that is not JSON (HTTP ' +
          r.status + '): ' + text.slice(0, 160));
      }
    }
    if (!r.ok) {
      const why = (d && d.error && (d.error.message || d.error.type)) || ('HTTP ' + r.status);
      throw new Error('Airtable: ' + why);
    }
    return d;
  }

  // ── The watermark ─────────────────────────────────────────────────────────
  // Read from and written to Supabase so it survives a restart. If it is
  // missing the poller sets it to now and takes nothing, which is the safe
  // direction to fail in: a first pass that does nothing costs one cycle, a
  // first pass with no mark costs 83 audits against dead records.
  async function watermark() {
    const rows = await sbJson(
      '/rest/v1/app_settings?key=eq.airtable_watermark&select=value');
    const v = (rows || [])[0] && (rows || [])[0].value;
    if (v && !isNaN(Date.parse(v))) return new Date(v).toISOString();
    const now = new Date().toISOString();
    await setWatermark(now);
    say('airtable: no watermark found — seeded to ' + now + ', taking nothing this pass');
    return null;                       // null means "took nothing on purpose"
  }

  async function setWatermark(iso) {
    await sbJson('/rest/v1/app_settings?on_conflict=key', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ key: 'airtable_watermark', value: iso,
                             updated_at: new Date().toISOString() })
    });
  }

  // Candidate rows: Catelogue = Audit, nothing in AUDIT STATUS yet, a website
  // present. The date test is in the formula AND repeated in JS below --
  // the formula is a pre-filter to keep the page small, and the JS check is
  // the one that is actually trusted.
  function formula(sinceIso) {
    // No {WEBSITE}!='' here, on purpose.
    //
    // It was the obvious condition and it made the one thing somebody needs to
    // be told invisible: Airtable never returned the row, so it could not be
    // refused with a reason, and the pass reported "candidates: 0" about a row
    // sitting right there waiting for a URL. A request with no website is not
    // nothing to say -- it is the whole message.
    const parts = [
      "{Catelogue}='Audit'",
      "{AUDIT STATUS}=''",
      "IS_AFTER(CREATED_TIME(),'" + sinceIso + "')"
    ];
    return 'AND(' + parts.join(',') + ')';
  }

  async function candidates(sinceIso, limit) {
    const q = '?returnFieldsByFieldId=true' +
      '&filterByFormula=' + encodeURIComponent(formula(sinceIso)) +
      '&pageSize=' + Math.min(Math.max(+limit || 25, 1), 100) +
      '&sort%5B0%5D%5Bfield%5D=Created&sort%5B0%5D%5Bdirection%5D=asc';
    const d = await at(q);
    return (d && d.records) || [];
  }

  // What the poller found, turned into either a job or a stated refusal.
  // Nothing is skipped silently: a row we will not audit comes back in
  // `rejected` with the reason, so it shows up rather than vanishing.
  function triage(records, sinceIso) {
    const take = [], rejected = [];
    for (const rec of records) {
      const f = rec.fields || {};
      const ref = { recordId: rec.id, company: String(f[F.company] || '').trim() };

      // The formula already tested this, but a formula is somebody else's
      // date parser. This is the check that is trusted.
      const made = Date.parse(rec.createdTime || '');
      if (!made || made <= Date.parse(sinceIso)) {
        // `stale` matters to the caller. Every other refusal is a DECISION
        // about a new row, and the watermark may move past it. This one is the
        // fence doing its job, and moving the mark to it would move the mark
        // BACKWARDS -- so the next pass pulls in more old rows, rejects those
        // too, moves back further, and walks down into the 83 dead records.
        // Nothing has gone wrong yet to cause that, but the only reason is
        // that the query has never returned an old row.
        rejected.push(Object.assign({ stale: true,
          why: 'created before the watermark — not a new request' }, ref));
        continue;
      }

      const stage = f[F.stage];
      const stageName = stage && typeof stage === 'object' ? stage.name : stage;
      if (stageName && DEAD_STAGES.includes(stageName)) {
        rejected.push(Object.assign({ why: 'STAGE is "' + stageName + '"' }, ref));
        continue;
      }

      const site = normaliseSite(f[F.website]);
      if (site.reject) {
        // `fixable` keeps the row in view. A missing or unusable URL is waiting
        // on a person, not a verdict, and advancing the watermark past it would
        // mean the row is never looked at again -- including after somebody
        // pastes the URL in. It keeps being reported until it is fixed, or
        // until AUDIT STATUS is set to anything at all, which drops it out of
        // the query. A dead STAGE above is a decision and does advance.
        rejected.push(Object.assign({ fixable: true, why: site.reject }, ref));
        continue;
      }

      take.push({
        recordId: rec.id,
        clientName: ref.company,
        clientUrl: site.url,
        clientCity: String(f[F.city] || '').trim(),
        createdTime: rec.createdTime
      });
    }
    return { take, rejected };
  }

  async function setStatus(recordId, status) {
    const name = STATUS[status] || status;
    if (!Object.values(STATUS).includes(name))
      throw new Error('not an AUDIT STATUS option: ' + status);
    const write = v => at('/' + encodeURIComponent(recordId), {
      method: 'PATCH', body: JSON.stringify({ fields: { [F.status]: v } }) });
    try {
      await write(name);
      return name;
    } catch (e) {
      // "Cancelled" is the one option the field may not have: it cannot be
      // added through the API, only in the Airtable UI. Rather than fail a
      // reviewer's decision over a missing dropdown entry, clear the cell --
      // a blank AUDIT STATUS on a row the watermark has already passed reads
      // as "no audit here", which is what cancelled means.
      const missing = /INVALID_MULTIPLE_CHOICE_OPTIONS|Insufficient permissions to create new select option|unknown field name/i
        .test(e.message);
      if (missing && status === 'cancelled') {
        await write(null);
        say('airtable: AUDIT STATUS has no "Cancelled" option, so the cell was ' +
            'cleared instead. Add the option in Airtable for a clearer grid.');
        return null;
      }
      throw e;
    }
  }

  // ── The push ──────────────────────────────────────────────────────────────
  // Four scores, the report link, the date, and the status. One PATCH, so the
  // row is never left half-written.
  async function pushApproved(o) {
    const a = o.audit || {};
    const fields = {
      [F.scoreAll]: fmt(a.score_overall),
      [F.scoreVis]: fmt(a.score_v),
      [F.scoreWeb]: fmt(a.score_w),
      [F.scoreSoc]: fmt(a.score_s),
      [F.completed]: (o.date || new Date().toISOString()).slice(0, 10),
      [F.status]: STATUS.approved
    };
    // A score the audit did not produce is left alone rather than blanked. An
    // empty cell and a cell we overwrote with nothing look identical later.
    Object.keys(fields).forEach(k => { if (fields[k] == null) delete fields[k]; });

    // No PDF yet means the reviewer has not saved one -- the run deliberately
    // does not build a report nobody has looked at. Say so instead of writing
    // a link to nothing.
    let urlNote = null;
    if (pushReportUrl === false) urlNote = 'report link not pushed (switched off)';
    else if (o.reportUrl) fields[F.reportUrl] = o.reportUrl;
    else urlNote = 'no saved PDF for this audit, so AUDIT REPORT URLS was left as it was';

    await at('/' + encodeURIComponent(o.recordId), {
      method: 'PATCH', body: JSON.stringify({ fields }) });
    return { recordId: o.recordId, wrote: Object.keys(fields).length, urlNote };
  }

  // A link to the stored report that is still alive when somebody clicks it.
  // /history/pdf signs for ten minutes, which is right for a download button
  // and useless in a database row.
  async function reportLink(pdfPath, bucket, supabaseUrl) {
    if (!pdfPath) return null;
    const d = await sbJson('/storage/v1/object/sign/' + bucket + '/' +
      encodeURI(pdfPath), { method: 'POST',
      body: JSON.stringify({ expiresIn: Math.round(urlDays * 86400) }) });
    return d && d.signedURL ? supabaseUrl + '/storage/v1' + d.signedURL : null;
  }

  return {
    F, STATUS, DEAD_STAGES, NOT_A_SITE,
    normaliseSite, formula, triage,
    watermark, setWatermark, candidates,
    setStatus, pushApproved, reportLink,
    configured: () => !!(token && baseId && tableId)
  };
}

module.exports = { makeAirtable, normaliseSite, makeFormatter, parseBands, F, STATUS, DEAD_STAGES };
