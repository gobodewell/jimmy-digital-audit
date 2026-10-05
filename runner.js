// ── Running the audit without a person ──────────────────────────────────────
// The proxy can already BUILD a report (render.js). It cannot work one out:
// the forty checks, the scoring and assembleReport live in the page, on
// purpose, because two scoring engines would drift and the one nobody watches
// would be the one that drifted.
//
// So this does not reimplement them. It opens the real page in a headless
// browser, points it back at this same proxy, fills the three fields a person
// fills, and calls the same runAudit() the Run button calls. One definition of
// what the audit means, two ways to start it.
//
// Everything is lazy: playwright is a devDependency and the browser is a few
// hundred MB, so a proxy without them still boots, still serves every other
// route, and says so at /health. See runnerStatus().
const path = require('path');

let _pw = null;
function playwright() {
  if (_pw) return _pw;
  try { return (_pw = require('playwright')); }
  catch (e) {
    const err = new Error(
      'the audit runner is not installed on this proxy: playwright is missing. ' +
      'It is a devDependency, and the deploy installs production dependencies ' +
      'only. (' + e.message.split('\n')[0] + ')');
    err.runnerMissing = true;
    throw err;
  }
}

// Where the browser the runner drives lives. Render installs nothing extra by
// default, so this is the first thing to check when a run fails to start.
function browserPath() {
  return process.env.CHROMIUM_PATH ||
         process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || null;
}

async function runnerStatus() {
  try {
    const pw = playwright();
    const exe = browserPath();
    // Asking the browser to report its version is the only honest check: the
    // package being present says nothing about whether a browser was installed.
    const b = await pw.chromium.launch(exe ? { executablePath: exe } : {});
    const v = b.version();
    await b.close();
    return { ok: true, browser: v };
  } catch (e) {
    return { ok: false, why: e.message.split('\n')[0] };
  }
}

// The audit itself.
//
// `proxy` is this server's own address, so the page's calls come straight back
// here rather than going out and round. `auditKey` is the same shared secret a
// person's browser sends; without it every step 401s.
async function runAudit(opts) {
  const o = opts || {};
  if (!o.clientUrl) {
    const e = new Error('a website URL is required to run an audit');
    e.badRequest = true; throw e;
  }

  const pw = playwright();
  const exe = browserPath();
  const pageUrl = 'file://' + path.join(__dirname, 'index.html');
  const deadline = o.timeout || 420000;        // a real run is 2-4 minutes

  let browser;
  try {
    browser = await pw.chromium.launch(exe ? { executablePath: exe } : {});
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    const errs = [];
    page.on('pageerror', e => errs.push(e.message));

    // Before the page's own scripts run, so loadSettings() reads these rather
    // than defaulting to the public proxy URL.
    await page.addInitScript(cfg => {
      try {
        localStorage.setItem('cfg_proxy', cfg.proxy);
        if (cfg.key) localStorage.setItem('cfg_audit', cfg.key);
      } catch (e) {}
    }, { proxy: o.proxy, key: o.auditKey || '' });

    await page.goto(pageUrl, { waitUntil: 'load', timeout: 60000 });

    const out = await page.evaluate(async c => {
      document.getElementById('clientName').value = c.clientName || '';
      document.getElementById('clientURL').value  = c.clientUrl;
      document.getElementById('clientCity').value = c.clientCity || '';
      // The same function the Run button calls. It resolves when every phase
      // has settled, so there is nothing to poll for.
      await window.runAudit();
      const d = assembleReport();
      d.preparedBy = c.preparedBy || '';
      // How much of this run actually rests on a measurement.
      //
      // Individual checks already distinguish "measured and failed" from "not
      // measured". A RUN does not, and that gap only shows up here: with every
      // data source failing, 34 of 40 checks sat unticked with no recorded
      // reason, and the audit reported 61 "Critical" as though it had looked.
      // A person would see the error panels and bin it. Nobody sees a headless
      // run, so it has to be able to say that it learned nothing.
      const ids = CHECKS.map(c => c.id);
      const ticked = id => !!(document.getElementById(id) || {}).checked;
      // Unticked, no reason recorded, AND never measured. All three matter:
      // a check that WAS measured and genuinely failed is a finding, not a
      // silence, and the first version of this counted those too -- which
      // would have flagged every healthy audit.
      const failedSilently = ids.filter(id =>
        !ticked(id) && !UNK.has(id) && !DIRECT.has(id));
      // What the score rests on: an answer found, a reason recorded for not
      // finding one, or a measurement that came back negative.
      const grounded = ids.filter(id =>
        ticked(id) || UNK.has(id) || DIRECT.has(id));
      return {
        state: auditState(),
        report: d,
        scores: AD.scores,
        unmeasured: [...UNK.entries()].map(([id, why]) => ({ id, why })),
        measured: DIRECT.size,
        passed: ids.filter(ticked).length,
        grounded: grounded.length,
        // Counted against the firm without anything having been checked.
        silentlyFailed: failedSilently
      };
    }, {
      clientName: o.clientName || '', clientUrl: o.clientUrl,
      clientCity: o.clientCity || '', preparedBy: o.preparedBy || ''
    }, { timeout: deadline });

    out.pageErrors = errs;
    // A score is worth reporting only when more of it rests on something than
    // on nothing.
    //
    // "measured === 0" was the first rule and it was too narrow: HTTPS is
    // derivable from the URL without reaching the site at all, so one
    // trivially-true check made a run that learned nothing else look
    // legitimate and returned 61 "Critical" with a 200. This counts instead.
    out.ungrounded = out.silentlyFailed.length > out.grounded;
    return out;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { runAudit, runnerStatus, browserPath };
