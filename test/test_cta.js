// One generic call to action is a page that needed one. Two is a habit.
//
// "Descriptive CTAs" was a modelled check -- a judgement -- and the browser
// extension already counted the generic ones exactly, then threw the number
// away with a comment saying a judgement could not be scored from it. It can:
// the count is a fact, and the rule turns the fact into the decision. A link
// whose whole text is "Learn more" describes the mechanics of clicking rather
// than what happens next, and a site that reaches for one twice is reaching
// for it by habit.
const path = require('path');
const fs   = require('fs');
process.env.CHROMIUM_PATH = process.env.CHROMIUM_PATH ||
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let failures = 0;
const check = (l, c, d) => {
  console.log((c ? '  PASS  ' : '  FAIL  ') + l + (d ? '   -> ' + d : ''));
  if (!c) failures++;
};

const reading = (n, examples) => JSON.stringify({
  source: 'growthline-extension/1.0.0', url: 'https://example.com',
  host: 'example.com', bytes: 1000,
  weakCtaCount: n, weakCtaExamples: examples || []
});

(async () => {
  let browser;
  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
    const page = await browser.newPage();
    const errs = []; page.on('pageerror', e => errs.push(e.message));
    await page.goto('file://' + path.resolve(__dirname, '..', 'index.html'),
                    { waitUntil: 'load', timeout: 60000 });

    const apply = json => page.evaluate(j => {
      UNK.clear(); DIRECT.clear(); JUDGED.clear();
      document.getElementById('c-cta').checked = false;
      document.getElementById('extPaste').value = j;
      applyExtension();
      return { ticked: document.getElementById('c-cta').checked,
               measured: DIRECT.has('c-cta'),
               unknown: UNK.has('c-cta'),
               msg: document.getElementById('extMsg').textContent };
    }, json);

    console.log('\nA. the count decides it');
    let r = await apply(reading(0));
    check('none on the page passes', r.ticked === true && r.measured === true,
          JSON.stringify(r.ticked) + '/' + r.measured);

    r = await apply(reading(1, ['learn more']));
    check('exactly one still passes — a page is allowed one',
          r.ticked === true && r.measured === true);
    check('and the reading says which one it found',
          /one generic CTA \(learn more\)/.test(r.msg), r.msg.slice(0, 120));

    r = await apply(reading(2, ['learn more', 'click here']));
    check('two does not pass', r.ticked === false, String(r.ticked));
    check('and it is recorded as MEASURED, not as a guess that failed',
          r.measured === true && r.unknown === false,
          'measured ' + r.measured + ', unknown ' + r.unknown);

    r = await apply(reading(6, ['learn more']));
    check('six of the same wording is six, not one', r.ticked === false);

    console.log('\nB. a reading with no count at all leaves it alone');
    r = await page.evaluate(() => {
      UNK.clear(); DIRECT.clear(); JUDGED.clear();
      document.getElementById('c-cta').checked = true;   // the model said yes
      document.getElementById('extPaste').value = JSON.stringify({
        source: 'growthline-extension/1.0.0', host: 'example.com', bytes: 10 });
      applyExtension();
      return { ticked: document.getElementById('c-cta').checked,
               measured: DIRECT.has('c-cta') };
    });
    check('an older extension build does not silently fail the check',
          r.ticked === true, String(r.ticked));
    check('and nothing is claimed as measured', r.measured === false);

    console.log('\nC. the measurement outranks the model');
    r = await page.evaluate(() => {
      UNK.clear(); DIRECT.clear(); JUDGED.clear();
      document.getElementById('c-cta').checked = false;
      document.getElementById('extPaste').value = JSON.stringify({
        source: 'growthline-extension/1.0.0', host: 'x.com', bytes: 10,
        weakCtaCount: 3, weakCtaExamples: ['learn more'] });
      applyExtension();
      const accepted = ckAI('c-cta');        // the AI pass tries to tick it
      return { accepted, ticked: document.getElementById('c-cta').checked };
    });
    check('an AI pass cannot overturn a counted failure',
          r.accepted === false && r.ticked === false,
          'accepted ' + r.accepted + ', ticked ' + r.ticked);

    console.log('\nD. the same rule where a model has to judge it');
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');
    const def = (/- ctas:[\s\S]*?(?=\n- resources:)/.exec(src) || [''])[0];
    check('the prompt says to count the generic ones',
          /count the generic ones rather than judging the good ones/.test(def));
    check('it names one as acceptable and two as not',
          /ONE of those on a page is fine/.test(def) &&
          /TWO OR MORE/.test(def), def.slice(0, 80));
    check('and says to count instances, not distinct wordings',
          /not distinct wordings/.test(def));
    check('the advice the client reads carries the same rule',
          /two or more is a habit/.test(src));

    check('the page threw nothing throughout', errs.length === 0, errs.join(' | '));
  } catch (e) {
    console.log('  FAIL  threw: ' + e.message); failures++;
  } finally { if (browser) await browser.close(); }

  console.log();
  console.log(failures ? failures + ' check(s) failed' : 'all checks passed');
  process.exit(failures ? 1 : 0);
})();
