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
  const { sbJson, runAudit, saveAudit, log } = deps;
  const say = log || (() => {});
  let running = false;
  let stopping = false;

  const esc = encodeURIComponent;

  // Claiming is a conditional update, not a read-then-write: two workers (or
  // one worker and a retry) would otherwise both pick up the same row and
  // spend the API budget on it twice.
  async function claim(job) {
    const rows = await sbJson(
      '/rest/v1/audit_jobs?id=eq.' + esc(job.id) + '&status=eq.queued',
      { method: 'PATCH', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          status: 'running', started_at: new Date().toISOString(),
          attempts: (job.attempts || 0) + 1 }) });
    return (rows || [])[0] || null;      // null -> somebody else got it
  }

  async function finish(id, fields) {
    await sbJson('/rest/v1/audit_jobs?id=eq.' + esc(id),
      { method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(Object.assign(
          { finished_at: new Date().toISOString() }, fields)) });
  }

  async function runOne(job) {
    const claimed = await claim(job);
    if (!claimed) return { id: job.id, skipped: 'claimed by another worker' };

    try {
      const out = await runAudit({
        clientName: job.client_name, clientUrl: job.client_url,
        clientCity: job.client_city
      });

      // A run that reached almost nothing is a failed run, not a bad score.
      // Writing 61 "Critical" into a firm's record because their site was
      // unreachable is the one outcome worth refusing outright.
      if (out.ungrounded) {
        await finish(job.id, {
          status: 'failed', measured: out.measured, ungrounded: true,
          error: 'the audit reached too little to score: ' +
                 out.silentlyFailed.length + ' checks would have counted ' +
                 'against this firm with nothing checked, against ' +
                 out.grounded + ' resting on something.' });
        return { id: job.id, status: 'failed', reason: 'ungrounded' };
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
      return { id: job.id, status: 'needs_review', auditId: saved && saved.id,
               measured: out.measured, unmeasured: (out.unmeasured || []).length };

    } catch (e) {
      await finish(job.id, { status: 'failed', error: e.message.slice(0, 900) });
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
        results.push(await runOne(job));
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, lane));
    return results;
  }

  async function take(limit) {
    return await sbJson('/rest/v1/audit_jobs?status=eq.queued' +
      '&order=priority.desc,created_at.asc&limit=' + limit) || [];
  }

  // One pass: take a batch, run it in phases, pause, repeat until the queue is
  // empty or `maxJobs` have run. Returns what happened rather than logging into
  // the void, so a caller can report it.
  async function drain(opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    if (running) return { skipped: 'a drain is already in progress' };
    running = true; stopping = false;
    const all = [];
    try {
      while (!stopping) {
        const left = o.maxJobs ? o.maxJobs - all.length : o.batchSize;
        if (left <= 0) break;
        const jobs = await take(Math.min(o.batchSize, left));
        if (!jobs.length) break;
        say('queue: phase of ' + jobs.length + ' (' + o.concurrency + ' at a time)');
        all.push(...await phase(jobs, o.concurrency));
        if (o.pauseMs && !stopping) await new Promise(r => setTimeout(r, o.pauseMs));
      }
    } finally { running = false; }
    return {
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
