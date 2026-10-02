// ── Building the report outside the browser ─────────────────────────────────
// Until now the only thing that could produce a report was a person sitting in
// front of the app with pdfmake loaded. That is fine for an audit someone runs
// by hand and useless for the three things we want next: a prospect running
// their own audit, a batch run from Airtable, and rebuilding a report from a
// filed audit months later.
//
// What this does NOT do is re-derive the audit. The scoring engine, the forty
// checks and assembleReport stay in one place -- the page -- because two
// engines would drift and the one nobody watches would be the one that
// drifted. The page hands over the report's DATA; this turns that data into
// the same pages, using the same document builder the browser uses.
const fs   = require('fs');
const path = require('path');
const PdfPrinter = require('pdfmake');

// Loaded on first use, not at boot.
//
// These two files were browser-only until now, so a deploy that uploads
// server.js and forgets them is the likely mistake -- and a top-level require
// turns that into "Cannot find module" before app.listen, which takes the
// WHOLE proxy down: no audits, no history, no AI, a crash loop on Render.
// Building a report is one capability among many and should fail like one.
// /health says whether it is available, and the route says which file is
// missing instead of the server simply being gone.
const _docs = {};
function reportDoc(file) {
  const f = file || 'report-doc.js';
  if (_docs[f]) return _docs[f];
  try { return (_docs[f] = require('./assets/' + f)); }
  catch (e) { throw rendererMissing('assets/' + f, e); }
}

function rendererMissing(file, e) {
  const err = new Error(
    'the report builder is not installed on this proxy: ' + file + ' is missing. ' +
    'It used to be served to the browser only, so a deploy that uploads server.js ' +
    'without the assets folder leaves the proxy unable to build reports. ' +
    '(' + e.message.split('\n')[0] + ')');
  err.rendererMissing = true;
  return err;
}

// report-assets.js is written for a browser: one statement assigning to
// window. Run it with a window of our own rather than eval in this scope, so
// it cannot reach anything here.
let _assets = null;
function assets() {
  if (_assets) return _assets;
  let src;
  try { src = fs.readFileSync(path.join(__dirname, 'assets', 'report-assets.js'), 'utf8'); }
  catch (e) { throw rendererMissing('assets/report-assets.js', e); }
  const w = {};
  new Function('window', src)(w);
  if (!w.REPORT_ASSETS) throw new Error('assets/report-assets.js did not define REPORT_ASSETS');
  return (_assets = w.REPORT_ASSETS);
}

// pdfmake in the browser takes a vfs of base64 and a name-to-filename map.
// In node it wants the bytes. Derived from the same two structures rather than
// hard-coded, so adding a weight to the assets file is enough.
function fontsFor(A) {
  const out = {};
  Object.entries(A.fonts).forEach(([family, styles]) => {
    out[family] = {};
    Object.entries(styles).forEach(([style, file]) => {
      const b64 = A.vfs[file];
      if (!b64) throw new Error('font file missing from the asset vfs: ' + file);
      out[family][style] = Buffer.from(b64, 'base64');
    });
  });
  return out;
}

// Which document a report is built from. Keyed by the record's `template`.
//
// There is deliberately no fallback. The current report carries "For financial
// professional use only. Not for use with the public." in its footer, so the
// cost of quietly rendering the wrong template is handing a prospect a
// document that says it is not for them. An unknown name fails and says which
// names exist.
const TEMPLATES = {
  growthline: { file: 'report-doc.js' },
  // The prospect document. Marked draft because its footer still reads
  // "disclosure pending compliance review" -- the GrowthLine footer says "Not
  // for use with the public", so a prospect report cannot simply inherit it,
  // and inventing a compliance line that merely looks plausible would be
  // worse than an obvious placeholder. Draft templates render only when the
  // caller asks for a draft on purpose, so one cannot reach a client by being
  // the default somewhere.
  prospect:   { file: 'report-doc-prospect.js', draft: true }
};

function templateNames() { return Object.keys(TEMPLATES); }

// Which templates are finished, and which are still drafts. The app shows the
// difference rather than discovering it when a build is refused.
function templateInfo() {
  return Object.entries(TEMPLATES).map(([name, t]) => ({ name, draft: !!t.draft }));
}

// Can this proxy build a report at all? Answered by trying, so /health reports
// what is actually installed rather than what is supposed to be.
function rendererStatus() {
  try { reportDoc(); assets(); return { ok: true, templates: templateInfo() }; }
  catch (e) { return { ok: false, why: e.message }; }
}

function docFor(d, template, allowDraft) {
  const name = template || 'growthline';
  const spec = TEMPLATES[name];
  if (!spec) throw new Error(
    'unknown report template "' + name + '" — this proxy builds: ' + templateNames().join(', '));
  if (spec.draft && !allowDraft) throw new Error(
    'the "' + name + '" report is still a draft: its disclosure has not been through ' +
    'compliance, so it is not a document to send anyone. Pass draft:true to render ' +
    'it for review.');
  const A = assets();
  return reportDoc(spec.file).buildReportDoc(d,
    { logoWhite: A.logoWhite, logoPurple: A.logoPurple, coverBg: A.cover });
}

// The report data the page assembles. Checked before rendering because
// pdfmake's own failure for a missing field is a stack trace about an
// undefined property, which says nothing about what was actually not sent.
function checkReport(d) {
  if (!d || typeof d !== 'object') return 'no report data was sent';
  if (!d.firm)     return 'the report data has no firm name';
  if (!d.scores)   return 'the report data has no scores';
  if (!Array.isArray(d.sections) || !d.sections.length)
    return 'the report data has no scorecard sections';
  return null;
}

function renderReport(d, opts) {
  const o = opts || {};
  const bad = checkReport(d);
  if (bad) return Promise.reject(Object.assign(new Error(bad), { badRequest: true }));

  let doc;
  try { doc = docFor(d, o.template, o.draft); }
  catch (e) {
    // A missing asset is the server's problem, not the caller's. Tagging it
    // badRequest answered 400, which tells whoever asked that THEY sent
    // something wrong and hides a half-finished deploy behind a client error.
    if (e.rendererMissing) return Promise.reject(e);
    return Promise.reject(Object.assign(e, { badRequest: true }));
  }

  const printer = new PdfPrinter(fontsFor(assets()));
  return new Promise((resolve, reject) => {
    let pdf;
    try { pdf = printer.createPdfKitDocument(doc); }
    catch (e) { return reject(e); }
    const chunks = [];
    pdf.on('data', c => chunks.push(c));
    pdf.on('error', reject);
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.end();
  });
}

// The filename the browser uses, so a report rebuilt here is not mistaken for
// a different document.
function reportName(d) {
  const when = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  return 'Digital Audit - ' + ((d && d.firm) || 'Client') + ' - ' + when + '.pdf';
}

module.exports = { renderReport, reportName, templateNames, templateInfo, checkReport, rendererStatus };
