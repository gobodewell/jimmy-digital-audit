// A run that could not support a score.
//
// Two things have to be true at once, and the first version got the second
// wrong by sacrificing it to the first:
//
//   1. No score is recorded. Writing 61 "Critical" into a firm's record
//      because the run reached nothing is the one outcome worth refusing.
//
//   2. The work is kept. The checks the run DID ground are real, and
//      discarding them makes a person start from scratch -- in practice on the
//      firms that most need the audit. A new firm legitimately fails most of
//      these checks; "you have no backlinks yet" is the finding, not a failure
//      to look.
//
// The old branch marked the job failed and returned before filing anything, so
// a reviewer opening the queue found a red row, no audit, and no way in.
const path = require('path');
const { makeQueue } = require('../queue.js');

let failures = 0;
const check = (l, c, d) => {
  console.log((c ? '  PASS  ' : '  FAIL  ') + l + (d ? '   -> ' + d : ''));
  if (!c) failures++;
};

const UNGROUNDED = {
  ungrounded: true, measured: 4, grounded: 19,
  silentlyFailed: new Array(21).fill('c-x'),
  state: { checks: [['c-a', false]] },
  report: { sections: [] },
  scores: { overall: 61, v: 60, w: 61, s: 62 },   // offered, and must be ignored
  unmeasured: []
};

function harness(opts) {
  const o = opts || {};
  const saved = [], finished = [], mirrored = [];
  const q = makeQueue({
    // Order matters: the claim is a PATCH on ?id=eq...&status=eq.queued, and
    // take() is a GET on ?status=eq.queued. Matching the status first answered
    // the claim with a job list and the whole drain took nothing.
    sbJson: async (p2, io) => {
      const method = (io && io.method) || 'GET';
      if (/audit_jobs\?id=eq/.test(p2) && method === 'PATCH') {
        const body = JSON.parse(io.body);
        if (body.status === 'running') return [{ id: 'job-1', attempts: 1 }];
        finished.push(body);
        return null;
      }
      if (/audit_jobs\?status=eq\.queued/.test(p2) && method === 'GET')
        return [{ id: 'job-1', client_name: 'Breeches Wealth',
          client_url: 'https://breecheswealth.com/', client_city: 'Mechanicsburg, PA',
          status: 'queued', attempts: 0, source: 'airtable', template: 'growthline' }];
      return [];
    },
    runAudit: async () => UNGROUNDED,
    saveAudit: async a => {
      saved.push(a);
      if (o.saveThrows) throw new Error('storage refused it');
      return { id: 'audit-X' };
    },
    onStatus: async (j, st) => mirrored.push(st),
    log: () => {}
  });
  return { q, saved, finished, mirrored };
}

(async () => {
  console.log('\nA. the run is filed, not discarded');
  let h = harness();
  let r = await h.q.drain({ batchSize: 1, pauseMs: 0, maxJobs: 1 });
  const res = r.results[0];
  check('it is parked for review, not marked failed',
        res.status === 'needs_review', JSON.stringify(res));
  check('and it says plainly that nothing was scored',
        res.ungrounded === true, JSON.stringify(res.ungrounded));
  check('an audit was actually filed, so there is something to open',
        h.saved.length === 1 && res.auditId === 'audit-X',
        JSON.stringify(res.auditId));
  check('the queue counts it as waiting for a person, not as a failure',
        r.needsReview === 1 && r.failed === 0,
        r.needsReview + ' waiting, ' + r.failed + ' failed');

  console.log('\nB. but no score is recorded');
  const a = h.saved[0];
  check('the scores the run offered are refused outright', a.scores === null,
        JSON.stringify(a.scores));
  check('and so are the KPI counts — a tally is a score too',
        a.kpisPassed === null && a.kpisTotal === null,
        a.kpisPassed + '/' + a.kpisTotal);
  check('the state is kept, so the 19 grounded checks survive',
        !!a.state, JSON.stringify(Object.keys(a.state || {})));
  check('the note on the record says why it was not scored, in numbers',
        /not scored automatically/.test(a.note || '') &&
        /19 of 40/.test(a.note || ''), a.note);

  console.log('\nC. the job row carries the reason');
  const fin = h.finished[h.finished.length - 1];
  check('the job is needs_review', fin.status === 'needs_review', fin.status);
  check('flagged ungrounded, so the page can say "nothing scored yet"',
        fin.ungrounded === true);
  check('with the explanation attached', /only 19 of 40/.test(fin.error || ''),
        fin.error);
  check('and Airtable is told it needs review, not that it failed',
        h.mirrored[h.mirrored.length - 1] === 'needs_review',
        JSON.stringify(h.mirrored));

  console.log('\nD. if filing fails there really is nothing to review');
  h = harness({ saveThrows: true });
  r = await h.q.drain({ batchSize: 1, pauseMs: 0, maxJobs: 1 });
  check('only then is it a failure', r.results[0].status === 'failed',
        JSON.stringify(r.results[0]));
  check('and the reason names both halves — unscored AND unfiled',
        /not scored automatically/.test(h.finished[h.finished.length - 1].error) &&
        /could not be filed/.test(h.finished[h.finished.length - 1].error),
        h.finished[h.finished.length - 1].error);

  console.log('\nE. the page tells the two apart');
  const page = require('fs').readFileSync(
    path.join(__dirname, '..', 'index.html'), 'utf8');
  check('an explanation on a row waiting for review is not printed as an error',
        /j\.status === 'needs_review' \? '#b45309' : 'var\(--red\)'/.test(page));
  check('and the row says nothing is scored yet',
        /nothing scored yet/.test(page));

  console.log();
  console.log(failures ? failures + ' check(s) failed' : 'all checks passed');
  process.exit(failures ? 1 : 0);
})();
