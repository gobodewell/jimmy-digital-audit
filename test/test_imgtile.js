// The "Images over 500 KB" tile printed 0 on a page whose own "Are all images
// sized under 500 KB?" row was failing, two inches below it. The tile was
// counting lh.imgList -- Lighthouse's "these could be optimised" list, which
// answers a different question and is routinely empty on a page that still
// serves one oversized image. The check was counting the network log. Two
// numbers, one label, and the report contradicted itself in front of a client.
//
// The tile now reads imgOverCount, which is the count the check is made of.
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

  // Build a report with a given /site/lighthouse payload and read back the
  // Website Performance tile and the state of the check beside it.
  const build = lh => page.evaluate(lhIn => {
    UNK.clear();
    document.querySelectorAll('.ci input').forEach(i => i.checked = true);
    AD.lh = lhIn;
    // Mirror what runLighthouse does with the same payload.
    const el = document.getElementById('c-img');
    el.checked = lhIn.imagesOk === true;
    if (lhIn.imagesOk == null) UNK.set('c-img', 'PageSpeed returned no per-image sizes');
    recalc();
    const d = assembleReport();
    const w = d.sections.find(s => s.name === 'Website Performance');
    const v = d.sections.find(s => s.name === 'Company Visibility');
    const tile = w.tiles.find(t => t.label === 'Images over 500 KB');
    const row  = w.groups.flatMap(g => g.items).find(i => /images sized under 500/i.test(i.q));
    return { tile, state: row && row.state,
             daUnit: (v.tiles.find(t => t.label === 'Domain authority') || {}).unit };
  }, lh);

  // The real shape of the payload for the reported page: one image over the
  // limit in the network log, and nothing in Lighthouse's optimisation list.
  console.log('\nA. one oversized image, empty optimisation list — the case reported');
  let r = await build({ imagesOk: false, imgOverCount: 1, imgLimitKb: 500,
                        imgOver: [{ name: 'hero.jpg', kb: 740 }], imgList: [],
                        byType: [{ type: 'image', kb: 2400, count: 33 }] });
  check('the tile counts it', r.tile.value === 1, JSON.stringify(r.tile.value));
  check('and does not read as a pass', r.tile.ok === false, String(r.tile.ok));
  check('the check beside it failed', r.state === 'fail', r.state);
  check('tile and check agree', (r.tile.value === 0) === (r.state === 'pass'),
        r.tile.value + ' vs ' + r.state);
  check('the denominator is the image count', r.tile.unit === 'of 33', r.tile.unit);

  console.log('\nB. genuinely clean page — a real zero');
  r = await build({ imagesOk: true, imgOverCount: 0, imgOver: [], imgList: [],
                    byType: [{ type: 'image', kb: 300, count: 12 }] });
  check('tile is zero', r.tile.value === 0, JSON.stringify(r.tile.value));
  check('and reads as a pass', r.tile.ok === true, String(r.tile.ok));
  check('the check passed too', r.state === 'pass', r.state);

  console.log('\nC. not measured is not zero');
  // imgOverCount is 0 both when nothing is over the limit and when nothing was
  // looked at. Printing that as a confident zero is the failure this audit is
  // built to avoid.
  r = await build({ imagesOk: null, imgOverCount: 0, imgOver: [], imgList: [],
                    byType: [] });
  check('tile is blank, not zero', r.tile.value === null, JSON.stringify(r.tile.value));
  check('the check is unmeasured', r.state === 'unknown', r.state);

  console.log('\nD. a long optimisation list does not become the count');
  // The old reading would have said 4 here.
  r = await build({ imagesOk: true, imgOverCount: 0, imgOver: [],
                    imgList: [{name:'a'},{name:'b'},{name:'c'},{name:'d'}],
                    byType: [{ type: 'image', kb: 900, count: 20 }] });
  check('still zero over the limit', r.tile.value === 0, JSON.stringify(r.tile.value));

  console.log('\nE. domain authority carries no vendor name');
  check('unit is just the scale', r.daUnit === '/ 100', r.daUnit);

  console.log('\nF. page health');
  check('zero page errors', errs.length === 0, errs.join(' | ') || 'none');
  await b.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})();
