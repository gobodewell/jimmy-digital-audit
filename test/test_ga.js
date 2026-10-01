// "Google Analytics is not registering when I know a site has it."
//
// GA came only from Lighthouse's third-party-summary audit, matched on the
// entity name. That misses a site whenever PageSpeed does not run -- on a CDN
// that refuses Google, every time -- and it misses a tag proxied through the
// firm's own domain, because the entity is then the firm rather than Google.
// The tag is in the HTML, so it is read there.
process.env.ANTHROPIC_KEY='t'; process.env.PORT='3983'; delete process.env.AUDIT_KEY;
// Set before the server is required: it reads these once, at load.
process.env.DATAFORSEO_LOGIN='u'; process.env.DATAFORSEO_PASSWORD='p';

// The model's streamed reply, in the shape claudeRun parses.
const enc = new TextEncoder();
const sse = text => new ReadableStream({ start(c) {
  for (const e of [
    { type:'content_block_start', index:0, content_block:{ type:'text', text:'' } },
    { type:'content_block_delta', index:0, delta:{ type:'text_delta', text } },
    { type:'content_block_stop', index:0 },
    { type:'message_delta', delta:{ stop_reason:'end_turn' } }
  ]) c.enqueue(enc.encode('data: ' + JSON.stringify(e) + '\n\n'));
  c.close();
}});

let failures=0;
const check=(l,c,d)=>{console.log((c?'  PASS  ':'  FAIL  ')+l+(d?'   → '+d:'')); if(!c) failures++;};

let home = '';
const realFetch = global.fetch;
global.fetch = async (u,o) => {
  const s = String(u);
  // DataForSEO and the model answer nothing by default; sections F and D
  // replace this mock when they need them to.
  if (s.includes('dataforseo.com'))
    return new Response(JSON.stringify({ status_code:20000, tasks:[{ status_code:20000, result:[] }]}), {status:200});
  if (s.includes('api.anthropic.com'))
    return { ok:true, body: sse('---BODY---\n---END---') };
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
  check('without billing the other routes for a page it read',
        (d.gaRoute||[]).length === 1, JSON.stringify(d.gaRoute));

  console.log('\nC. any hint at all ticks the box');
  // The bar is deliberately low. The two mistakes do not cost the same:
  // missing a tag that is plainly in the markup tells a firm to install
  // something they already have, in a document they hand to a client, while
  // counting a stray dataLayer costs a recommendation nobody would act on.
  for (const [label, markup] of [
    ['a bare dataLayer',   '<script>window.dataLayer = window.dataLayer || [];</script>'],
    ['a bare gtag call',   '<script>gtag("event","page_view");</script>'],
    ['a UA id on its own', '<script>var t = "UA-12345678-1";</script>'],
    ['the host alone',     '<script src="https://www.googletagmanager.com/x.js"></script>']
  ]) {
    d = await get(PAGE(markup));
    check(label, d.ga === true, JSON.stringify(d.ga) + ' ' + (d.gaNote||''));
  }
  d = await get(PAGE('<title>x</title>'));
  check('but a page with no tagging at all is still false', d.ga === false,
        JSON.stringify(d.ga) + ' ' + (d.gaNote||''));

  console.log('\nE. the note names one finding, not four');
  // A GA4 site matches its loader, the googletagmanager host, gtag() and
  // dataLayer. One tag, one finding -- and the measurement ID wins over the
  // loose hints so the answer can be checked.
  d = await get(PAGE('<script async src="https://www.googletagmanager.com/gtag/js?id=G-0Y7KR0RT0H">'
    + '</script><script>window.dataLayer=window.dataLayer||[];gtag("config","G-0Y7KR0RT0H");</script>'));
  check('ticked', d.ga === true);
  check('names the measurement ID', /G-0Y7KR0RT0H/.test(d.gaNote||''), d.gaNote);
  check('and does not also list the loose hints',
        !/dataLayer|gtag on the page/.test(d.gaNote||''), d.gaNote);

  console.log('\nF. a blocked homepage — the other routes still find it');
  // The case from the field: an FMG site behind a CDN that refuses this server,
  // whose markup carries three GA4 properties. One way of looking at the page
  // was never enough.
  let crawlerSees = true;
  global.fetch = async (u,o) => {
    const s = String(u);
    if (s.includes('dataforseo.com') && s.includes('content_parsing'))
      return new Response(JSON.stringify({ status_code:20000, tasks:[{ status_code:20000,
        result: crawlerSees
          ? [{ items:[{ page_content:'<script src="https://www.googletagmanager.com/gtag/js?id=G-0Y7KR0RT0H"></script>' }] }]
          : [{ items:[{ page_content:'<p>nothing</p>' }] }] }]}), {status:200});
    if (s.includes('dataforseo.com'))
      return new Response(JSON.stringify({ status_code:20000, tasks:[{ status_code:20000, result:[] }]}), {status:200});
    if (s.includes('api.anthropic.com'))
      return { ok:true, body: sse('---BODY---\n<html><head><title>x</title></head></html>\n---END---') };
    if (s.includes('x.com'))
      return new Response('denied', {status:403, headers:{server:'cloudflare','cf-ray':'x'}});
    return realFetch(u,o);
  };
  d = await (async () => (await realFetch('http://127.0.0.1:3983/site/check?url=' +
      encodeURIComponent('https://x.com'))).json())();
  check('the crawler found it where we could not', d.ga === true, JSON.stringify(d.ga));
  check('and says which route got it', /OnPage crawler/.test(d.gaNote||''), d.gaNote);
  check('the winning route is named', (d.gaRoute||[]).some(x => /found$/.test(x)),
        JSON.stringify(d.gaRoute));

  console.log('\nD. a blocked homepage no route could read stays unmeasured');
  crawlerSees = false;
  global.fetch = async (u,o) => {
    const s = String(u);
    if (s.includes('dataforseo.com'))
      return new Response(JSON.stringify({ status_code:20000, tasks:[{ status_code:20000, result:[] }]}), {status:200});
    if (s.includes('api.anthropic.com'))
      return { ok:true, body: sse('---BODY---\n---END---') };
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
