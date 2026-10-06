// What gets pushed to Airtable after a review.
//
// The queue exists to stop at needs_review: the headless run gets what it can
// reach, and a person fills the rest, corrects what it got wrong, and approves.
// That is the whole design. It was also, until this file, entirely cosmetic at
// the point of delivery.
//
// A save INSERTS a new audits row; it never updates. queueOpen(auditId, jobId)
// took the job id and threw it away. So a reviewed audit became a NEW row while
// the job still pointed at the run's original one, and approving pushed the
// unreviewed scores to Airtable with no report link -- the reviewer's work
// discarded at the last step, silently, with the row reading Approved.
process.env.ANTHROPIC_KEY = 't'; process.env.PORT = '3989';
delete process.env.AUDIT_KEY;
process.env.SUPABASE_URL = 'https://proj.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'sb_secret_abcd';
process.env.AIRTABLE_TOKEN = 'pat_test';
process.env.AIRTABLE_BASE = 'appTEST0000000000';
process.env.AIRTABLE_TABLE = 'tblTEST0000000000';
process.env.AIRTABLE_POLL = 'off';

const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (l, c, d) => {
  console.log((c ? '  PASS  ' : '  FAIL  ') + l + (d ? '   -> ' + d : ''));
  if (!c) failures++;
};

const { F } = require('../airtable.js');

let calls = [];
let sbHandler, airtablePatch;
const realFetch = global.fetch;
global.fetch = async (u, o) => {
  const s = String(u); const m = (o && o.method) || 'GET';
  if (s.includes('api.airtable.com')) {
    calls.push({ who: 'airtable', method: m, body: o && o.body ? JSON.parse(o.body) : null });
    return airtablePatch();
  }
  if (s.includes('proj.supabase.co')) {
    const p2 = s.replace('https://proj.supabase.co', '');
    calls.push({ who: 'sb', method: m, path: p2,
                 body: o && o.body && !(o.body instanceof Buffer)
                   ? (() => { try { return JSON.parse(o.body); } catch { return null; } })()
                   : null });
    return sbHandler(p2, m, o);
  }
  return realFetch(u, o);
};
require('../server.js');

const json = (d, st) => new Response(JSON.stringify(d),
  { status: st || 200, headers: { 'Content-Type': 'application/json' } });

const post = async (p2, body) => {
  const r = await realFetch('http://127.0.0.1:3989' + p2, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}) });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, json: j, text: t };
};

setTimeout(async () => {
  // ── A. the page keeps hold of which job it is reviewing ───────────────────
  console.log('\nA. the app remembers which queued job is on the tabs');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  check('queueOpen stores the job id instead of discarding it',
        /REVIEW_JOB\s*=\s*jobId/.test(html));
  check('a save sends it with the audit',
        /jobId:\s*REVIEW_JOB/.test(html));
  check('opening a plain history item clears it, so an unrelated save cannot ' +
        'be attributed to a queued job',
        /REVIEW_JOB\s*=\s*null;\s*\/\/ plain history open/.test(html));

  // The queue stops at needs_review so a person can say yes. For a while
  // nothing in the page could say it: /queue/status accepted `approved` and
  // did the Airtable push, and the only buttons on a row were Review, Try
  // again and Drop. The one action the whole design exists to collect had no
  // control at all.
  check('a row waiting for review offers Approve, not just Review and Drop',
        /queueSet\([^)]*approved/.test(html));
  check('and it says that approving pushes, when the job came from Airtable',
        /external_ref \? 'Approve &amp; push'/.test(html));

  // ── B. the save re-points the job ─────────────────────────────────────────
  console.log('\nB. a reviewed save becomes what the job means');
  calls = [];
  sbHandler = (p2, m) => {
    if (p2.includes('/rest/v1/audits') && m === 'POST') return json([{ id: 'audit-B' }]);
    if (p2.includes('/rest/v1/audit_jobs') && m === 'PATCH')
      return new Response(null, { status: 204 });
    return json([]);
  };
  let r = await post('/history/save', {
    clientUrl: 'https://totuswm.com/', clientName: 'Totus Test',
    state: { x: 1 }, scores: { overall: 96, v: 92, w: 98, s: 88 },
    jobId: 'job-1'
  });
  check('the audit files', r.status === 200 && r.json.id === 'audit-B',
        r.status + ' ' + r.text.slice(0, 120));
  const patch = calls.find(c => c.who === 'sb' && c.method === 'PATCH' &&
                                c.path.includes('audit_jobs'));
  check('and the job is re-pointed at the row the reviewer just saved',
        !!patch && patch.body.audit_id === 'audit-B',
        JSON.stringify(patch && patch.body));
  check('the response says so, rather than leaving it to be assumed',
        r.json.rePointed === 'job-1', JSON.stringify(r.json.rePointed));

  console.log('\nC. a save with no job attached touches no job');
  calls = [];
  r = await post('/history/save', {
    clientUrl: 'https://example.com/', state: { x: 1 },
    scores: { overall: 80, v: 80, w: 80, s: 80 } });
  check('a hand-run audit files normally', r.status === 200);
  check('and no job row is touched',
        !calls.some(c => c.who === 'sb' && c.method === 'PATCH' &&
                    c.path.includes('audit_jobs')),
        JSON.stringify(calls.filter(c => c.method === 'PATCH').map(c => c.path)));
  check('and it reports that nothing was re-pointed',
        r.json.rePointed === null, JSON.stringify(r.json.rePointed));

  console.log('\nD. a failed re-point does not lose the audit');
  calls = [];
  sbHandler = (p2, m) => {
    if (p2.includes('/rest/v1/audits') && m === 'POST') return json([{ id: 'audit-C' }]);
    if (p2.includes('/rest/v1/audit_jobs')) return json({ message: 'boom' }, 500);
    return json([]);
  };
  r = await post('/history/save', {
    clientUrl: 'https://totuswm.com/', state: { x: 1 },
    scores: { overall: 96, v: 92, w: 98, s: 88 }, jobId: 'job-1' });
  check('the audit is still filed', r.status === 200 && r.json.id === 'audit-C',
        r.status + ' ' + r.text.slice(0, 120));
  check('and the failure is visible rather than claimed as a success',
        r.json.rePointed === null, JSON.stringify(r.json.rePointed));

  // ── E. the end of the chain: approving pushes the REVIEWED numbers ────────
  console.log('\nE. approving pushes what the reviewer approved');
  calls = [];
  // The job now points at audit-B -- the reviewed row, with the reviewer's
  // corrected scores and the PDF they saved.
  const JOB = { id: 'job-1', external_ref: 'recT', audit_id: 'audit-B', pushed_at: null };
  const REVIEWED = { id: 'audit-B', score_overall: 96, score_v: 92, score_w: 98,
                     score_s: 88, pdf_path: 'totuswm.com/report.pdf' };
  sbHandler = (p2, m) => {
    if (p2.includes('audit_jobs')) return json([JOB]);
    if (p2.includes('/rest/v1/audits')) return json([REVIEWED]);
    if (p2.includes('/storage/v1/object/sign'))
      return json({ signedURL: '/object/sign/audit-reports/totuswm.com/report.pdf?token=t' });
    return json([]);
  };
  airtablePatch = () => json({ id: 'recT' });

  r = await post('/queue/status', { id: 'job-1', status: 'approved' });
  check('the approval succeeds', r.status === 200, r.status + ' ' + r.text.slice(0, 120));
  const sent = calls.filter(c => c.who === 'airtable').pop();
  check('the scores pushed are the REVIEWED ones, not the run\'s',
        !!sent && sent.body.fields[F.scoreAll] === '96' &&
        sent.body.fields[F.scoreVis] === '92' &&
        sent.body.fields[F.scoreWeb] === '98' &&
        sent.body.fields[F.scoreSoc] === '88',
        JSON.stringify(sent && sent.body.fields));
  check('and the report link is there, because the reviewer saved a PDF',
        !!sent && !!sent.body.fields[F.reportUrl],
        JSON.stringify(sent && sent.body.fields[F.reportUrl]));

  console.log();
  console.log(failures ? failures + ' check(s) failed' : 'all checks passed');
  process.exit(failures ? 1 : 0);
}, 400);
