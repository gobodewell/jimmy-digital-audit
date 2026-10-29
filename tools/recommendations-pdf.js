#!/usr/bin/env node
// Every recommendation the audit can make, in one document.
//
// A client report carries at most five: TOP_N, ranked by the score each fix
// unlocks. That is right for the client and useless for anyone who needs to
// see the whole library -- to review the wording, to check a category is
// covered, or to answer "what does this tool actually tell people to do?".
// There was no way to see all forty at once short of reading report-doc.js.
//
// The copy is NOT re-stated here. Every title and paragraph is read from
// GTEXT / GTEXT_DRAFT through gtextFor, the same lookup the report uses, so
// this document cannot drift from what a client is handed. The questions,
// categories and effort labels are pulled out of the live page for the same
// reason -- CHECKS is defined once, in index.html, and the scoring engine
// stays the only thing that owns it.
//
//   node tools/recommendations-pdf.js [out.pdf]
const fs = require('fs');
const path = require('path');
const PdfPrinter = require('pdfmake');
const ROOT = path.resolve(__dirname, '..');
const RD = require(path.join(ROOT, 'assets', 'report-doc.js'));
const { RC, DISCLOSURE, PAGE_W, gtextFor, GTEXT, KEEP_GOING, rule, ctaBar,
        ROADMAP_LINK, TOP_N, NUM_WORD } = RD;
const M = 48, CONTENT = PAGE_W - M * 2;

function assets() {
  const src = fs.readFileSync(path.join(ROOT, 'assets', 'report-assets.js'), 'utf8');
  const w = {}; new Function('window', src)(w);
  return w.REPORT_ASSETS;
}
function fontsFor(A) {
  const out = {};
  Object.entries(A.fonts).forEach(([family, styles]) => {
    out[family] = {};
    Object.entries(styles).forEach(([style, file]) => {
      out[family][style] = Buffer.from(A.vfs[file], 'base64');
    });
  });
  return out;
}

// CHECKS, the category names and the effort labels live in the page. Reading
// them from there rather than copying them is the whole point: a check added
// to index.html appears in this document on the next run, and one renamed
// cannot leave a stale question behind in a document nobody re-generates.
async function readChecks() {
  const { chromium } = require('playwright');
  const b = await chromium.launch({ executablePath: require('../chromium-path.js')() });
  try {
    const p = await (await b.newContext()).newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'load' });
    if (errs.length) throw new Error('the page threw: ' + errs.join(' | '));
    return await p.evaluate(() => ({
      checks: CHECKS.map(c => ({ id: c.id, cat: c.cat, grp: c.grp, q: c.q,
                                 label: c.label, aeo: !!c.aeo, effort: c.effort })),
      catName: CAT_NAME, effortLabel: EFFORT_LABEL
    }));
  } finally { await b.close(); }
}

const pageHead = (title, sub, logoPurple) => ([
  { columns: [
      { text: title, font: 'Display', fontSize: 21, color: RC.purple, width: '*' },
      { svg: logoPurple, width: 95, alignment: 'right' }
    ], margin: [0, 0, 0, 14] },
  rule(CONTENT),
  ...(sub ? [{ text: sub, font: 'Body', fontSize: 8.6, color: RC.grayMid,
               lineHeight: 1.4, margin: [0, 10, 20, 2] }] : [])
]);

function build(data, A) {
  const { checks, catName, effortLabel } = data;
  const content = [];
  const withCopy = checks.filter(c => gtextFor(c.id));
  const noCopy   = checks.filter(c => !gtextFor(c.id));

  // ── title page ─────────────────────────────────────────────────────────────
  content.push(
    { text: 'GrowthLine Digital Audit', font: 'Display', fontSize: 13,
      color: RC.grayMid, margin: [0, 90, 0, 6] },
    { text: 'Every recommendation,\nin full', font: 'Display', bold: true,
      fontSize: 34, color: RC.purple, lineHeight: 1.12, margin: [0, 0, 0, 18] },
    rule(CONTENT, RC.gold),
    { text: [
        'A client report carries at most ', { text: NUM_WORD(TOP_N), bold: true },
        ' recommendations: the highest-scoring fixes that firm actually needs, each ' +
        'one word-for-word from the approved sheet. This document is the whole library — ',
        { text: String(withCopy.length), bold: true }, ' of ',
        { text: String(checks.length), bold: true },
        ' checks have recommendation copy, and all of it is below, grouped the way ' +
        'the scorecard groups it.'
      ], font: 'Body', fontSize: 10.5, color: RC.gray, lineHeight: 1.5,
      margin: [0, 18, 60, 14] },
    { text: 'Nothing here is re-written for this document. Every title and paragraph is ' +
            'read from the same lookup the client report uses, so the two cannot drift ' +
            'apart. The five habits on the last page are the exception, and are marked: ' +
            'they are not checks and are not scored.',
      font: 'Body', fontSize: 9, color: RC.grayMid, lineHeight: 1.45, margin: [0, 0, 60, 0] },
    { text: 'Generated ' + new Date().toLocaleDateString('en-US',
              { month: 'long', day: 'numeric', year: 'numeric' }),
      font: 'Body', fontSize: 8.4, color: RC.grayMid, margin: [0, 26, 0, 0] }
  );

  // ── one page-group per category ────────────────────────────────────────────
  let n = 0;
  ['v', 'w', 's'].forEach(cat => {
    const mine = withCopy.filter(c => c.cat === cat);
    if (!mine.length) return;
    const groups = [...new Set(mine.map(c => c.grp))];
    const head = pageHead(catName[cat],
      mine.length + (mine.length === 1 ? ' recommendation' : ' recommendations') +
      ' across ' + groups.length + (groups.length === 1 ? ' group' : ' groups') + '.',
      A.logoPurple);
    head[0] = Object.assign({}, head[0], { pageBreak: 'before' });
    content.push(...head);

    groups.forEach(grp => {
      content.push({ text: grp, font: 'Body', bold: true, fontSize: 9,
        color: RC.magenta, margin: [0, 11, 0, 5] });
      const rows = mine.filter(c => c.grp === grp).map(c => {
        const g = gtextFor(c.id);
        n++;
        return [
          { text: String(n), font: 'Display', fontSize: 13, color: RC.g200, margin: [0, 2, 0, 0] },
          { stack: [
              // The question the box asks, first -- this document is read
              // alongside the scorecard, and the question is how a row is
              // found again.
              { text: c.q, font: 'Body', fontSize: 8, color: RC.grayMid,
                italics: true, margin: [0, 0, 0, 2] },
              { text: g.title, font: 'Body', bold: true, fontSize: 9.6,
                color: RC.purple, margin: [0, 0, 0, 2] },
              // 8pt at 1.24 is what makes forty of these pack without a row
              // being split. The first render left item 15 alone on a page of
              // its own: dontBreakRows will move a whole row rather than cut
              // it, so the density has to earn the fit.
              { text: g.text, font: 'Body', fontSize: 8, color: RC.gray,
                lineHeight: 1.24, margin: [0, 0, 0, 2] },
              { text: [ catName[c.cat], ' · ', effortLabel[c.effort] || c.effort,
                        c.aeo ? ' · Impacts AEO' : '',
                        // Which rows are still waiting on the approved sheet.
                        // Worth seeing at a glance by anyone reviewing wording.
                        GTEXT[c.id] ? '' : ' · Draft wording' ].join(''),
                font: 'Body', fontSize: 7.2, color: RC.grayMid }
            ] }
        ];
      });
      content.push({ table: { widths: [20, '*'], body: rows, dontBreakRows: true },
        layout: {
          hLineWidth: (i, node) => (i === 0 || i === node.table.body.length) ? 0 : 0.6,
          vLineWidth: () => 0, hLineColor: () => RC.g100,
          paddingTop: () => 5, paddingBottom: () => 5, paddingLeft: () => 0, paddingRight: () => 0
        }, margin: [0, 0, 0, 2] });
    });
  });

  // ── the five that are not checks ───────────────────────────────────────────
  const kg = pageHead('What comes after the checklist',
    'These five are not checks and are not scored. They appear in a client report only ' +
    'when fewer than ' + NUM_WORD(TOP_N) + ' checks failed — a firm that has nearly run ' +
    'out of checklist. Every one is something an advisor can do without a developer.',
    A.logoPurple);
  kg[0] = Object.assign({}, kg[0], { pageBreak: 'before' });
  content.push(...kg);
  content.push({ table: { widths: [20, '*'], dontBreakRows: true,
      body: KEEP_GOING.map((k, i) => ([
        { text: String(i + 1), font: 'Display', fontSize: 13, color: RC.g200, margin: [0, 2, 0, 0] },
        { stack: [
            { text: k.title, font: 'Body', bold: true, fontSize: 9.8, color: RC.purple, margin: [0, 1, 0, 3] },
            { text: k.text, font: 'Body', fontSize: 8.2, color: RC.gray, lineHeight: 1.3, margin: [0, 0, 0, 3] },
            { text: k.meta + ' · Not scored', font: 'Body', fontSize: 7.4, color: RC.grayMid }
          ] }
      ])) },
    layout: {
      hLineWidth: (i, node) => (i === 0 || i === node.table.body.length) ? 0 : 0.6,
      vLineWidth: () => 0, hLineColor: () => RC.g100,
      paddingTop: () => 7, paddingBottom: () => 7, paddingLeft: () => 0, paddingRight: () => 0
    }, margin: [0, 12, 0, 12] });

  // A check with no copy in either source prints nothing on page 2 of a client
  // report, by design -- nothing invents wording. This document is where that
  // silence is visible, so a gap can be filled rather than discovered by a
  // reader noticing a failing check that was never mentioned.
  if (noCopy.length) {
    content.push(
      { text: 'Checks with no recommendation copy', font: 'Body', bold: true,
        fontSize: 9.4, color: RC.magenta, margin: [0, 6, 0, 5] },
      { text: 'A failing check with no approved or draft wording is passed over in the ' +
              'client report rather than filled with something invented. These ' +
              (noCopy.length === 1 ? 'is the one that has' : 'are the ones that have') +
              ' none:', font: 'Body', fontSize: 8.4, color: RC.gray, lineHeight: 1.4,
        margin: [0, 0, 20, 6] },
      { ul: noCopy.map(c => c.q + '  (' + c.id + ')'), font: 'Body', fontSize: 8.2,
        color: RC.gray, lineHeight: 1.35, margin: [0, 0, 20, 10] });
  }

  content.push(ctaBar(ROADMAP_LINK, null,
    'Add and follow the Implement GrowthLine Audit Recommendations roadmap in Growth360.',
    'Launch Roadmap', 10));

  return {
    pageSize: 'LETTER', pageOrientation: 'portrait',
    pageMargins: [M, M, M, 56],
    info: { title: 'GrowthLine Digital Audit — every recommendation',
            author: 'Cetera GrowthLine' },
    background: page => page === 1 ? null
      : { canvas: [{ type: 'rect', x: 0, y: 786, w: PAGE_W, h: 6, color: RC.purple }] },
    footer: page => page === 1 ? null : ({
      columns: [
        { text: DISCLOSURE, font: 'Body', fontSize: 7, color: RC.grayMid },
        { text: 'Page ' + page, font: 'Body', fontSize: 7, color: RC.grayMid, alignment: 'right' }
      ], margin: [M, 8, M, 0] }),
    content,
    defaultStyle: { font: 'Body', fontSize: 9.5, color: RC.gray }
  };
}

async function main() {
  const out = path.resolve(process.argv[2] || 'growthline-recommendations.pdf');
  const A = assets();
  const data = await readChecks();
  const printer = new PdfPrinter(fontsFor(A));
  const pdf = printer.createPdfKitDocument(build(data, A));
  const chunks = [];
  await new Promise((res, rej) => {
    pdf.on('data', c => chunks.push(c));
    pdf.on('end', res); pdf.on('error', rej); pdf.end();
  });
  fs.writeFileSync(out, Buffer.concat(chunks));
  const withCopy = data.checks.filter(c => gtextFor(c.id)).length;
  console.log('wrote ' + out + '  (' + withCopy + ' of ' + data.checks.length +
              ' checks, plus ' + KEEP_GOING.length + ' unscored habits)');
}

// Exported so a test can build the document definition without rendering a
// PDF, and so requiring this file does not write one.
module.exports = { build, readChecks, assets, fontsFor };

if (require.main === module)
  main().catch(e => { console.error(e.message); process.exit(1); });
