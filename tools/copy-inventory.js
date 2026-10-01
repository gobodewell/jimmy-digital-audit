// Writes a spreadsheet of ALL 40 checks: what each one is worth, its question,
// and the approved headline and copy where there is any.
//
// The value column is what the whole thing turns on. It is not the raw points
// on the check: each category totals 100 raw points but they are weighted
// 40/35/25, so raw points are not comparable between them. This is the score
// the overall grade gains if that one check flips to pass, which is also what
// orders page 2.
//
// Generated rather than kept as a file, because it changes whenever the sheet
// is filled in and a stale snapshot is worse than none.
//
//   node tools/copy-inventory.js [output.xlsx]
const path = require('path');
const cp   = require('child_process');
const { chromium } = require('playwright');

const OUT   = process.argv[2] || path.resolve(__dirname, '..', 'Audit copy inventory.xlsx');
const INDEX = 'file://' + path.resolve(__dirname, '..', 'index.html');

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await b.newPage();
  await page.goto(INDEX);
  const rows = await page.evaluate(() => {
    const CATN = { v: 'Company Visibility', w: 'Website Performance', s: 'Social Media' };
    return CHECKS.map(c => {
      // Approved first, draft second -- the same order the report uses -- and
      // the source is reported, because "whose words are these" is the whole
      // question this sheet exists to answer.
      const approved = GTEXT[c.id] || null;
      const g = approved || GTEXT_DRAFT[c.id] || null;
      const src = approved ? 'approved' : (g ? 'draft' : '');
      return {
        id: c.id,
        cat: CATN[c.cat],
        grp: c.grp,
        aeo: c.aeo ? 'AEO' : '',
        pts: c.pts,
        value: +(c.pts * CAT_WEIGHT[c.cat] * (100 - SCORE_FLOOR) / 100).toFixed(2),
        q: c.q,
        title: g ? g.title : '',
        text:  g ? g.text  : '',
        src
      };
    }).sort((a, b) => b.value - a.value || b.pts - a.pts)
      .map((r, i) => Object.assign({ rank: i + 1 }, r));
  });
  await b.close();

  const n = k => rows.filter(r => r.src === k).length;
  console.log(rows.length + ' checks · ' + n('approved') + ' approved · ' +
              n('draft') + ' draft · ' + rows.filter(r => !r.src).length + ' with no copy');
  cp.execSync('python3 ' + path.join(__dirname, 'copy-inventory.py') + ' ' +
    JSON.stringify(JSON.stringify(rows)) + ' ' + JSON.stringify(OUT), { stdio: 'inherit' });
})();
