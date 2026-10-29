// What a firm does once the checklist runs out.
//
// Forty checks measure whether the foundations are there. None of them can
// measure whether anything is still happening: a blog that stopped in 2023
// passes "is there a blog", twelve reviews from 2021 pass "do you have
// reviews", and a firm can hold a 100 while every one of those signals ages.
//
// So a perfect audit ended on a page reading "No priority fixes · Every check
// in this audit passed" and nothing else. True, and no use to the person
// holding it.
//
// The five habits on the new last page have to earn their place without
// damaging what the audit already does, which is three separate claims:
//   1. they are not scored -- a 100 stays a 100 with all five undone;
//   2. they do not read as failures;
//   3. an advisor can do every one alone, with no developer and no platform
//      access, because a good share of these firms are on a managed site.
const path = require('path');
const PAGE = 'file://' + path.resolve(__dirname, '..', 'index.html');
const { chromium } = require('playwright');
const RD = require('../assets/report-doc.js');

let failures = 0;
const check = (l, c, d) => {
  console.log((c ? '  PASS  ' : '  FAIL  ') + l + (d ? '   → ' + d : ''));
  if (!c) failures++;
};

(async () => {
  // ── unit: the gate ─────────────────────────────────────────────────────────
  console.log('\nA. when the page shows at all');
  check('a firm with nothing failing gets it',
        RD.showKeepGoing({ failedCount: 0, actions: [] }) === true);
  check('and so does one with four fixes left',
        RD.showKeepGoing({ failedCount: 4, actions: [1,2,3,4] }) === true);
  check('five failing is still a checklist, not a next step',
        RD.showKeepGoing({ failedCount: 5, actions: [1,2,3,4,5] }) === false);
  check('and twenty certainly is',
        RD.showKeepGoing({ failedCount: 20, actions: [1,2,3,4,5] }) === false);

  // actions.length is capped at TOP_N and is further reduced when a failing
  // check is held back for want of approved copy. Gating on it would show
  // "sponsor the little league team" to a firm with eight things broken.
  check('it is gated on what actually failed, not on how many rows page 2 could fill',
        RD.showKeepGoing({ failedCount: 8, actions: [1, 2] }) === false,
        '8 failures, 2 printable rows');

  // ── unit: the copy obeys the rule it was written under ─────────────────────
  console.log('\nB. five items an advisor can do alone');
  check('there are five', RD.KEEP_GOING.length === 5, String(RD.KEEP_GOING.length));
  RD.KEEP_GOING.forEach((k, i) => {
    check(`  ${i + 1}. has a title, body and a cadence`,
          !!(k.title && k.text && k.meta), JSON.stringify(Object.keys(k)));
  });
  // The constraint that decided the final five: no vendor, no ticket, no code.
  // Many of these firms are on a managed platform -- the Airtable schema
  // carries "Is your current site on FMG?" -- and cannot edit any of this.
  const TECHNICAL = /robots\.txt|llms\.txt|schema markup|structured data|JSON-LD|developer|web ?master|HTML|CSS|DNS|canonical|hreflang|plugin|API/i;
  RD.KEEP_GOING.forEach((k, i) => {
    const hit = (k.title + ' ' + k.text).match(TECHNICAL);
    check(`  ${i + 1}. asks for nothing technical`, !hit, hit && hit[0]);
  });
  // Every item has to say which of the two it serves, or it is just advice.
  RD.KEEP_GOING.forEach((k, i) => {
    check(`  ${i + 1}. names the gain — SEO, AEO or both`,
          /SEO|AEO/.test(k.meta), k.meta);
  });
  // None of them is a check, so none may be phrased as one.
  RD.KEEP_GOING.forEach((k, i) => {
    check(`  ${i + 1}. is not written as a question to be ticked`,
          !/^(is|are|do|does|have|has)\b/i.test(k.title) && !k.title.endsWith('?'),
          k.title);
  });

  // ── rendered ───────────────────────────────────────────────────────────────
  const b = await chromium.launch({
    executablePath: require('../chromium-path.js')() });
  const page = await b.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(PAGE);

  const build = n => page.evaluate(nIn => {
    UNK.clear();
    document.querySelectorAll('.ci input').forEach(i => i.checked = true);
    CHECKS.filter(c => gtextFor(c.id)).slice(0, nIn)
          .forEach(c => { document.getElementById(c.id).checked = false; });
    recalc();
    const d = assembleReport();
    const A = window.REPORT_ASSETS;
    const doc = buildReportDoc(d, { logoWhite: A.logoWhite, logoPurple: A.logoPurple, coverBg: A.cover });
    return { json: JSON.stringify(doc.content), actions: d.actions.length,
             failedCount: d.failedCount, overall: d.scores.overall,
             needWork: d.needWork, kpi: d.kpiPassed, pts: d.ptsAvailable,
             // Every page opens with a heading beside the logo. Reading them
             // in order is how the page ORDER gets asserted, rather than by
             // counting pages and hoping.
             headings: doc.content.filter(e => e && e.columns && e.columns.length === 2 &&
                         typeof e.columns[0].text === 'string' && e.columns[1] &&
                         e.columns[1].svg).map(e => e.columns[0].text),
             // Does the next-steps heading carry its own page break? Asked of
             // the object, not of the JSON: columns[1] is an inlined SVG logo,
             // so the two keys are thousands of characters apart in the text.
             kgBreak: (doc.content.find(e => e && e.columns && e.columns[0] &&
                         e.columns[0].text === 'What comes after the checklist') || {}).pageBreak };
  }, n);

  console.log('\nC. a firm that passed everything now ends on something to do');
  let r = await build(0);
  check('it still scores 100', r.overall === 100, String(r.overall));
  check('with nothing failing', r.failedCount === 0, String(r.failedCount));
  check('page 2 still reports no priority fixes, honestly',
        r.json.includes('No priority fixes'));
  check('and the report carries the next-steps page',
        r.json.includes('What comes after the checklist'));
  RD.KEEP_GOING.forEach((k, i) => {
    check(`  item ${i + 1} is on it`, r.json.includes(JSON.stringify(k.title).slice(1, -1)),
          k.title.slice(0, 40));
  });

  console.log('\nD. and it has not been scored');
  check('the score is untouched by five undone habits', r.overall === 100);
  check('the KPI tally counts forty checks, not forty-five',
        / of 40$/.test(r.kpi), r.kpi);
  check('nothing is reported as needing work', r.needWork === '0 items', r.needWork);
  check('no points are claimed for them', r.pts === '+0 pts', r.pts);
  check('and failedCount stays at nought', r.failedCount === 0, String(r.failedCount));

  console.log('\nE. it does not read as a page of failures');
  // Everything that marks a scorecard row as wrong: the state chips, the
  // "Not measured" legend, the per-item point values. None belongs here.
  const kgBlock = r.json.slice(r.json.indexOf('What comes after the checklist'));
  check('no state chips on it', !/"Not measured"|Needs work/.test(kgBlock));
  check('no point values', !/\+\d+ pts/.test(kgBlock));
  check('it says in its first sentence that none of this is scored',
        /None of these five is scored/.test(kgBlock));
  check('and that the score does not move if they are left',
        /score does not change/.test(kgBlock));
  check('and that no developer is needed',
        /without a developer/.test(kgBlock));

  console.log('\nF. where it sits');
  check('page 2 is still the priorities page — nothing was displaced',
        r.headings[0] === 'No priority fixes' ||
        /^Do the/.test(r.headings[0]), JSON.stringify(r.headings));
  check('and the scorecards still follow it',
        r.headings.indexOf('Company Visibility') === 1, JSON.stringify(r.headings));
  check('and the next-steps page is last',
        r.headings[r.headings.length - 1] === 'What comes after the checklist',
        JSON.stringify(r.headings));
  check('it starts a page of its own rather than running on from a scorecard',
        r.kgBreak === 'before', JSON.stringify(r.kgBreak));

  console.log('\nG. a firm with real work to do is not handed homework instead');
  for (const n of [5, 8]) {
    const x = await build(n);
    check(`${n} failing checks → no next-steps page`,
          !x.json.includes('What comes after the checklist') &&
          x.json.includes('things first'),
          x.actions + ' rows, ' + x.failedCount + ' failing');
  }
  console.log('\nH. and it appears as the checklist runs out');
  for (const n of [1, 4]) {
    const x = await build(n);
    check(`${n} failing → both the fixes AND the next steps`,
          x.json.includes('What comes after the checklist') &&
          /things first|thing first/.test(x.json),
          x.actions + ' rows, ' + x.failedCount + ' failing');
  }

  check('\nzero page errors', errs.length === 0, errs.join(' | ') || 'none');
  await b.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})();
