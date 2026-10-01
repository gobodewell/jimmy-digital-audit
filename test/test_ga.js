// "Google Analytics is not registering when I know a site has it."
//
// GA came only from Lighthouse's third-party-summary audit, matched on the
// entity name. That misses a site whenever PageSpeed does not run -- on a CDN
// that refuses Google, every time -- and it misses a tag proxied through the
// firm's own domain, because the entity is then the firm rather than Google.
// The tag is in the HTML, so it is read there.
process.env.ANTHROPIC_KEY='t'; process.env.PORT='3983'; delete process.env.AUDIT_KEY;
delete process.env.DATAFORSEO_LOGIN; delete process.env.DATAFORSEO_PASSWORD;

let failures=0;
const check=(l,c,d)=>{console.log((c?'  PASS  ':'  FAIL  ')+l+(d?'   → '+d:'')); if(!c) failures++;};

let home = '';
const realFetch = global.fetch;
global.fetch = async (u,o) => {
  const s = String(u);
  if (!s.includes('x.com')) return realFetch(u,o);
  if (s === 'https://x.com' || s === 'https://x.com/')
    return new Response(home, {status:200, headers:{'content-type':'text/html'}});
  return new Response('', {status:404});
};
require('../server.js');
const get = async html => { home = html;
  return (await realFetch('http://127.0.0.1:3983/site/check?url=' +
    encodeURIComponent('https://x.com'))).json(); };

const PAGE = inner => '<html><head>' + inner + '</head><body>hi</body></html>';

const GTM_SNIPPET = `<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
})(window,document,'script','dataLayer','GTM-M4XK2PQ');</script>`;

setTimeout(async () => {
  console.log('\nA. the tags people actually ship');
  for (const [label, markup, expect] of [
    ['GA4 loader',
     '<script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC123XYZ"></script>', 'G-ABC123XYZ'],
    // Google's REAL snippet, not a tidied one. It builds the loader URL in JS
    // -- j.src='...gtm.js?id='+i -- so "?id=GTM-" never appears as text, and
    // only the body <noscript> iframe carries the ID literally. An earlier
    // version of this test used a simplified snippet with the ID in the src,
    // which confirmed the implementation rather than reality and hid the fact
    // that a head-only install was missed.
    ['GTM, the real snippet, head only', GTM_SNIPPET, 'GTM-M4XK2PQ'],
    ['GTM served from the firm\'s own domain',
     GTM_SNIPPET.replace('https://www.googletagmanager.com', 'https://metrics.firm.com'), 'GTM-M4XK2PQ'],
    ['GTM body noscript on its own',
     '<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-M4XK2PQ"></iframe></noscript>',
     'GTM-M4XK2PQ'],
    ['legacy Universal Analytics',
     '<script src="https://www.google-analytics.com/analytics.js"></script>', 'Universal Analytics'],
    ['inline gtag config only — the first-party-proxy case',
     '<script>gtag("config", "G-SELFHOST1");</script>', 'G-SELFHOST1']
  ]) {
    const d = await get(PAGE(markup));
    check(label, d.ga === true, JSON.stringify(d.ga) + ' ' + (d.gaNote||''));
    check('   and names what it found', (d.gaNote||'').includes(expect), d.gaNote);
  }

  console.log('\nB. a page with no analytics is a finding, not a gap');
  let d = await get(PAGE('<title>No tags here</title>'));
  check('measured false', d.ga === false, JSON.stringify(d.ga));
  check('and says so plainly', /no analytics tag/.test(d.gaNote||''), d.gaNote);

  console.log('\nC. dataLayer alone is not analytics');
  d = await get(PAGE('<title>x</title>') .replace('hi', 'We use GTM and Google Analytics here.'));
  check('prose mentioning GTM is not a tag', d.ga === false, JSON.stringify(d.ga) + ' ' + (d.gaNote||''));
  // Plenty of sites declare dataLayer with no tag attached to it.
  d = await get(PAGE('<script>window.dataLayer = window.dataLayer || [];</script>'));
  check('not counted', d.ga === false, JSON.stringify(d.ga) + ' ' + (d.gaNote||''));

  console.log('\nD. a blocked homepage leaves it unmeasured, never false');
  global.fetch = async (u,o) => {
    const s = String(u);
    if (!s.includes('x.com')) return realFetch(u,o);
    return new Response('denied', {status:403, headers:{server:'cloudflare','cf-ray':'x'}});
  };
  d = await (async () => (await realFetch('http://127.0.0.1:3983/site/check?url=' +
      encodeURIComponent('https://x.com'))).json())();
  check('null, not false', d.ga === null, JSON.stringify(d.ga));
  check('and names the blocker', /Cloudflare/.test(d.gaNote||''), d.gaNote);

  console.log(failures?`\n${failures} FAILURE(S)`:'\nall checks passed');
  process.exit(failures?1:0);
}, 700);
