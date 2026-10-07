// Audits stack up and run in phases.
//
// Not all at once, because two things bite at about the same size: each audit
// is ~13 third-party API calls, and each holds a headless browser worth a few
// hundred MB. Fifty tickboxes at once would exhaust the rate limits and the
// instance together.
//
// And the resting state is needs_review, not done. A finished RUN is not a
// finished AUDIT: a person fills what the run could not reach and corrects what
// it got wrong. Nothing in here decides an audit is finished.
const path = require('path');
const { makeQueue } = require(path.join(__dirname, '..', 'queue.js'));
let failures = 0;
const check = (l, c, d) => { console.log((c?'  PASS  ':'  FAIL  ')+l+(d?'   -> '+d:'')); if(!c) failures++; };

// A fake Supabase holding rows in memory, so the queue's real SQL-shaped calls
// are exercised without a database.
function fakeDb(jobs) {
  const rows = jobs.map((j, i) => Object.assign(
    { id: 'job-' + i, status: 'queued', attempts: 0, priority: 0,
      created_at: new Date(Date.now() + i).toISOString(),
      client_name: 'Firm ' + i, client_city: '', source: 'airtable',
      template: 'growthline' }, j));
  const calls = [];
  const sbJson = async (url, opts) => {
    calls.push((opts && opts.method || 'GET') + ' ' + url.split('?')[0]);
    const m = /id=eq\.([^&]+)/.exec(url);
    if (opts && opts.method === 'PATCH') {
      const row = rows.find(r => r.id === m[1]);
      // The conditional claim: only if still queued.
      if (/status=eq\.queued/.test(url) && row.status !== 'queued') return [];
      Object.assign(row, JSON.parse(opts.body));
      return [row];
    }
    const lim = /limit=(\d+)/.exec(url);
    return rows.filter(r => r.status === 'queued').slice(0, lim ? +lim[1] : 50);
  };
  return { rows, sbJson, calls };
}

const okRun = (ms) => async () => {
  await new Promise(r => setTimeout(r, ms || 10));
  return { ungrounded: false, measured: 25, grounded: 38, silentlyFailed: [],
           unmeasured: [{id:'c-ga', why:'cloudflare'}],
           state: { checks: [] }, report: { firm:'x' },
           scores: { overall: 86, passed: 26, total: 40 } };
};

(async () => {
  console.log('\nA. a phase never runs more at once than it is told to');
  {
    const db = fakeDb(Array.from({length: 6}, () => ({ client_url: 'https://a'+Math.random()+'.com' })));
    let inFlight = 0, peak = 0;
    const q = makeQueue({ sbJson: db.sbJson, saveAudit: async () => ({ id: 'aud-1' }),
      runAudit: async (j) => { inFlight++; peak = Math.max(peak, inFlight);
        try { return await okRun(25)(j); } finally { inFlight--; } } });
    const r = await q.drain({ concurrency: 2, batchSize: 6, pauseMs: 0 });
    check('all six ran', r.ran === 6, String(r.ran));
    // The whole point: browsers are not requests. Six at once is six Chromiums.
    check('never more than two at a time', peak === 2, 'peak ' + peak);
    check('all six are waiting for a person', r.needsReview === 6, String(r.needsReview));
    check('and none were marked done', db.rows.every(x => x.status === 'needs_review'));
  }

  console.log('\nB. it works through a backlog in phases, not one gulp');
  {
    const db = fakeDb(Array.from({length: 7}, () => ({ client_url: 'https://b'+Math.random()+'.com' })));
    const phases = [];
    const q = makeQueue({ sbJson: db.sbJson, saveAudit: async () => ({ id: 'aud' }),
      runAudit: okRun(5), log: m => phases.push(m) });
    const r = await q.drain({ concurrency: 2, batchSize: 3, pauseMs: 1 });
    check('the whole backlog cleared', r.ran === 7, String(r.ran));
    check('in batches of three, not one pass', phases.length === 3, phases.length + ' phases');
    check('the last phase is the remainder', /phase of 1/.test(phases[2]||''), phases[2]);
  }

  console.log('\nC. a run that reached nothing is failed, never scored');
  {
    const db = fakeDb([{ client_url: 'https://dead.com' }]);
    let saved = 0;
    let lastSave = null;
    const q = makeQueue({ sbJson: db.sbJson,
      saveAudit: async a => { saved++; lastSave = a; return {id:'x'}; },
      runAudit: async () => ({ ungrounded: true, measured: 1, grounded: 6,
        silentlyFailed: new Array(34), unmeasured: [], state: { checks: [] },
        scores: { overall: 61, band: 'Critical' } }) });
    const r = await q.drain({ pauseMs: 0 });
    // This used to assert `failed` and `no audit filed`. The harm it was
    // guarding against is the SCORE -- 61 "Critical" written into a firm's
    // record because the run reached nothing -- and that is still refused
    // outright below. Discarding the run as well was a separate decision, and
    // the wrong one: a new firm legitimately fails most of these checks, so
    // the runs thrown away were disproportionately the ones for firms the
    // audit would help most, and a reviewer was left with nothing to open.
    check('parked for review rather than discarded',
          db.rows[0].status === 'needs_review', db.rows[0].status);
    check('the audit is filed so the grounded checks survive', saved === 1,
          saved + ' saved');
    check('but no score is recorded — not the score, not the tally',
          lastSave.scores === null && lastSave.kpisPassed === null &&
          lastSave.kpisTotal === null, JSON.stringify(lastSave.scores));
    check('the reason is recorded', /counted against this firm/.test(db.rows[0].error||''),
          (db.rows[0].error||'').slice(0,80));
    check('and it is flagged, so the page can say nothing is scored yet',
          db.rows[0].ungrounded === true);
    check('it counts as waiting for a person', r.needsReview === 1);
  }

  console.log('\nD. a crashed run does not take the phase down with it');
  {
    const db = fakeDb(Array.from({length: 4}, (_,i) => ({ client_url: 'https://c'+i+'.com' })));
    let n = 0;
    const q = makeQueue({ sbJson: db.sbJson, saveAudit: async () => ({id:'x'}),
      runAudit: async () => { if (++n === 2) throw new Error('browser crashed'); return okRun(5)(); } });
    const r = await q.drain({ concurrency: 2, pauseMs: 0 });
    check('every job was attempted', r.ran === 4, String(r.ran));
    check('three succeeded', r.needsReview === 3, String(r.needsReview));
    check('one failed with its reason kept', r.failed === 1 &&
          db.rows.some(x => /browser crashed/.test(x.error||'')));
  }

  console.log('\nE. two workers cannot run the same audit twice');
  {
    const db = fakeDb([{ client_url: 'https://one.com' }]);
    let runs = 0;
    const mk = () => makeQueue({ sbJson: db.sbJson, saveAudit: async () => ({id:'x'}),
      runAudit: async () => { runs++; return okRun(20)(); } });
    await Promise.all([mk().drain({pauseMs:0}), mk().drain({pauseMs:0})]);
    // Claiming is a conditional update, not read-then-write. Without that, a
    // double-tick in Airtable spends the API budget on the same firm twice.
    check('the audit ran once, not twice', runs === 1, runs + ' runs');
  }

  console.log('\nE2. an empty request body does not become a hot loop');
  {
    // The route builds { concurrency: b.concurrency, ... } from the request
    // body. Object.assign treats an explicit undefined as a value, so an empty
    // body overwrote every default with undefined:
    //   batchSize  -> limit=NaN
    //   concurrency -> Array.from({length: NaN}) -> ZERO lanes, nothing claimed
    //   pauseMs    -> no pause
    // In production that read the queue ten times a second, claimed nothing,
    // and never finished.
    const db = fakeDb(Array.from({length: 3}, (_,i) => ({ client_url: 'https://f'+i+'.com' })));
    const seen = [];
    const q = makeQueue({
      sbJson: async (u, o) => { seen.push(u); return db.sbJson(u, o); },
      saveAudit: async () => ({id:'x'}), runAudit: okRun(5) });
    const r = await q.drain({ concurrency: undefined, batchSize: undefined,
                              pauseMs: undefined, maxJobs: undefined });
    const reads = seen.filter(u => /status=eq\.queued&order/.test(u));
    check('the query has a real limit', reads.every(u => /limit=\d+$/.test(u)),
          reads[0] ? reads[0].split('&').pop() : 'no read');
    check('lanes actually start, so jobs get claimed', r.ran === 3, String(r.ran));
    check('and it stops instead of spinning', reads.length <= 2, reads.length + ' reads');
  }

  console.log('\nE3. a nonsense setting falls back rather than breaking');
  {
    const db = fakeDb([{ client_url: 'https://g.com' }]);
    const q = makeQueue({ sbJson: db.sbJson, saveAudit: async () => ({id:'x'}), runAudit: okRun(5) });
    const r = await q.drain({ concurrency: 0, batchSize: 'lots', pauseMs: -1 });
    check('zero concurrency does not mean zero lanes', r.ran === 1, String(r.ran));
    check('and the job finished', db.rows[0].status === 'needs_review', db.rows[0].status);
  }

  console.log('\nF. one database blip does not cost the phase');
  {
    // Supabase returned a single 502 ("Network connection lost") and the whole
    // phase died: the job stayed queued and the page reported a database error
    // for something momentary. Reads and claims are cheap and idempotent.
    const db = fakeDb(Array.from({length: 3}, (_,i) => ({ client_url: 'https://e'+i+'.com' })));
    let n = 0;
    const flaky = async (url, opts) => {
      // Fail the first claim once, and one read once.
      if (++n === 2 || n === 5) throw new Error('Supabase 502: gateway error: Error: Network connection lost.');
      return db.sbJson(url, opts);
    };
    const q = makeQueue({ sbJson: flaky, saveAudit: async () => ({id:'x'}), runAudit: okRun(5) });
    const r = await q.drain({ concurrency: 1, pauseMs: 0 });
    check('every job still ran', r.ran === 3, r.ran + ' of 3');
    check('and none were lost to the blip', r.needsReview === 3, String(r.needsReview));
    check('the queue did not give up', !r.gaveUp, r.gaveUp || 'carried on');
  }

  console.log('\nG. a database that stays down is reported, not thrown away');
  {
    // The drain runs detached from any request, so an exception would vanish
    // into an unhandled rejection and the page would show a queue that simply
    // stopped with nothing said.
    const q = makeQueue({ sbJson: async () => { throw new Error('Supabase 503: down'); },
      saveAudit: async () => ({id:'x'}), runAudit: okRun(5) });
    const r = await q.drain({ pauseMs: 0 });
    check('it says why it stopped', /503/.test(r.gaveUp||''), r.gaveUp);
    check('and returns rather than throwing', r.ran === 0);
  }

  console.log('\nH. a drain already in progress is not started again');
  {
    const db = fakeDb(Array.from({length: 3}, (_,i) => ({ client_url: 'https://d'+i+'.com' })));
    const q = makeQueue({ sbJson: db.sbJson, saveAudit: async () => ({id:'x'}), runAudit: okRun(30) });
    const first = q.drain({ concurrency: 1, pauseMs: 0 });
    const second = await q.drain({ pauseMs: 0 });
    check('the second call is refused', !!second.skipped, second.skipped || 'it ran');
    await first;
    check('and the first finished all three', db.rows.every(x => x.status === 'needs_review'));
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})();
