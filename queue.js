// ── The audit queue ─────────────────────────────────────────────────────────
// Audits stack up and a worker takes a few at a time.
//
// Phases rather than all at once, because two things bite at about the same
// size: each audit is roughly 13 third-party API calls, and each one holds a
// headless browser worth a few hundred MB. Fifty tickboxes at once would
// exhaust the rate limits and the instance together.
//
// A finished RUN is not a finished AUDIT. The queue's resting state is
// `needs_review`: a person opens it, fills what the run could not reach -- the
// browser extension is the only thing that sees a Cloudflare-fronted site --
// corrects what it got wrong, and approves. Nothing here decides an audit is
// done.
const DEFAULTS = {
  // Concurrent runs within a phase. Deliberately small: this is browsers, not
  // requests. Raise it only with the instance's memory in front of you.
  concurrency: 2,
  // How many to take in one pass. The pause between phases is what keeps a
  // large batch from looking like an attack to DataForSEO.
  batchSize: 6,
  pauseMs: 15000
};

function makeQueue(deps) {
  const { sbJson, runAudit, saveAudit, log, onStatus } = deps;
  const say = log || (() => {});

  // Telling Airtable where a job got to.
  //
  // Wrapped, always. A bookkeeping write must never decide an audit's fate:
  // that is exactly what cost us the first unattended run, where a PATCH that
  // had already landed threw while parsing an empty 204 body and the catch
  // wrote `failed` over a `needs_review`. So this reports and returns -- a
  // mirror that is out of date is a nuisance, a mirror that can fail a good
  // audit is a bug.
  async function mirror(job, status) {
    if (!onStatus) return;
    try { await onStatus(job, status); }
    catch (e) { say('queue: could not mirror ' + status + ' to Airtable — ' +
                    e.message.slice(0, 120)); }
  }

  // One transient 5xx should not cost a whole phase.
  //
  // Supabase's gateway returned a single 502 ("Network connection lost") and
  // everything downstream of it died: the phase aborted, the job stayed
  // queued, and the page reported a database error for something that was
  // momentary. Reads and claims are cheap and idempotent, so retry them twice
  // before giving up.
  async function sbTry(path, opts, tries) {
    let last;
    for (let i = 0; i < (tries || 3); i++) {
      try { return await sbJson(path, opts); }
      catch (e) {
        last = e;
        const transient = /\b50[0234]\b|network|socket|ECONN|timeout|aborted/i.test(e.message);
        if (!transient) throw e;
        say('queue: ' + e.message.slice(0, 80) + ' — retrying');
        await new Promise(r => setTimeout(r, 400 * (i + 1)));
      }
    }
    throw last;
  }
  let running = false;
  let stopping = false;

  const esc = encodeURIComponent;

  // Claiming is a conditional update, not a read-then-write: two workers (or
  // one worker and a retry) would otherwise both pick up the same row and
  // spend the API budget on it twice.
  async function claim(job) {
    const rows = await sbTry(
      '/rest/v1/audit_jobs?id=eq.' + esc(job.id) + '&status=eq.queued',
      { method: 'PATCH', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          status: 'running', started_at: new Date().toISOString(),
          attempts: (job.attempts || 0) + 1 }) });
    return (rows || [])[0] || null;      // null -> somebody else got it
  }

  async function finish(id, fields) {
    await sbTry('/rest/v1/audit_jobs?id=eq.' + esc(id),
      { method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(Object.assign(
          { finished_at: new Date().toISOString() }, fields)) });
  }

  async function runOne(job) {
    // Claiming is INSIDE the try. It used to sit outside it, so a database
    // hiccup while claiming threw straight past runOne, past the phase, and
    // out of drain -- one job's bad luck killing every other job in the batch.
    try {
      const claimed = await claim(job);
      if (!claimed) return { id: job.id, skipped: 'claimed by another worker' };
      await mirror(job, 'running');

      const out = await runAudit({
        clientName: job.client_name, clientUrl: job.client_url,
        clientCity: job.client_city
      });

      // A run that reached almost nothing is a failed run, not a bad score.
      // Writing 61 "Critical" into a firm's record because their site was
      // unreachable is the one outcome worth refusing outright.
      // ── A run that could not support a score ──────────────────────────────
      // Writing 61 "Critical" into a firm's record because the run reached
      // nothing is still the one outcome worth refusing outright. So no score
      // is recorded: the audit is filed with its score columns empty.
      //
      // But it is NOT thrown away, which is what used to happen. The checks
      // the run did ground are real work, and discarding them made a person
      // start from scratch -- on, in practice, the firms that most need the
      // audit. A new firm legitimately fails most of these checks, and
      // "you have no backlinks yet" is the finding, not a failure to look.
      //
      // So it is parked for review like any other run. The difference is that
      // it arrives with nothing scored and says why, and the score is worked
      // out when a person completes it and saves.
      if (out.ungrounded) {
        const why = 'not scored automatically: only ' + out.grounded + ' of 40 ' +
          'checks rested on something the run could confirm, and ' +
          out.silentlyFailed.length + ' would have counted against this firm ' +
          'with nothing actually checked. Complete it and the score follows.';
        let saved = null;
        try {
          saved = await saveAudit({
            clientName: job.client_name, clientUrl: job.client_url,
            clientCity: job.client_city,
            source: job.source, template: job.template,
            state: out.state, report: out.report,
            // Explicitly nothing. saveAudit writes null for each of these, so
            // no number exists to be read, pushed or believed.
            scores: null, kpisPassed: null, kpisTotal: null,
            note: why
          });
        } catch (e) {
          // Filing failed too -- now there really is nothing to review.
          await finish(job.id, { status: 'failed', measured: out.measured,
            ungrounded: true, error: why + ' (and it could not be filed: ' +
            e.message.slice(0, 200) + ')' });
          await mirror(job, 'failed');
          return { id: job.id, status: 'failed', reason: 'ungrounded' };
        }
        await finish(job.id, { status: 'needs_review', audit_id: saved && saved.id,
          measured: out.measured, ungrounded: true, error: why });
        await mirror(job, 'needs_review');
        return { id: job.id, status: 'needs_review', ungrounded: true,
                 auditId: saved && saved.id, measured: out.measured };
      }

      // Filed with no PDF: the document is the reviewer's to approve, and a
      // report nobody has looked at is not one to generate.
      const saved = await saveAudit({
        clientName: job.client_name, clientUrl: job.client_url,
        clientCity: job.client_city,
        source: job.source, template: job.template,
        state: out.state, report: out.report, scores: out.scores,
        kpisPassed: out.scores && out.scores.passed,
        kpisTotal: out.scores && out.scores.total
      });

      await finish(job.id, {
        status: 'needs_review', audit_id: saved && saved.id,
        measured: out.measured, ungrounded: false, error: null });
      await mirror(job, 'needs_review');
      return { id: job.id, status: 'needs_review', auditId: saved && saved.id,
               measured: out.measured, unmeasured: (out.unmeasured || []).length };

    } catch (e) {
      await finish(job.id, { status: 'failed', error: e.message.slice(0, 900) });
      await mirror(job, 'failed');
      return { id: job.id, status: 'failed', error: e.message };
    }
  }

  // A phase: at most `concurrency` runs in flight, started as slots free up.
  async function phase(jobs, concurrency) {
    const results = [];
    let next = 0;
    const lane = async () => {
      while (next < jobs.length && !stopping) {
        const job = jobs[next++];
        // runOne catches its own failures; this is the belt for anything it
        // cannot, so one lane dying never takes the other lane with it.
        try { results.push(await runOne(job)); }
        catch (e) { results.push({ id: job.id, status: 'failed', error: e.message }); }
      }
    };
    const lanes = Math.max(1, Math.min(concurrency, jobs.length));
    await Promise.all(Array.from({ length: lanes }, lane));
    return results;
  }

  async function take(limit) {
    return await sbTry('/rest/v1/audit_jobs?status=eq.queued' +
      '&order=priority.desc,created_at.asc&limit=' + limit) || [];
  }

  // One pass: take a batch, run it in phases, pause, repeat until the queue is
  // empty or `maxJobs` have run. Returns what happened rather than logging into
  // the void, so a caller can report it.
  // Object.assign treats an explicit `undefined` as a value and overwrites the
  // default with it. The route builds { concurrency: b.concurrency, ... } from
  // the request body, so an empty body sent undefined for every one of them:
  //
  //   batchSize  undefined -> limit=NaN on the query
  //   concurrency undefined -> Array.from({length: NaN}) -> ZERO lanes, so no
  //                            job was ever claimed
  //   pauseMs    undefined -> no pause
  //
  // which is a hot loop that reads the queue ten times a second, claims
  // nothing, and never ends. It ran against production and was almost
  // certainly what provoked the gateway 502 blamed on Supabase.
  function settings(opts) {
    const o = Object.assign({}, DEFAULTS);
    Object.entries(opts || {}).forEach(([k, v]) => { if (v != null) o[k] = v; });
    // Still guarded after that: a caller passing 0, a string or a negative
    // would produce the same shape of bug by a different route.
    const num = (v, d, min) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= (min == null ? 1 : min) ? n : d;
    };
    o.concurrency = num(o.concurrency, DEFAULTS.concurrency);
    o.batchSize   = num(o.batchSize,   DEFAULTS.batchSize);
    o.pauseMs     = num(o.pauseMs,     DEFAULTS.pauseMs, 0);
    if (o.maxJobs != null) o.maxJobs = num(o.maxJobs, null);
    return o;
  }

  async function drain(opts) {
    const o = settings(opts);
    if (running) return { skipped: 'a drain is already in progress' };
    running = true; stopping = false;
    const all = [];
    let gaveUp = null;   // assigned inside the loop as well as the catch
    try {
      while (!stopping) {
        const left = o.maxJobs ? o.maxJobs - all.length : o.batchSize;
        if (left <= 0) break;
        const jobs = await take(Math.min(o.batchSize, left));
        if (!jobs.length) break;
        say('queue: phase of ' + jobs.length + ' (' + o.concurrency + ' at a time)');
        const before = all.length;
        all.push(...await phase(jobs, o.concurrency));
        // A pass that took jobs and did nothing with them is a bug, not an
        // empty queue. Spinning on it reads the database for ever and claims
        // nothing, which is exactly what happened in production.
        if (all.length === before) {
          gaveUp = 'a phase of ' + jobs.length + ' produced no results — stopping ' +
                   'rather than retrying for ever';
          say('queue: ' + gaveUp);
          break;
        }
        if (o.pauseMs && !stopping) await new Promise(r => setTimeout(r, o.pauseMs));
      }
    } catch (e) {
      // Reported, not thrown. This runs detached from any request, so an
      // exception here would vanish into an unhandled rejection and the page
      // would show a queue that simply stopped for no stated reason.
      gaveUp = e.message;
      say('queue: gave up — ' + e.message);
    } finally { running = false; }
    return {
      gaveUp,
      ran: all.length,
      needsReview: all.filter(r => r.status === 'needs_review').length,
      failed: all.filter(r => r.status === 'failed').length,
      results: all
    };
  }

  return {
    drain,
    stop: () => { stopping = true; },
    isRunning: () => running,
    DEFAULTS
  };
}

module.exports = { makeQueue, DEFAULTS };
