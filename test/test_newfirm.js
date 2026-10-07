// The firm that has just started.
//
// No backlinks, no rankings, no reviews, nothing in the Google listing, no
// logo on the LinkedIn page. Every one of those is a real finding and the
// reason the firm is being audited at all.
//
// The audit had no way to say any of it. ck() recorded a pass and unk()
// recorded that nothing could be read, and a check that was genuinely looked
// at and genuinely came back NO fell between them: an unticked box, no reason,
// no record of having been measured -- byte-for-byte what a check that never
// ran leaves behind.
//
// So the grounding guard, which exists to stop an unreachable site being
// scored 61 "Critical", read those honest findings as silence and refused to
// score the run. Breeches Wealth Group: 21 "would have counted against this
// firm with nothing checked" against 19 grounded, from a run that completed
// in 310 seconds and had looked at all of them. The audit threw away its
// results hardest for the firms it helps most.
process.env.CHROMIUM_PATH = process.env.CHROMIUM_PATH ||
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const path = require('path');

let failures = 0;
const check = (l, c, d) => {
  console.log((c ? '  PASS  ' : '  FAIL  ') + l + (d ? '   -> ' + d : ''));
  if (!c) failures++;
};

(async () => {
  let browser;
  try {
    const pw = require('playwright');
    browser = await pw.chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
    const page = await (await browser.newContext()).newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    await page.goto('file://' + path.join(__dirname, '..', 'index.html'),
                    { waitUntil: 'load', timeout: 60000 });
    check('the page loads with no script errors', errs.length === 0, errs.join(' | '));

    console.log('\nA. a source that answered NO is a measurement');
    let r = await page.evaluate(() => {
      const out = {};
      decide('c-da5', false, 'no authority score returned');
      out.ticked    = document.getElementById('c-da5').checked;
      out.measured  = DIRECT.has('c-da5');
      out.unknown   = UNK.has('c-da5');
      return out;
    });
    check('the box is not ticked — it did not pass', r.ticked === false);
    check('but it IS recorded as measured', r.measured === true);
    check('and it is not filed as unknown', r.unknown === false);

    console.log('\nB. a source that said nothing is still unknown');
    r = await page.evaluate(() => {
      decide('c-gbp-r', null, 'no review count in the listing data');
      return { measured: DIRECT.has('c-gbp-r'), unknown: UNK.has('c-gbp-r'),
               why: UNK.get('c-gbp-r') };
    });
    check('not claimed as measured', r.measured === false);
    check('recorded as unknown, with the reason kept', r.unknown === true &&
          /review count/.test(r.why || ''), r.why);

    console.log('\nC. a true answer still passes, and still counts as measured');
    r = await page.evaluate(() => {
      decide('c-sln', true);
      return { ticked: document.getElementById('c-sln').checked,
               measured: DIRECT.has('c-sln') };
    });
    check('ticked', r.ticked === true);
    check('and measured', r.measured === true);

    console.log('\nD. a later answer can correct an earlier one');
    r = await page.evaluate(() => {
      decide('c-https', true);
      const after1 = document.getElementById('c-https').checked;
      decide('c-https', false);
      return { after1, after2: document.getElementById('c-https').checked,
               measured: DIRECT.has('c-https') };
    });
    check('true then false ends false — not stuck on the first answer',
          r.after1 === true && r.after2 === false);
    check('and stays measured throughout', r.measured === true);

    console.log('\nE. the whole point: a new firm is scoreable');
    r = await page.evaluate(() => {
      // Wipe the slate, then answer every check the way a three-month-old firm
      // answers: looked at, and no.
      UNK.clear(); DIRECT.clear(); JUDGED.clear();
      const ids = [...document.querySelectorAll('input[id^="c-"]')].map(e => e.id);
      ids.forEach(id => decide(id, false));
      const ticked = id => !!(document.getElementById(id) || {}).checked;
      // The runner's own arithmetic, repeated here.
      const silent = ids.filter(id =>
        !ticked(id) && !UNK.has(id) && !DIRECT.has(id) && !JUDGED.has(id));
      const grounded = ids.filter(id =>
        ticked(id) || UNK.has(id) || DIRECT.has(id) || JUDGED.has(id));
      return { total: ids.length, silent: silent.length, grounded: grounded.length,
               ungrounded: silent.length > grounded.length };
    });
    check('all forty checks are accounted for', r.total === 40, String(r.total));
    check('not one of them is a silent failure', r.silent === 0,
          r.silent + ' silent');
    check('every one rests on something', r.grounded === 40, String(r.grounded));
    check('so the run is NOT refused a score', r.ungrounded === false,
          r.silent + ' silent vs ' + r.grounded + ' grounded');

    console.log('\nF. a model verdict grounds a check without becoming a measurement');
    r = await page.evaluate(() => {
      UNK.clear(); DIRECT.clear(); JUDGED.clear();
      judged('c-awd');
      const a = { judged: JUDGED.has('c-awd'), direct: DIRECT.has('c-awd') };
      // And a measurement wins: judged() must not shadow a real reading.
      measured('c-rcta'); judged('c-rcta');
      a.measuredStays = DIRECT.has('c-rcta') && !JUDGED.has('c-rcta');
      return a;
    });
    check('the verdict is recorded', r.judged === true);
    check('but not as a measurement, so a real reading can still overrule it',
          r.direct === false);
    check('and judging something already measured changes nothing',
          r.measuredStays === true);

    console.log('\nG. all three survive a save and reopen');
    r = await page.evaluate(() => {
      UNK.clear(); DIRECT.clear(); JUDGED.clear();
      decide('c-da5', false); judged('c-awd'); unk('c-gbp-r', 'nothing returned');
      const st = auditState();
      UNK.clear(); DIRECT.clear(); JUDGED.clear();
      applyState(st);
      return { direct: DIRECT.has('c-da5'), judged: JUDGED.has('c-awd'),
               unk: UNK.has('c-gbp-r') };
    });
    check('the measurement survives', r.direct === true);
    check('the judgement survives', r.judged === true);
    check('the unknown survives', r.unk === true);

    check('and the page still threw nothing', errs.length === 0, errs.join(' | '));
  } catch (e) {
    console.log('  FAIL  threw: ' + e.message); failures++;
  } finally { if (browser) await browser.close(); }

  console.log();
  console.log(failures ? failures + ' check(s) failed' : 'all checks passed');
  process.exit(failures ? 1 : 0);
})();
