// Two readings of the same page, disagreeing on screen.
//
// Reported on a real audit: the technology panel listed "Google Analytics"
// while the Visibility tab said the check had not passed. Both read the SAME
// list of requests PageSpeed observed, and the check's pattern is a superset
// of the panel's, so within one response they cannot honestly disagree.
//
// Two things come out of that. A reading that saw no GA must not be able to
// clear a box something else positively observed -- a request to
// googletagmanager.com proves the tag is there, while not seeing one can just
// be an ad blocker, a consent banner, or a tag injected after the page was
// read. And when the two do end up out of step, the screen has to say so
// rather than show both and leave the reviewer to notice.
const path = require('path');
const { chromium } = require('playwright');

let failures = 0;
const check = (l, c, d) => {
  console.log((c ? '  PASS  ' : '  FAIL  ') + l + (d ? '   → ' + d : ''));
  if (!c) failures++;
};

(async () => {
  const b = await chromium.launch({ executablePath: require('../chromium-path.js')() });
  const p = await b.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('file://' + path.resolve(__dirname, '..', 'index.html'));

  // applyExtension() takes no arguments: it reads the textarea and refuses
  // anything without the extension's own source marker. The first version of
  // this file called applyExtension({analytics:false}) instead, which returned
  // at "Nothing pasted." and left the box exactly as it was -- so the test
  // reported a PASS for a code path it never reached. The assertion that read
  // document.body.textContent was worse: index.html keeps its script inline, so
  // textContent includes the source, and the regex matched the string in the
  // code it was supposed to be testing.
  const paste = (obj) => p.evaluate(o => {
    document.getElementById('extPaste').value =
      JSON.stringify(Object.assign({ source: 'growthline-extension/1.0' }, o));
    applyExtension();
    return { box: document.getElementById('c-ga').checked,
             msg: document.getElementById('extMsg').textContent };
  }, obj);

  console.log('\nA. a reading that saw nothing cannot clear a positive sighting');
  await p.evaluate(() => { UNK.clear(); DIRECT.clear(); ck('c-ga'); measured('c-ga'); });
  let r = await paste({ analytics: false });
  check('the reading was actually applied, not refused',
        !/Nothing pasted|did not come from/.test(r.msg), r.msg.slice(0, 70));
  check('and it did NOT clear the box', r.box === true, 'box = ' + r.box);

  console.log('\nB. the disagreement is said out loud, not resolved in silence');
  check('the message reports it was left as YES',
        /Left as YES/.test(r.msg), r.msg.slice(0, 120));
  check('and gives the reason rather than just the verdict',
        /ad blocker|consent banner/.test(r.msg));

  console.log('\nC. a positive reading still ticks an unticked box');
  await p.evaluate(() => {
    UNK.clear(); DIRECT.clear(); document.getElementById('c-ga').checked = false; });
  r = await paste({ analytics: true, analyticsIds: ['G-0XY17VH6YX'] });
  check('a reading that DOES see it ticks the box', r.box === true, 'box = ' + r.box);

  console.log('\nD. nothing had seen it, so a NO still stands');
  await p.evaluate(() => {
    UNK.clear(); DIRECT.clear(); document.getElementById('c-ga').checked = false; });
  r = await paste({ analytics: false });
  check('an unticked box stays unticked', r.box === false);
  check('and that is not reported as a disagreement', !/Left as YES/.test(r.msg));

  console.log('\nD2. the rule is narrow — other checks can still be corrected to NO');
  const cta = await p.evaluate(() => {
    const box = document.getElementById('c-cta');
    if (!box) return { skip: true };
    UNK.clear(); DIRECT.clear(); box.checked = true;
    document.getElementById('extPaste').value = JSON.stringify({
      source: 'growthline-extension/1.0', weakCtaCount: 3,
      weakCtaExamples: ['Learn More', 'Click Here', 'Read More'] });
    applyExtension();
    return { skip: false, cleared: !box.checked };
  });
  check('a non-GA check is still corrected to NO by the reading',
        cta.skip || cta.cleared === true,
        cta.skip ? 'no c-cta on the page' : 'cleared = ' + cta.cleared);

  console.log('\nE. and if they ever disagree, the panel says so');
  r = await p.evaluate(() => {
    document.getElementById('c-ga').checked = false;
    renderTech({ tech: [{ group: 'Analytics', name: 'Google Analytics',
                          via: 'a request the page made' }] });
    return document.getElementById('tech-body').innerHTML;
  });
  check('the contradiction is stated on the panel', /These two disagree/.test(r));
  check('naming the chip and the check',
        /Google Analytics/.test(r) && /not ticked/.test(r));
  check('and telling the reviewer to resolve it before approving',
        /check it before you approve/.test(r));

  r = await p.evaluate(() => {
    document.getElementById('c-ga').checked = true;
    renderTech({ tech: [{ group: 'Analytics', name: 'Google Analytics',
                          via: 'a request the page made' }] });
    return document.getElementById('tech-body').innerHTML;
  });
  check('and says nothing when they agree', !/These two disagree/.test(r));

  check('zero page errors', errs.length === 0, errs.join(' | ') || 'none');
  await b.close();
  console.log();
  console.log(failures ? failures + ' check(s) failed' : 'all checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.log('  FAIL  threw: ' + e.message); process.exit(1); });
