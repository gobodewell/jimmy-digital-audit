// "Can you not just ping /sitemap.xml and look for a 404?"
//
// A status code alone passes every site that answers /sitemap.xml with its
// styled 404 page and HTTP 200, which is common. So the body is sniffed -- but
// the sniff had gaps that failed REAL sitemaps, which is the complaint:
//
//   * a prefixed root element (<sm:urlset) failed a bare '<urlset' match
//   * a .gz sitemap arrives as gzip bytes, not a gzip-encoded response, so
//     fetch returns binary and the text match never had a chance
//   * the plain-text form the spec allows was not recognised at all
//
// And when it did fail, the reason was thrown away: "200 but not a sitemap"
// could not distinguish a soft 404 from a sitemap this code did not recognise.
process.env.ANTHROPIC_KEY='t'; process.env.PORT='3984'; delete process.env.AUDIT_KEY;
delete process.env.DATAFORSEO_LOGIN; delete process.env.DATAFORSEO_PASSWORD;

const zlib = require('zlib');
let failures=0;
const check=(l,c,d)=>{console.log((c?'  PASS  ':'  FAIL  ')+l+(d?'   → '+d:'')); if(!c) failures++;};

const XML = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
          + '<url><loc>https://x.com/</loc></url></urlset>';
const SOFT404 = '<!DOCTYPE html><html><head><title>Page not found</title></head>'
              + '<body><h1>Sorry, we could not find that page</h1></body></html>';

let serve = {};          // path -> {status, body, ct}
const realFetch = global.fetch;
global.fetch = async (u,o) => {
  const s = String(u);
  if (!s.includes('x.com')) return realFetch(u,o);
  const p = s.replace('https://x.com','');
  const e = serve[p];
  if (!e) return new Response('nope', {status:404});
  const body = e.body instanceof Buffer ? e.body : Buffer.from(e.body);
  return new Response(body, {status: e.status || 200,
    headers: { 'content-type': e.ct || 'application/xml' }});
};
require('../server.js');
const get = async () => (await realFetch(
  'http://127.0.0.1:3984/site/check?url=' + encodeURIComponent('https://x.com'))).json();

setTimeout(async () => {
  console.log('\nA. a soft 404 is not a sitemap, however healthy its status code');
  serve = { '/sitemap.xml': { status:200, body:SOFT404, ct:'text/html' } };
  let d = await get();
  check('not counted', d.sitemap === false, String(d.sitemap));
  check('and the reason names what came back',
        (d.sitemapTried||[]).some(t => /text\/html.*Page not found|not a sitemap/i.test(t)),
        (d.sitemapTried||[])[0]);

  console.log('\nB. an ordinary sitemap is found');
  serve = { '/sitemap.xml': { status:200, body:XML } };
  d = await get();
  check('found', d.sitemap === true, String(d.sitemap));
  check('and says where', /sitemap\.xml/.test(d.sitemapUrl||''), d.sitemapUrl);

  console.log('\nC. a namespace-prefixed root element still counts');
  // <sm:urlset ...> is valid and the old bare '<urlset' match missed it.
  serve = { '/sitemap.xml': { status:200,
    body:'<?xml version="1.0"?><sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9">'
        +'<sm:url><sm:loc>https://x.com/</sm:loc></sm:url></sm:urlset>' } };
  d = await get();
  check('found', d.sitemap === true, JSON.stringify(d.sitemapTried));

  console.log('\nD. a gzipped sitemap is decompressed, not read as binary');
  serve = { '/sitemap.xml.gz': { status:200, body: zlib.gzipSync(Buffer.from(XML)),
                                 ct:'application/gzip' } };
  d = await get();
  check('found', d.sitemap === true, JSON.stringify(d.sitemapTried));
  check('at the .gz location', /\.gz$/.test(d.sitemapUrl||''), d.sitemapUrl);

  console.log('\nE. the plain-text form the spec allows');
  serve = { '/sitemap.txt': { status:200, ct:'text/plain',
    body:'https://x.com/\nhttps://x.com/about\nhttps://x.com/contact' } };
  d = await get();
  check('found', d.sitemap === true, JSON.stringify(d.sitemapTried));

  console.log('\nF. a text file that is not a list of URLs does not pass for one');
  serve = { '/sitemap.txt': { status:200, ct:'text/plain',
    body:'User-agent: *\nDisallow: /wp-admin/' } };
  d = await get();
  check('not counted', d.sitemap === false, String(d.sitemap));

  console.log('\nG. robots.txt declaring a non-standard location is honoured');
  serve = { '/robots.txt': { status:200, ct:'text/plain',
              body:'User-agent: *\nSitemap: https://x.com/custom/sm.xml' },
            '/custom/sm.xml': { status:200, body:XML } };
  d = await get();
  check('found at the declared path', d.sitemap === true, JSON.stringify(d.sitemapTried));
  check('credited to robots.txt', /declared in robots/.test(d.sitemapNote||''), d.sitemapNote);

  console.log('\nH. nothing anywhere — every location is reported');
  serve = {};
  d = await get();
  check('not found', d.sitemap === false, String(d.sitemap));
  check('and every attempt is listed', (d.sitemapTried||[]).length >= 7,
        String((d.sitemapTried||[]).length));

  console.log(failures?`\n${failures} FAILURE(S)`:'\nall checks passed');
  process.exit(failures?1:0);
}, 700);
