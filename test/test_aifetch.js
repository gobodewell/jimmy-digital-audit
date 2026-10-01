// The app's AI assistant reads these sites without trouble -- it quotes their
// viewport tag and their nav markup -- which proves Claude's fetcher gets
// through where ours, DataForSEO's and Google's are all refused. So on a site
// that blocks everything, all three of mobile, indexable and sitemap should
// still come back answered.
process.env.DATAFORSEO_LOGIN='u'; process.env.DATAFORSEO_PASSWORD='p';
process.env.ANTHROPIC_KEY='t'; process.env.PORT='3993'; delete process.env.AUDIT_KEY;

let failures=0;
const check=(l,c,d)=>{console.log((c?'  PASS  ':'  FAIL  ')+l+(d?'   → '+d:'')); if(!c) failures++;};

const enc=new TextEncoder();
const sse=text=>new ReadableStream({start(c){
  for(const e of [
    {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
    {type:'content_block_delta',index:0,delta:{type:'text_delta',text}},
    {type:'content_block_stop',index:0},
    {type:'message_delta',delta:{stop_reason:'end_turn'}}
  ]) c.enqueue(enc.encode('data: '+JSON.stringify(e)+'\n\n'));
  c.close();
}});

// What the AI assistant actually reported for this site.
const HEAD = '<head><meta name="viewport" content="width=device-width, initial-scale=1.0">'
           + '<meta name="description" content="Totus Wealth Management"></head>';
const SITEMAP = '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
              + '<url><loc>https://totuswm.com/</loc></url></urlset>';

let claudeMode='ok';
const realFetch=global.fetch;
global.fetch=async(u,o)=>{
  const s=String(u);
  if (s.includes('api.anthropic.com')) {
    if (claudeMode==='down') return new Response('{"error":"overloaded"}',{status:529});
    const body = JSON.parse(o.body);
    const asked = JSON.stringify(body.messages);
    if (claudeMode==='prose')
      return { ok:true, body: sse('---BODY---\nYes, the site has a sitemap listing 40 pages.\n---END---') };
    if (/sitemap/i.test(asked)) return { ok:true, body: sse('---BODY---\n'+SITEMAP+'\n---END---') };
    return { ok:true, body: sse('---HEAD---\n'+HEAD+'\n---END---') };
  }
  // DataForSEO: OnPage blocked, SERP shows the site indexed.
  if (s.includes('/on_page/')) return new Response(JSON.stringify({status_code:20000,
    tasks:[{status_code:20000,result:[{items:[{status_code:403,meta:{}}]}]}]}),{status:200});
  if (s.includes('/serp/')) return new Response(JSON.stringify({status_code:20000,
    tasks:[{status_code:20000,result:[{se_results_count:47,items:[
      {type:'organic',domain:'totuswm.com',url:'https://totuswm.com/about'}]}]}]}),{status:200});
  // The site itself: Cloudflare refuses everything.
  if (s.includes('totuswm.com')) return new Response('denied',{status:403,
    headers:{server:'cloudflare','cf-ray':'x'}});
  return realFetch(u,o);
};
require('../server.js');
const get=async()=>(await realFetch('http://127.0.0.1:3993/site/check?url='+
  encodeURIComponent('https://totuswm.com'))).json();

setTimeout(async()=>{
  console.log('\nA. every crawler refused — the blocker is still named');
  let d=await get();
  check('Cloudflare identified', d.homeBlockedBy==='Cloudflare', JSON.stringify(d.homeBlockedBy));

  console.log('\nB. MOBILE: the viewport tag is read despite the block');
  check('viewport answered', d.viewport===true, JSON.stringify(d.viewport));
  check('quotes the real tag', /width=device-width/.test(d.viewportNote||''), d.viewportNote);

  console.log('\nC. INDEXING: answered, and by the stronger evidence');
  check('indexable answered', d.indexable===true, JSON.stringify(d.indexable));
  check('Google index consulted', /google-index/.test(d.readVia||''), d.readVia);
  check('says it is proven, not inferred', /proven/.test(d.indexableNote||''),
        (d.indexableNote||'').slice(-60));

  console.log('\nD. SITEMAP: fetched by the model when both others are blocked');
  check('sitemap found', d.sitemap===true, JSON.stringify(d.sitemap));
  check('credits the route', d.sitemapVia==='claude-fetch', d.sitemapVia);
  check('not marked blocked', !d.sitemapBlocked, JSON.stringify(d.sitemapBlocked));
  check('says how it was read', /fetched by the model/.test(d.sitemapNote||''), d.sitemapNote);

  console.log('\nE. prose about a sitemap is NOT accepted as one');
  claudeMode='prose';
  d=await get();
  check('not claimed as found', d.sitemap!==true, JSON.stringify(d.sitemap));
  check('recorded as blocked, not absent', d.sitemapBlocked===true);
  check('says what went wrong', /not sitemap markup/.test(d.sitemapNote||''), d.sitemapNote);

  console.log('\nF. the model being down leaves things unmeasured, never failed');
  claudeMode='down';
  d=await get();
  check('sitemap unmeasured', d.sitemapBlocked===true, JSON.stringify(d.sitemapBlocked));
  check('viewport unmeasured', d.viewport===null, JSON.stringify(d.viewport));
  check('model failure recorded', /failed/.test(d.modelFetch||''), d.modelFetch);
  check('but Google still settles indexing', d.indexable===true, JSON.stringify(d.indexable));

  console.log(failures?`\n${failures} FAILURE(S)`:'\nall checks passed');
  process.exit(failures?1:0);
},400);
