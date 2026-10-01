// Archstone Financial is in Google Maps with an address, a phone number, a
// category and four reviews. my_business_info answered "No Search Results" for
// it, and the audit left all six Google Business checks blank -- which scores
// as six failures, forty points, and puts "create a Google Business Profile"
// in front of a firm that already has one.
//
// Not finding a listing is not the same as a firm not having one. Unmeasured
// is the honest state: a consultant who can see the listing ticks the boxes by
// hand, and the report says the check could not be completed rather than
// asserting an absence nobody established.
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

  let payload = {};
  await page.route('**/gbp/info*', async route =>
    route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify(payload) }));
  await page.goto(PAGE);

  const run = async p => {
    payload = p;
    return page.evaluate(async () => {
      UNK.clear();
      GBP_IDS.forEach(id => { document.getElementById(id).checked = false; });
      await runGBP('Archstone Financial', 'https://archstonefinancial.net', 'Worcester, MA');
      return {
        states: GBP_IDS.map(id => ({
          id, checked: document.getElementById(id).checked, unk: UNK.get(id) || null })),
        panel: document.getElementById('gbp-details').textContent
      };
    });
  };

  console.log('\nA. no listing matched — six checks unmeasured, not failed');
  let r = await run({ found:false,
    note:'no Google listing found for this firm name — searched Worcester,Massachusetts,United States and United States.' });
  check('all six are unmeasured', r.states.every(s => s.unk), 
        JSON.stringify(r.states.filter(s => !s.unk).map(s => s.id)));
  check('none is silently ticked', r.states.every(s => !s.checked));
  check('the reason is carried onto each', r.states.every(s => /no Google listing/.test(s.unk)),
        r.states[0].unk);
  check('the panel says they were left unmeasured', /unmeasured/i.test(r.panel), r.panel.slice(0,90));
  check('and tells the reader what to do', /tick them by hand/i.test(r.panel));
  check('it does not assert the firm has no profile',
        !/GBP not found|no profile|does not have/i.test(r.panel), r.panel.slice(0,90));

  console.log('\nB. a listing that IS found still scores normally');
  r = await run({ found:true, verified:true, claimed:true, reviewCount:4, rating:4.0,
                  hasDescription:true, hasPhotos:true, hasLogo:true,
                  title:'Archstone Financial', category:'Financial planner',
                  url:'https://archstonefinancial.net' });
  const by = id => r.states.find(s => s.id === id);
  check('listing exists ticks', by('c-gbp-f').checked);
  check('claimed ticks', by('c-gbp-v').checked);
  check('reviews tick on four of them', by('c-gbp-r').checked);
  check('nothing is left unmeasured', r.states.every(s => !s.unk),
        JSON.stringify(r.states.filter(s => s.unk).map(s => s.id)));

  console.log('\nC. an unverified match is still not scored');
  r = await run({ found:true, verified:false, claimed:true, reviewCount:9,
                  title:'Archstone Financial Group of Dallas', url:'https://somewhereelse.com' });
  check('nothing ticked on a name-only match', r.states.every(s => !s.checked),
        JSON.stringify(r.states.filter(s => s.checked).map(s => s.id)));

  console.log('\nD. page health');
  check('zero page errors', errs.length === 0, errs.join(' | ') || 'none');
  await b.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})();
