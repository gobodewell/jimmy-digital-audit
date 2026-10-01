// Renders the real PDF from the real page and saves page 1 as a PNG, so cover
// layout is judged by looking at it rather than by assertion.
const path = require('path');
const fs = require('fs');
const PAGE = 'file://' + path.resolve(__dirname, '..', 'index.html');
const { chromium } = require('playwright');

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await (await b.newContext({ ignoreHTTPSErrors: true })).newPage();
  page.on('pageerror', e => console.error('PAGE ERROR:', e.message));
  page.on('console', m => { if (m.type()==='error') console.error('CONSOLE:', m.text().slice(0,160)); });
  await page.goto(PAGE);

  // BAND_MAX renders the worst case for the projection band -- a firm already
  // at 100 projected to 100 -- so three-digit scores are exercised for real
  // rather than assumed to fit.
  const MAX = !!process.env.BAND_MAX;
  const b64 = await page.evaluate(async (MAX) => {
    // A realistic run: the figures from the screenshot the cover was critiqued on.
    document.getElementById('clientName').value = 'Totus wealth Managment';
    document.getElementById('clientURL').value  = 'https://totuswm.com';
    AD.url = 'https://totuswm.com'; AD.name = 'Totus wealth Managment';
    AD.coverSummary = 'Your firm is performing well overall, with strong visibility and social ' +
      'media scores driving an on-track 89/100 rating and 15 of 19 answer-engine checks passed. ' +
      'The biggest drag on performance is mobile optimization, compounded by a 4.72MB homepage ' +
      'size well above the 3MB benchmark. Fixing this is achievable and should strengthen your ' +
      'website performance score.';
    // Tick enough boxes to land near the screenshot's scores.
    const ids = [...document.querySelectorAll('.ci input')].map(i => i.id);
    ids.slice(0, 29).forEach(id => { const e = document.getElementById(id); if (e) e.checked = true; });
    recalc();
    const A = window.REPORT_ASSETS;
    pdfMake.vfs   = Object.assign({}, pdfMake.vfs || {}, A.vfs);
    pdfMake.fonts = A.fonts;
    const d = assembleReport();
    if (MAX) { d.scores.overall = 100; d.projected = 100; }
    const doc = buildReportDoc(d, { logoWhite: A.logoWhite, logoPurple: A.logoPurple, coverBg: A.cover });
    return await new Promise(res => pdfMake.createPdf(doc).getBase64(x => res(x)));
  }, MAX);

  const name = MAX ? 'band.pdf' : 'cover.pdf';
  fs.writeFileSync(path.resolve(__dirname, name), Buffer.from(b64, 'base64'));
  console.log('wrote test/' + name);
  await b.close();
})();
