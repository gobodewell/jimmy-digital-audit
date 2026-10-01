// TOP_N is the MOST page 2 carries, not a quota -- but the report spoke the
// constant rather than the list. A firm with two failing checks got two rows
// under "Do these five things first", a cover promising a gain "available in
// five fixes", and a band reading "Completing all five moves this firm from
// Strong into the Strong band": five fixes that were not there, and a move
// from a band into itself.
//
// And a firm that passed everything got no report at all. pdfmake throws on a
// table with no rows, so the best result the audit can give crashed the build.
const path = require('path');
const PAGE = 'file://' + path.resolve(__dirname, '..', 'index.html');
const { chromium } = require('playwright');
let failures = 0;
const check = (l, c, d) => {
  console.log((c ? '  PASS  ' : '  FAIL  ') + l + (d ? '   → ' + d : ''));
  if (!c) failures++;
};

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await b.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(PAGE);

  // Fail exactly n checks that HAVE approved copy, so each one reaches page 2.
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
             failedCount: d.failedCount, overall: d.scores.overall, projected: d.projected };
  }, n);

  console.log('\nA. the page says how many fixes it is actually showing');
  for (const [n, head, cover] of [
    [5, 'Do these five things first',  'available in five fixes'],
    [3, 'Do these three things first', 'available in three fixes'],
    [2, 'Do these two things first',   'available in two fixes'],
    [1, 'Do this one thing first',     'available in one fix']
  ]) {
    const r = await build(n);
    check(`${n} failing → "${head}"`, r.json.includes(head) && r.actions === n,
          r.actions + ' rows');
    check(`   and the cover says "${cover}"`, r.json.includes(cover));
    check('   no other count is claimed',
          !/Do these (five|four|three|two) things first[\s\S]*Do these/.test(r.json));
  }

  console.log('\nB. the projection band does not invent a move between bands');
  let r = await build(2);
  check('"all two" is not printed', !r.json.includes('Completing all two'));
  check('it reads "Completing both"', r.json.includes('Completing both'));
  // Same band at both ends: the points are real, the move is not.
  const same = /holding this firm in the/.test(r.json);
  const moved = /moves this firm from/.test(r.json);
  check('it either holds the band or moves it, never both', same !== moved,
        'holding=' + same + ' moved=' + moved);
  if (same) check('   and never claims a move into its own band',
        !/from .{0,40}into the/.test(r.json.replace(/\\"/g, '"')));

  console.log('\nC. one fix speaks in the singular throughout');
  r = await build(1);
  check('heading', r.json.includes('Do this one thing first'));
  check('band', r.json.includes('Completing this one'));
  check('cover', r.json.includes('available in one fix') &&
                 !r.json.includes('available in one fixes'));

  console.log('\nD. a firm that passes everything still gets a report');
  r = await build(0);
  check('the report built at all', !!r.json, 'it threw before this fix');
  check('no rows claimed', r.actions === 0 && r.failedCount === 0,
        r.actions + '/' + r.failedCount);
  check('headed honestly', r.json.includes('No priority fixes'));
  check('and says what that means', r.json.includes('No measured check failed'));
  check('no "Do these" heading', !/Do these|Do this one/.test(r.json));
  check('no projection band with nothing to project',
        !/Completing/.test(r.json));
  check('the cover does not promise fixes', r.json.includes('no fixes listed'));
  check('the CTA still ships', r.json.includes('Schedule a Free Digital Audit Review'));

  console.log('\nE. page health');
  check('zero page errors', errs.length === 0, errs.join(' | ') || 'none');
  await b.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})();
