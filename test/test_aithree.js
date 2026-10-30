// The model's three answers, and the two the code could tell apart.
//
// The prompt is explicit: true means it read the page and the thing is there,
// false means it read the page and it is not, null means it could not look.
// "false is a finding reported to the client as something their firm is doing
// wrong; null says nobody could check. Reporting a failure for a page you
// never saw is the one mistake this audit must not make."
//
// Every caller then read `if (j.faqs) ckAI('c-faq')`. Only a yes did anything.
// A no and a could-not-look produced the identical state: an unticked box, not
// judged, not unknown, no reason kept -- byte for byte what a check that never
// ran leaves behind. 18 of 31 stored audits carry that for c-faq, and 8 of
// them are runs where the model said in its own JSON that it could not read
// the site.
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

  const state = id => p.evaluate(i => ({
    ticked:  !!document.getElementById(i).checked,
    judged:  JUDGED.has(i),
    direct:  DIRECT.has(i),
    unknown: UNK.has(i),
    why:     UNK.get(i) || null
  }), id);

  console.log('\nA. yes — read the page, the thing is there');
  await p.evaluate(() => { UNK.clear(); DIRECT.clear(); JUDGED.clear();
                           document.getElementById('c-faq').checked = false;
                           decideAI('c-faq', true); });
  let r = await state('c-faq');
  check('ticked', r.ticked === true);
  check('and grounded as a judgement, not a measurement',
        r.judged === true && r.direct === false);

  console.log('\nB. no — read the page, the thing is NOT there');
  await p.evaluate(() => { UNK.clear(); DIRECT.clear(); JUDGED.clear();
                           document.getElementById('c-faq').checked = false;
                           decideAI('c-faq', false); });
  r = await state('c-faq');
  check('not ticked — it did not pass', r.ticked === false);
  check('but it IS grounded: somebody looked and the answer was no',
        r.judged === true);
  check('and it is not filed as unknown', r.unknown === false);

  console.log('\nC. could not look — and this is the one that used to vanish');
  await p.evaluate(() => { UNK.clear(); DIRECT.clear(); JUDGED.clear();
                           document.getElementById('c-faq').checked = false;
                           decideAI('c-faq', null, 'the model could not load the site'); });
  r = await state('c-faq');
  check('not ticked', r.ticked === false);
  check('NOT claimed as judged — nobody answered it', r.judged === false);
  check('recorded as unknown, with the reason kept', r.unknown === true &&
        /could not load/.test(r.why || ''), r.why);

  console.log('\nD. the three are now distinguishable, which is the whole point');
  r = await p.evaluate(() => {
    const snap = v => { UNK.clear(); DIRECT.clear(); JUDGED.clear();
      document.getElementById('c-faq').checked = false;
      decideAI('c-faq', v, 'could not read');
      return [document.getElementById('c-faq').checked,
              JUDGED.has('c-faq'), UNK.has('c-faq')].join(','); };
    return { yes: snap(true), no: snap(false), dunno: snap(null) };
  });
  check('a no and a could-not-look are no longer the same state',
        r.no !== r.dunno, 'no=' + r.no + '  dunno=' + r.dunno);
  check('and neither is a yes', r.yes !== r.no && r.yes !== r.dunno);

  console.log('\nE. a measurement still outranks the model, in BOTH directions');
  // The guard ckAI already had. A model saying no must not clear a box the
  // page itself was read for -- that is the inversion this audit exists to
  // prevent, and it applies to a no exactly as much as to a yes.
  r = await p.evaluate(() => {
    UNK.clear(); DIRECT.clear(); JUDGED.clear();
    ck('c-ga'); measured('c-ga');
    const answered = decideAI('c-ga', false, 'could not read');
    return { answered, ticked: document.getElementById('c-ga').checked,
             judged: JUDGED.has('c-ga'), direct: DIRECT.has('c-ga') };
  });
  check('the model\'s no is refused', r.answered === false);
  check('the measured tick survives', r.ticked === true && r.direct === true);
  check('and the check is not downgraded to a judgement', r.judged === false);

  console.log('\nF. nothing reads the model\'s answers with a bare truthiness test');
  const src = require('fs').readFileSync(
    path.join(__dirname, '..', 'index.html'), 'utf8').replace(/\/\/[^\n]*/g, '');
  const bare = [...src.matchAll(/if\s*\(\s*(?:web|vis)J\.\w+\s*\)\s*\{?\s*if\s*\(\s*ckAI/g)];
  check('no `if (webJ.x) ckAI(...)` left — that is the bug',
        bare.length === 0, bare.length + ' still there');
  check('the website pass routes all ten through decideAI',
        (src.match(/decideAI\('c-(nav|lnk|pho|hdl|cta|res|faq|rcta|awd|ga)'/g) || []).length >= 10);
  check('and the visibility pass its four',
        /decideAI\('c-sm'/.test(src) && /decideAI\('c-meta'/.test(src));

  console.log('\nG. a blocked run says so rather than failing the firm');
  r = await p.evaluate(() => {
    UNK.clear(); DIRECT.clear(); JUDGED.clear();
    ['c-nav','c-faq','c-res'].forEach(i => { document.getElementById(i).checked = false; });
    // What the model returns when the site refused it.
    const j = { fetched: false, nav: null, faqs: null, resources: null };
    const why = j.fetched === false ? 'the model could not load the site' : 'x';
    ['nav','faqs','resources'].forEach((k, n) =>
      decideAI(['c-nav','c-faq','c-res'][n], j[k], why));
    return ['c-nav','c-faq','c-res'].map(i =>
      ({ id: i, unk: UNK.has(i), judged: JUDGED.has(i), why: UNK.get(i) }));
  });
  check('all three are unknown, none judged',
        r.every(x => x.unk && !x.judged), JSON.stringify(r.map(x => x.id + ':' + x.unk)));
  check('each carries the reason the client never sees as a failure',
        r.every(x => /could not load/.test(x.why || '')), r[0].why);

  check('zero page errors', errs.length === 0, errs.join(' | ') || 'none');
  await b.close();
  console.log();
  console.log(failures ? failures + ' check(s) failed' : 'all checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.log('  FAIL  threw: ' + e.message); process.exit(1); });
