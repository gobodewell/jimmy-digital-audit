// The Airtable loop. The half that can do damage is the trigger, so that is
// where most of this is aimed.
//
// The live base holds 2,699 rows with Catelogue = Audit and 1,038 with ASSIGNED
// FOR AUDIT ticked. Neither means "audit this now", and 83 of the Audit rows
// have no score and no report URL while being dead records -- "removed from
// list (error or duplicate)", "ON HOLD", one with a LinkedIn profile where the
// website should be. A poller that keyed off field values would have queued
// them. The fence is CREATED time against a mark seeded at first run, and these
// checks are what hold that fence in place.
process.env.ANTHROPIC_KEY = 't'; process.env.PORT = '3987';
delete process.env.AUDIT_KEY;
process.env.SUPABASE_URL = 'https://proj.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'sb_secret_abcd';
process.env.AIRTABLE_TOKEN = 'pat_test';
process.env.AIRTABLE_BASE = 'appTEST0000000000';
process.env.AIRTABLE_TABLE = 'tblTEST0000000000';
process.env.AIRTABLE_POLL = 'off';          // no background timer during tests

let failures = 0;
const check = (l, c, d) => {
  console.log((c ? '  PASS  ' : '  FAIL  ') + l + (d ? '   -> ' + d : ''));
  if (!c) failures++;
};

const AT = require('../airtable.js');
const { normaliseSite, makeFormatter, STATUS, F } = AT;

// ── A. the website field, as it actually arrives ────────────────────────────
console.log('\nA. the WEBSITE column is not a clean URL');
const ok = s => normaliseSite(s).url;
check('a bare domain gets a scheme',
      ok('greencpa.pro') === 'https://greencpa.pro/', ok('greencpa.pro'));
check('a leading space is not part of the host',
      ok(' https://www.powellfinancialpartners.com/') ===
      'https://www.powellfinancialpartners.com/', ok(' https://www.powellfinancialpartners.com/'));
check('a trailing full stop is punctuation, not a domain label',
      ok('www.millerickassociates.com.') === 'https://www.millerickassociates.com/',
      ok('www.millerickassociates.com.'));
check('SHOUTING is still a host',
      ok('WWW.STRATEGIZEWMG.COM') === 'https://www.strategizewmg.com/',
      ok('WWW.STRATEGIZEWMG.COM'));
check('a query string survives',
      ok('http://www.advisorsq.com/index.cfm?&disclaimer=accept')
        .includes('disclaimer=accept'));
// The one that matters: there is a real row with this in WEBSITE.
const li = normaliseSite('https://www.linkedin.com/in/chuck-cory-a87a8655/');
check('a LinkedIn profile is refused, not audited', !!li.reject && !li.url, li.reject);
check('and the refusal says what it is',
      /linkedin\.com profile/.test(li.reject || ''), li.reject);
check('an empty cell is refused', !!normaliseSite('').reject);
check('a null cell is refused', !!normaliseSite(null).reject);
check('mailto: is not a website', !!normaliseSite('mailto:a@b.com').reject);
check('a single word is not a domain', !!normaliseSite('tbd').reject,
      JSON.stringify(normaliseSite('tbd')));

// ── B. the watermark is the fence, and it is checked twice ──────────────────
console.log('\nB. nothing created before the mark can be taken');
let sbReply = async () => null;
const A = AT.makeAirtable({
  token: 'pat_test', baseId: 'appTEST0000000000', tableId: 'tblTEST0000000000',
  sbJson: (...a) => sbReply(...a), log: () => {}
});

const since = '2026-10-06T12:00:00.000Z';
const row = (id, created, over) => ({
  id, createdTime: created,
  fields: Object.assign({
    [F.company]: 'Test Firm', [F.website]: 'https://example.com',
    [F.city]: 'Dallas, TX'
  }, over || {})
});

// Airtable's formula already filters on CREATED_TIME, but a formula is somebody
// else's date parser. If it ever returns an old row, triage must still refuse it.
let t = A.triage([
  row('recNEW', '2026-10-06T13:00:00.000Z'),
  row('recOLD', '2026-09-21T17:12:55.000Z')      // a real dead row's timestamp
], since);
check('the new row is taken', t.take.length === 1 && t.take[0].recordId === 'recNEW',
      JSON.stringify(t.take.map(x => x.recordId)));
check('the old row is refused even though the query returned it',
      t.rejected.length === 1 && t.rejected[0].recordId === 'recOLD');
check('and the refusal says why',
      /before the watermark/.test(t.rejected[0].why), t.rejected[0].why);

t = A.triage([row('recSAME', since)], since);
check('a row created exactly on the mark is not taken (the mark is exclusive)',
      t.take.length === 0 && t.rejected.length === 1);

console.log('\nC. a row a human has already written off is not taken');
for (const stage of ['removed from list (error or duplicate)', 'ON HOLD',
                     'Canceled Project']) {
  const r = A.triage([row('r1', '2026-10-06T13:00:00.000Z',
    { [F.stage]: { id: 'sel1', name: stage } })], since);
  check('STAGE "' + stage + '" is refused',
        r.take.length === 0 && /STAGE is/.test(r.rejected[0].why), r.rejected[0].why);
}
t = A.triage([row('r2', '2026-10-06T13:00:00.000Z',
  { [F.stage]: { id: 'sel1', name: 'PHASE 1 KICKOFF' } })], since);
check('a live STAGE is not refused', t.take.length === 1);

console.log('\nD. nothing is skipped silently');
t = A.triage([row('rx', '2026-10-06T13:00:00.000Z', { [F.website]: 'tbd' })], since);
check('a row we will not audit comes back with a reason attached',
      t.rejected.length === 1 && !!t.rejected[0].why && !!t.rejected[0].recordId,
      JSON.stringify(t.rejected[0]));
check('the city comes through when it is there',
      A.triage([row('rc', '2026-10-06T13:00:00.000Z')], since).take[0].clientCity
        === 'Dallas, TX');
check('and a missing city is empty rather than undefined',
      A.triage([row('rc', '2026-10-06T13:00:00.000Z', { [F.city]: null })], since)
        .take[0].clientCity === '');

// ── E. scores: what gets written into four text fields ──────────────────────
console.log('\nE. the Index Score fields');
check('the default is the number the audit measured',
      makeFormatter('number')(92) === '92');
let threw = null;
try { makeFormatter('grade', ''); } catch (e) { threw = e.message; }
check('grades without bands throw rather than inventing boundaries',
      !!threw && /AIRTABLE_GRADE_BANDS/.test(threw), threw);
check('grades with bands work',
      makeFormatter('grade', '90:A,80:B,70:C,60:D')(85) === 'B');
check('number+grade carries both',
      makeFormatter('number+grade', '90:A,80:B,70:C,60:D')(92) === '92 (A)');
check('a score below every band still gets the lowest grade, not undefined',
      makeFormatter('grade', '90:A,80:B')(10) === 'B');
threw = null;
try { makeFormatter('letters', '90:A'); } catch (e) { threw = e.message; }
check('an unknown format is a startup error', !!threw, threw);

// ── F. the push ────────────────────────────────────────────────────────────
console.log('\nF. pushing an approved audit back');
let patched = null;
const realFetch = global.fetch;
global.fetch = async (u, o) => {
  const s = String(u);
  if (s.includes('api.airtable.com')) {
    patched = { url: s, method: o.method, body: JSON.parse(o.body || '{}') };
    return new Response(JSON.stringify({ id: 'recX', fields: {} }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return realFetch(u, o);
};

(async () => {
  let r = await A.pushApproved({
    recordId: 'recX',
    audit: { score_overall: 92, score_v: 88, score_w: 95, score_s: 79 },
    reportUrl: 'https://proj.supabase.co/storage/v1/object/sign/x.pdf?token=t',
    date: '2026-10-06T09:00:00.000Z'
  });
  const f = patched.body.fields;
  check('one PATCH, so the row is never half written', patched.method === 'PATCH');
  check('the overall score goes in', f[F.scoreAll] === '92', f[F.scoreAll]);
  check('visibility goes to the visibility field', f[F.scoreVis] === '88');
  check('website goes to the website field', f[F.scoreWeb] === '95');
  check('social goes to the social field', f[F.scoreSoc] === '79');
  check('the date is a date, not a timestamp', f[F.completed] === '2026-10-06',
        f[F.completed]);
  check('the status says Approved', f[F.status] === STATUS.approved);
  check('the report link goes in', !!f[F.reportUrl]);
  check('nothing else is touched — six fields plus the URL',
        Object.keys(f).length === 7, Object.keys(f).join(','));

  // A score the audit never produced must not blank a cell. An empty cell and
  // a cell we overwrote with nothing are indistinguishable afterwards.
  patched = null;
  r = await A.pushApproved({ recordId: 'recX',
    audit: { score_overall: 92, score_v: null, score_w: undefined, score_s: 70 } });
  const g = patched.body.fields;
  check('a missing section score is left alone, not blanked',
        !(F.scoreVis in g) && !(F.scoreWeb in g), Object.keys(g).join(','));
  check('the scores that exist are still written',
        g[F.scoreAll] === '92' && g[F.scoreSoc] === '70');
  check('no PDF means AUDIT REPORT URLS is untouched and said so',
        !(F.reportUrl in g) && /no saved PDF/.test(r.urlNote || ''), r.urlNote);

  // ── G. Cancelled, which the field may not have an option for ─────────────
  console.log('\nG. a status the field has no option for');
  let calls = [];
  global.fetch = async (u, o) => {
    const s = String(u);
    if (s.includes('api.airtable.com')) {
      const body = JSON.parse(o.body || '{}');
      calls.push(body.fields[F.status]);
      if (body.fields[F.status] === 'Cancelled')
        return new Response(JSON.stringify({ error: {
          type: 'INVALID_MULTIPLE_CHOICE_OPTIONS',
          message: 'Insufficient permissions to create new select option "Cancelled"' } }),
          { status: 422, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ id: 'recX' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(u, o);
  };
  const res = await A.setStatus('recX', 'cancelled');
  check('a reviewer dropping an audit is not blocked by a missing dropdown entry',
        res === null, String(res));
  check('it tried the option, then cleared the cell',
        calls.length === 2 && calls[0] === 'Cancelled' && calls[1] === null,
        JSON.stringify(calls));

  // But a genuine Airtable failure on a status that DOES exist must surface.
  calls = [];
  global.fetch = async (u, o) => {
    if (String(u).includes('api.airtable.com'))
      return new Response(JSON.stringify({ error: { type: 'AUTHENTICATION_REQUIRED',
        message: 'Invalid authentication token' } }),
        { status: 401, headers: { 'Content-Type': 'application/json' } });
    return realFetch(u, o);
  };
  threw = null;
  try { await A.setStatus('recX', 'running'); } catch (e) { threw = e.message; }
  check('a real failure is not swallowed', !!threw && /authentication/i.test(threw),
        threw);

  // An HTML error page from a gateway must not come back as a parse crash --
  // the same shape of bug that marked a finished audit as failed.
  global.fetch = async (u, o) => {
    if (String(u).includes('api.airtable.com'))
      return new Response('<html>502 Bad Gateway</html>', { status: 502 });
    return realFetch(u, o);
  };
  threw = null;
  try { await A.setStatus('recX', 'running'); } catch (e) { threw = e.message; }
  check('an HTML error page is reported as one, with the status',
        !!threw && /not JSON/.test(threw) && /502/.test(threw), threw);

  // ── H. the watermark seeds itself and takes nothing ─────────────────────
  console.log('\nH. the first ever pass');
  let wrote = null;
  sbReply = async (path, opts) => {
    if (path.includes('app_settings') && (!opts || opts.method !== 'POST')) return [];
    if (path.includes('app_settings')) { wrote = JSON.parse(opts.body); return null; }
    return null;
  };
  const w = await A.watermark();
  check('with no mark stored it returns nothing to search from', w === null, String(w));
  check('and seeds the mark to now, so existing rows stay out of reach',
        !!wrote && wrote.key === 'airtable_watermark' &&
        Math.abs(Date.now() - Date.parse(wrote.value)) < 5000, JSON.stringify(wrote));

  sbReply = async () => [{ value: '2026-10-06T12:00:00+00:00' }];
  check('a stored mark is read back as an ISO instant',
        (await A.watermark()) === '2026-10-06T12:00:00.000Z', await A.watermark());

  // ── I. the formula ──────────────────────────────────────────────────────
  console.log('\nJ. a row with no website is reported, never hidden');
{
  // The obvious condition, {WEBSITE}!='', made the one thing somebody needs to
  // be told invisible: Airtable never returned the row, so it could not be
  // refused with a reason, and the pass said "candidates: 0" about a request
  // sitting right there waiting for a URL.
  const t2 = A.triage([row('recNoSite', '2026-10-06T13:00:00.000Z',
    { [F.website]: '' })], since);
  check('it comes back refused rather than not coming back at all',
        t2.take.length === 0 && t2.rejected.length === 1,
        JSON.stringify(t2.rejected));
  check('with a reason a person can act on',
        /no website on the record/.test(t2.rejected[0].why), t2.rejected[0].why);
  check('and marked fixable, so the watermark will not step over it',
        t2.rejected[0].fixable === true, JSON.stringify(t2.rejected[0]));

  const t3 = A.triage([row('recLinkedIn', '2026-10-06T13:00:00.000Z',
    { [F.website]: 'https://www.linkedin.com/in/someone/' })], since);
  check('an unusable URL is fixable too — somebody can paste the right one',
        t3.rejected[0].fixable === true, JSON.stringify(t3.rejected[0]));

  const t4 = A.triage([row('recDead', '2026-10-06T13:00:00.000Z',
    { [F.stage]: { id: 's', name: 'Canceled Project' } })], since);
  check('but a dead STAGE is a decision, not something to keep raising',
        !t4.rejected[0].fixable, JSON.stringify(t4.rejected[0]));
}

console.log('\nI. the query sent to Airtable');
  const fx = A.formula(since);
  check('it asks for Catelogue = Audit', fx.includes("{Catelogue}='Audit'"), fx);
  check('it asks for an empty AUDIT STATUS', fx.includes("{AUDIT STATUS}=''"));
  check('it does NOT filter on the website — a row without one has to come ' +
        'back so it can be refused out loud',
        !fx.includes("{WEBSITE}"), fx);
  check('it fences on CREATED_TIME', fx.includes('IS_AFTER(CREATED_TIME()'));

  console.log();
  console.log(failures ? failures + ' check(s) failed' : 'all checks passed');
  process.exit(failures ? 1 : 0);
})();
