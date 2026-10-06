// The poll pass and the approval push, through the real routes.
//
// Two orderings are load-bearing here and neither is obvious:
//
//  1. AUDIT STATUS is written BEFORE the job row is created. If that write
//     fails the pass stops having queued nothing. The other order looks safer
//     and is not: a job with no mark gets picked up again on the next pass and
//     the audit runs -- and is billed -- twice. A row marked Queued with no job
//     is a visible stuck cell somebody can clear.
//
//  2. The watermark only advances over rows that were dealt with. It never
//     steps past a row the pass could not handle, so a bad pass costs a delay
//     rather than a lost audit.
process.env.ANTHROPIC_KEY = 't'; process.env.PORT = '3988';
delete process.env.AUDIT_KEY;
process.env.SUPABASE_URL = 'https://proj.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'sb_secret_abcd';
process.env.AIRTABLE_TOKEN = 'pat_test';
process.env.AIRTABLE_BASE = 'appTEST0000000000';
process.env.AIRTABLE_TABLE = 'tblTEST0000000000';
process.env.AIRTABLE_POLL = 'off';        // the timer must not fire during tests

let failures = 0;
const check = (l, c, d) => {
  console.log((c ? '  PASS  ' : '  FAIL  ') + l + (d ? '   -> ' + d : ''));
  if (!c) failures++;
};

const { F } = require('../airtable.js');
const SINCE = '2026-10-06T12:00:00.000Z';

// What the fakes do, reassigned per section.
let airtableGet, airtablePatch, sbHandler;
let calls = [];

const realFetch = global.fetch;
global.fetch = async (u, o) => {
  const s = String(u); const m = (o && o.method) || 'GET';
  if (s.includes('api.airtable.com')) {
    calls.push({ who: 'airtable', method: m,
                 body: o && o.body ? JSON.parse(o.body) : null, url: s });
    const r = m === 'GET' ? airtableGet(s) : airtablePatch(s, JSON.parse(o.body));
    return r;
  }
  if (s.includes('proj.supabase.co')) {
    const path = s.replace('https://proj.supabase.co', '');
    calls.push({ who: 'sb', method: m, path,
                 body: o && o.body ? JSON.parse(o.body) : null });
    return sbHandler(path, m, o);
  }
  return realFetch(u, o);
};
require('../server.js');

const json = (d, status) => new Response(JSON.stringify(d),
  { status: status || 200, headers: { 'Content-Type': 'application/json' } });

const post = async (path, body) => {
  const r = await realFetch('http://127.0.0.1:3988' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}) });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, json: j, text: t };
};

const rec = (id, created, over) => ({
  id, createdTime: created,
  fields: Object.assign({ [F.company]: 'Firm ' + id,
    [F.website]: 'https://' + id.toLowerCase() + '.com' }, over || {})
});

// The default Supabase behaviour: a stored watermark, and inserts that work.
function sbNormal(extra) {
  return (path, m, o) => {
    // The override goes first. It used to come last, after the success branch
    // for audit_jobs, so an injected insert failure was never actually injected
    // and three checks passed against a case that had not been exercised.
    if (extra) { const r = extra(path, m, o); if (r) return r; }
    if (path.includes('app_settings') && m === 'GET') return json([{ value: SINCE }]);
    if (path.includes('app_settings')) return new Response(null, { status: 204 });
    if (path.includes('audit_jobs') && m === 'POST')
      return json([{ id: 'job-' + (JSON.parse(o.body)[0].external_ref) }]);
    return json([]);
  };
}

setTimeout(async () => {
  // ── A. the happy pass ─────────────────────────────────────────────────────
  console.log('\nA. two new rows become two queued jobs');
  calls = [];
  airtableGet = () => json({ records: [
    rec('recA', '2026-10-06T13:00:00.000Z', { [F.city]: 'Dallas, TX' }),
    rec('recB', '2026-10-06T14:00:00.000Z')
  ] });
  airtablePatch = () => json({ id: 'ok' });
  sbHandler = sbNormal();

  let r = await post('/airtable/poll');
  check('the pass succeeds', r.status === 200, r.status + ' ' + r.text.slice(0, 120));
  check('both rows are queued', r.json && r.json.taken === 2,
        JSON.stringify(r.json && r.json.queued));
  check('the city is carried through to the job',
        r.json.queued[0].city === 'Dallas, TX', r.json.queued[0].city);
  check('a row with no city queues anyway rather than being skipped',
        r.json.queued[1].city === null || r.json.queued[1].city === '',
        JSON.stringify(r.json.queued[1]));
  check('each job records which Airtable row it came from',
        calls.filter(c => c.who === 'sb' && c.path.includes('audit_jobs') &&
          c.method === 'POST').every(c => !!c.body[0].external_ref));
  check('the watermark advances to the newest row handled',
        r.json.watermark === '2026-10-06T14:00:00.000Z', r.json.watermark);

  // The ordering. Find the first status write and the first insert.
  const order = calls.filter(c =>
    (c.who === 'airtable' && c.method === 'PATCH') ||
    (c.who === 'sb' && c.path.includes('audit_jobs') && c.method === 'POST'));
  check('Airtable is marked BEFORE the job exists, not after',
        order[0] && order[0].who === 'airtable',
        order.map(c => c.who).join(' -> '));

  // ── B. Airtable unreachable: queue nothing ───────────────────────────────
  console.log('\nB. if the row cannot be marked, nothing is queued');
  calls = [];
  airtablePatch = () => json({ error: { type: 'AUTHENTICATION_REQUIRED',
    message: 'Invalid authentication token' } }, 401);
  sbHandler = sbNormal();

  r = await post('/airtable/poll');
  check('the pass reports that it stopped', r.status === 200 && !!r.json.stopped,
        r.json && r.json.stopped);
  check('and queued nothing at all', r.json.taken === 0, String(r.json.taken));
  check('no job row was created — no audit will be billed twice',
        !calls.some(c => c.who === 'sb' && c.path.includes('audit_jobs') &&
          c.method === 'POST'));
  check('the watermark did not move, so the rows come back next pass',
        r.json.watermark === SINCE, r.json.watermark);

  // ── C. the insert fails: the row is marked, not left saying Queued ───────
  console.log('\nC. if the job cannot be created the row does not lie');
  calls = [];
  airtableGet = () => json({ records: [rec('recC', '2026-10-06T13:00:00.000Z')] });
  airtablePatch = () => json({ id: 'ok' });
  sbHandler = sbNormal((path, m) => {
    if (path.includes('audit_jobs') && m === 'POST')
      return json({ message: 'relation overloaded' }, 500);
  });

  r = await post('/airtable/poll');
  check('the problem is reported rather than swallowed',
        r.json.problems && r.json.problems.length === 1,
        JSON.stringify(r.json.problems));
  check('nothing is claimed as queued', r.json.taken === 0);
  const marks = calls.filter(c => c.who === 'airtable' && c.method === 'PATCH')
                     .map(c => c.body.fields[F.status]);
  check('the row ends up Failed, not stuck on Queued',
        marks[marks.length - 1] === 'Failed', JSON.stringify(marks));
  check('the watermark moves past it — it has been dealt with, visibly',
        r.json.watermark === '2026-10-06T13:00:00.000Z', r.json.watermark);

  // ── D. a duplicate is not a failure ──────────────────────────────────────
  console.log('\nD. a site already queued');
  calls = [];
  sbHandler = sbNormal((path, m) => {
    if (path.includes('audit_jobs') && m === 'POST')
      return json({ message: 'duplicate key value violates unique constraint' }, 409);
  });
  r = await post('/airtable/poll');
  check('it is reported as already queued, not as an error to chase',
        /already queued/.test(JSON.stringify(r.json.problems)),
        JSON.stringify(r.json.problems));
  const dmarks = calls.filter(c => c.who === 'airtable' && c.method === 'PATCH')
                      .map(c => c.body.fields[F.status]);
  check('and the row stays Queued rather than being marked Failed',
        dmarks[dmarks.length - 1] === 'Queued', JSON.stringify(dmarks));

  // ── D2. the watermark can never walk backwards ───────────────────────────
  console.log('\nD2. an old row in the result does not drag the mark back');
  calls = [];
  // The fence is the only thing keeping 83 dead records out, and it is a stored
  // timestamp. If a refused-as-stale row could move the mark onto its own
  // createdTime, the next pass would return more old rows, refuse those too,
  // move back further, and walk down into them. Nothing causes that today --
  // the query has never returned an old row -- which is not a guarantee.
  airtableGet = () => json({ records: [
    rec('recOLD1', '2026-09-21T17:12:55.000Z'),   // a real dead row's timestamp
    rec('recOLD2', '2024-05-01T00:00:00.000Z')
  ] });
  airtablePatch = () => json({ id: 'ok' });
  sbHandler = sbNormal();
  r = await post('/airtable/poll');
  check('both old rows are refused', r.json.rejected.length === 2,
        JSON.stringify(r.json.rejected));
  check('and the watermark is exactly where it was',
        r.json.watermark === SINCE, r.json.watermark);
  check('nothing was queued and nothing was marked in Airtable',
        r.json.taken === 0 && !calls.some(c => c.who === 'airtable' && c.method === 'PATCH'),
        JSON.stringify(calls.filter(c => c.who === 'airtable').map(c => c.method)));
  check('and no watermark write was sent at all',
        !calls.some(c => c.who === 'sb' && c.path.includes('app_settings') &&
                    c.method === 'POST' && c.body &&
                    c.body.key === 'airtable_watermark'),
        JSON.stringify(calls.filter(c => c.who === 'sb' && c.method === 'POST')
          .map(c => c.body && c.body.key)));

  // A new row mixed in with old ones: the mark lands on the new one only.
  calls = [];
  airtableGet = () => json({ records: [
    rec('recOLD3', '2024-05-01T00:00:00.000Z'),
    rec('recNEW1', '2026-10-06T13:00:00.000Z'),
    rec('recOLD4', '2025-01-01T00:00:00.000Z')
  ] });
  r = await post('/airtable/poll');
  check('the new row is queued and the old ones are not', r.json.taken === 1 &&
        r.json.queued[0].recordId === 'recNEW1', JSON.stringify(r.json.queued));
  check('the mark moves forward to the new row, not back to the old ones',
        r.json.watermark === '2026-10-06T13:00:00.000Z', r.json.watermark);

  console.log('\nD3. the pass records what it did where it can be read');
  const note = calls.filter(c => c.who === 'sb' && c.method === 'POST' &&
    c.path.includes('app_settings') && c.body &&
    c.body.key === 'airtable_last_poll').pop();
  check('a summary of the pass is written to the database',
        !!note, JSON.stringify(calls.filter(c => c.who === 'sb' && c.method === 'POST')
          .map(c => c.body && c.body.key)));
  check('and it carries the refusals, not just a count',
        !!note && /created before the watermark/.test(note.body.value),
        note && note.body.value.slice(0, 200));

  // ── E. the first ever pass takes nothing ─────────────────────────────────
  console.log('\nE. the first pass on a fresh deploy');
  calls = [];
  sbHandler = (path, m, o) => {
    if (path.includes('app_settings') && m === 'GET') return json([]);   // no mark
    if (path.includes('app_settings')) return new Response(null, { status: 204 });
    return json([]);
  };
  r = await post('/airtable/poll');
  check('it seeds the mark and takes nothing',
        r.json.seeded === true && r.json.taken === 0, JSON.stringify(r.json));
  check('it does not even ask Airtable for rows — the 2,699 stay out of reach',
        !calls.some(c => c.who === 'airtable'),
        JSON.stringify(calls.map(c => c.who)));

  // ── E2. the queue starts itself ──────────────────────────────────────────
  // The empty case goes FIRST. The next check starts a real drain, and a drain
  // outlives the request that began it -- so asking "did it decline to start?"
  // afterwards gets "already running" and tests nothing.
  console.log('\nE2. nothing waiting means nothing is started');
  calls = [];
  airtableGet = () => json({ records: [] });
  sbHandler = sbNormal((p2, m) => {
    if (p2.includes('audit_jobs') && p2.includes('status=eq.queued') && m === 'GET')
      return json([]);          // empty queue
  });
  let r2 = await post('/airtable/poll');
  check('it says there was nothing queued rather than starting a drain',
        r2.json.autorun && /nothing queued/.test(r2.json.autorun.skipped || ''),
        JSON.stringify(r2.json.autorun));

  console.log('\nE3. a queued job runs without anybody pressing Run');
  calls = [];
  airtableGet = () => json({ records: [rec('recAR', '2026-10-06T13:00:00.000Z')] });
  airtablePatch = () => json({ id: 'ok' });
  sbHandler = sbNormal((p2, m) => {
    if (p2.includes('audit_jobs') && p2.includes('status=eq.queued') && m === 'GET')
      return json([{ id: 'job-waiting' }]);
  });
  r2 = await post('/airtable/poll');
  check('the poll starts the drain itself', r2.json.autorun &&
        r2.json.autorun.started === true, JSON.stringify(r2.json.autorun));
  check('and says what started it, so an unattended run is attributable',
        r2.json.autorun.why === 'queue autorun', r2.json.autorun.why);

  // A second pass while that drain is still going must not start another.
  r2 = await post('/airtable/poll');
  check('a second pass does not start a competing drain',
        /already running/.test((r2.json.autorun || {}).skipped || ''),
        JSON.stringify(r2.json.autorun));
  await post('/queue/stop');

  console.log('\nE4. the decision is visible and can be switched off');
  const srv = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'server.js'), 'utf8');
  check('QUEUE_AUTORUN turns it off without a code change',
        /QUEUE_AUTORUN\s*=\s*env\('QUEUE_AUTORUN'\)\s*!==\s*'off'/.test(srv));
  check('health reports whether the queue starts itself',
        /autorun: QUEUE_AUTORUN/.test(srv));
  check('autorun runs even when the Airtable poll threw — queued work does ' +
        'not depend on Airtable being up',
        /Deliberately outside that catch/.test(srv));
  check('and it starts on anything waiting, not only on what this pass added, ' +
        'so a restart cannot strand a job',
        /status=eq\.queued&select=id&limit=1/.test(srv));

  // ── F. moving the mark backwards is capped ───────────────────────────────
  console.log('\nF. the watermark cannot be moved carelessly into the past');
  sbHandler = sbNormal();
  r = await post('/airtable/watermark', { at: '2024-01-01T00:00:00Z' });
  check('a mark years back is refused', r.status === 400, r.status + ' ' + r.text.slice(0, 80));
  check('and the refusal says what it would have done',
        /83/.test(r.text) && /force/.test(r.text), r.text.slice(0, 160));
  r = await post('/airtable/watermark', { at: '2024-01-01T00:00:00Z', force: true });
  check('force gets through, because sometimes you do mean it', r.status === 200);
  r = await post('/airtable/watermark', { at: 'yesterdayish' });
  check('a date nobody can parse is refused', r.status === 400);

  // ── G. approval pushes; a failed push does not un-approve ────────────────
  console.log('\nG. approving an audit');
  calls = [];
  const JOB = { id: 'job-1', external_ref: 'recA', audit_id: 'aud-1', pushed_at: null };
  const AUDIT = { id: 'aud-1', score_overall: 92, score_v: 88, score_w: 95,
                  score_s: 79, pdf_path: 'firm/report.pdf' };
  sbHandler = (path, m, o) => {
    if (path.includes('audit_jobs') && m === 'PATCH') return json([JOB]);
    if (path.includes('audit_jobs')) return json([JOB]);
    if (path.includes('/rest/v1/audits')) return json([AUDIT]);
    if (path.includes('/storage/v1/object/sign'))
      return json({ signedURL: '/object/sign/audit-reports/firm/report.pdf?token=t' });
    return json([]);
  };
  airtablePatch = () => json({ id: 'recA' });

  r = await post('/queue/status', { id: 'job-1', status: 'approved' });
  check('the approval succeeds', r.status === 200, r.status + ' ' + r.text.slice(0, 120));
  check('and the result went to Airtable', !!r.json.push && r.json.push.ok === true,
        JSON.stringify(r.json.push));
  const pushed = calls.filter(c => c.who === 'airtable').pop();
  check('all four scores were written',
        pushed.body.fields[F.scoreAll] === '92' &&
        pushed.body.fields[F.scoreVis] === '88' &&
        pushed.body.fields[F.scoreWeb] === '95' &&
        pushed.body.fields[F.scoreSoc] === '79', JSON.stringify(pushed.body.fields));
  check('with the completion date', !!pushed.body.fields[F.completed]);
  const signed = calls.find(c => c.who === 'sb' && c.path.includes('object/sign'));
  check('the report link is signed for years, not the ten minutes a download needs',
        signed && signed.body.expiresIn >= 86400 * 365, JSON.stringify(signed && signed.body));

  console.log('\nH. Airtable down at the moment of approval');
  calls = [];
  airtablePatch = () => new Response('<html>502</html>', { status: 502 });
  r = await post('/queue/status', { id: 'job-1', status: 'approved' });
  check('the approval still succeeds — the reviewer approved it',
        r.status === 200, r.status + ' ' + r.text.slice(0, 120));
  check('the failure is reported, not hidden', !!(r.json.push && r.json.push.error),
        JSON.stringify(r.json.push));
  check('and it says how to retry', /airtable\/push/.test(JSON.stringify(r.json.push)),
        JSON.stringify(r.json.push));
  check('the failure is recorded against the job and nowhere else',
        calls.some(c => c.who === 'sb' && c.method === 'PATCH' &&
                   c.body && 'push_error' in c.body),
        JSON.stringify(calls.filter(c => c.method === 'PATCH' && c.who === 'sb')
          .map(c => Object.keys(c.body || {}))));

  console.log('\nI. pushing the same audit twice');
  calls = [];
  airtablePatch = () => json({ id: 'recA' });
  sbHandler = (path, m) => {
    if (path.includes('audit_jobs'))
      return json([Object.assign({}, JOB, { pushed_at: '2026-10-06T10:00:00Z' })]);
    if (path.includes('/rest/v1/audits')) return json([AUDIT]);
    return json([]);
  };
  r = await post('/airtable/push', { jobId: 'job-1' });
  check('a second push is refused rather than restamping the row',
        r.status === 200 && /already pushed/.test(JSON.stringify(r.json)),
        JSON.stringify(r.json));
  check('and it wrote nothing to Airtable', !calls.some(c => c.who === 'airtable'));
  r = await post('/airtable/push', { jobId: 'job-1', force: true });
  check('force re-pushes, for repairing a half-failed write', r.status === 200 &&
        calls.some(c => c.who === 'airtable'), JSON.stringify(r.json));

  console.log('\nJ. a job that did not come from Airtable');
  calls = [];
  sbHandler = (path, m) => {
    if (path.includes('audit_jobs'))
      return json([{ id: 'job-2', external_ref: null, audit_id: 'aud-1' }]);
    if (path.includes('/rest/v1/audits')) return json([AUDIT]);
    return json([]);
  };
  r = await post('/queue/status', { id: 'job-2', status: 'approved' });
  check('approving a hand-added audit does not try to write to Airtable',
        r.status === 200 && !calls.some(c => c.who === 'airtable'),
        JSON.stringify(r.json.push));

  console.log();
  console.log(failures ? failures + ' check(s) failed' : 'all checks passed');
  process.exit(failures ? 1 : 0);
}, 400);
