// Writes a spreadsheet of every check with no approved recommendation copy.
//
// Page 2 prints only wording from SA_Digital_Audit_Questions, so a check with
// no row there is passed over rather than written up in the tool's own words.
// This lists what is still missing, in that sheet's own column layout, so a
// completed row pastes straight back into it.
//
// Generated rather than kept as a file, because the answer changes every time
// the sheet is filled in and a stale snapshot is worse than none.
//
//   node tools/copy-gaps.js [output.xlsx]
const path = require('path');
const cp   = require('child_process');
const { chromium } = require('playwright');

const OUT   = process.argv[2] || path.resolve(__dirname, '..', 'Audit copy gaps.xlsx');
const INDEX = 'file://' + path.resolve(__dirname, '..', 'index.html');
const SHEET = path.resolve(__dirname, '..', 'reference', 'SA_Digital_Audit_Questions.xlsx');

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await b.newPage();
  await page.goto(INDEX);
  const gaps = await page.evaluate(() => {
    const CATN = { v: 'Company', w: 'Website', s: 'Social' };
    return CHECKS.filter(c => !GTEXT[c.id]).map(c => ({
      id: c.id, cat: CATN[c.cat], grp: c.grp, aeo: c.aeo ? 'AEO' : '',
      // What the fix is worth to the overall score, which is what orders the
      // list: raw points are not comparable across categories.
      impact: +(c.pts * CAT_WEIGHT[c.cat] * (100 - SCORE_FLOOR) / 100).toFixed(2),
      q: c.q
    })).sort((a, b) => b.impact - a.impact);
  });
  await b.close();

  console.log(gaps.length + ' checks have no approved copy');
  cp.execSync('python3 ' + path.join(__dirname, 'copy-gaps.py') + ' ' +
    JSON.stringify(JSON.stringify(gaps)) + ' ' + JSON.stringify(SHEET) + ' ' + JSON.stringify(OUT),
    { stdio: 'inherit' });
})();
