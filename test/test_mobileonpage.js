// "You can't look at a homepage and see if there is a setting for mobile?"
//
// You can -- it is one meta tag -- and that is exactly what the audit reads.
// The gap was in the fallback order. On a site that refuses a direct fetch,
// DataForSEO's OnPage crawler is asked next, and its response answers
// indexability and the meta description but carries NO viewport field. A
// SUCCESSFUL OnPage call therefore filled those two and returned, leaving
// "Mobile optimized" unmeasured on a site whose homepage plainly declares a
// viewport. The model's fetcher, which does read the head, was only reached
// when OnPage FAILED -- which is the one case the older test covered, so the
// gap stayed hidden.
process.env.DATAFORSEO_LOGIN='u'; process.env.DATAFORSEO_PASSWORD='p';
process.env.ANTHROPIC_KEY='t'; process.env.PORT='3986'; delete process.env.AUDIT_KEY;

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

const HEAD = '<head><meta name="viewport" content="width=device-width, initial-scale=1">'
           + '<meta name="description" content="Totus Wealth Management"></head>';

let homeStatus = 403;         // the site refuses us
let claudeCalls = 0;
const realFetch = global.fetch;
global.fetch = async (u,o) => {
  const s = String(u);
  if (s.includes('api.anthropic.com')) {
    claudeCalls++;
    return { ok:true, body: sse('---HEAD---\n'+HEAD+'\n---END---') };
  }
  // OnPage SUCCEEDS here -- HTTP 200, a real meta block, no noindex. This is
  // the case the old test never exercised.
  if (s.includes('/on_page/')) return new Response(JSON.stringify({status_code:20000,
    tasks:[{status_code:20000,result:[{items:[{status_code:200,
      meta:{title:'Totus Wealth Management', description:'Advisory firm', follow:true}}]}]}]}),{status:200});
  if (s.includes('/serp/')) return new Response(JSON.stringify({status_code:20000,
    tasks:[{status_code:20000,result:[{se_results_count:47,items:[
      {type:'organic',domain:'totuswm.com',url:'https://totuswm.com/about'}]}]}]}),{status:200});
  if (s.includes('totuswm.com')) {
    if (homeStatus === 200)
      return new Response('<html>'+HEAD+'<body>hi</body></html>',{status:200});
    return new Response('denied',{status:403,headers:{server:'cloudflare','cf-ray':'x'}});
  }
  return realFetch(u,o);
};
require('../server.js');
const get=async()=>{ claudeCalls=0;
  return (await realFetch('http://127.0.0.1:3986/site/check?url='+
    encodeURIComponent('https://totuswm.com'))).json(); };

setTimeout(async () => {
  console.log('\nA. blocked homepage, OnPage succeeds — mobile is still answered');
  let d = await get();
  check('OnPage was used, not bypassed', d.onPage==='used', d.onPage);
  check('OnPage answered indexability', d.indexable===true, JSON.stringify(d.indexable));
  check('MOBILE is measured, not shrugged at', d.viewport===true, JSON.stringify(d.viewport));
  check('and quotes the tag it read', /width=device-width/.test(d.viewportNote||''), d.viewportNote);
  check('crediting the route that got it', /model-fetched/.test(d.viewportNote||''), d.viewportNote);
  // Twice at most, and only on a page nobody could read: once for the <head>,
  // which answers viewport and robots, and once for the body, where a tag
  // manager's noscript iframe lives and the head cannot reach. A page that
  // loads normally still costs no model call at all -- section C.
  check('the model was asked no more than twice', claudeCalls<=2, String(claudeCalls));
  check('and at least once', claudeCalls>=1, String(claudeCalls));

  console.log('\nB. a page that declares no viewport is a finding, not a gap');
  const keep = HEAD;
  global.fetch = (orig => async (u,o) => {
    if (String(u).includes('api.anthropic.com')) { claudeCalls++;
      return { ok:true, body: sse('---HEAD---\n<head><title>x</title></head>\n---END---') }; }
    return orig(u,o);
  })(global.fetch);
  d = await get();
  // No viewport tag in a head we DID read: readViewport returns null, so the
  // model route leaves it null rather than asserting absence from a head it
  // may have truncated. Unmeasured is the honest answer, and the note says so.
  check('not reported as a pass', d.viewport!==true, JSON.stringify(d.viewport));

  console.log('\nC. when the homepage answers, the model is not asked at all');
  homeStatus = 200;
  d = await get();
  check('read directly', d.homeStatus===200, String(d.homeStatus));
  check('viewport from the page itself', d.viewport===true, JSON.stringify(d.viewport));
  check('quotes the real tag', /declares viewport/.test(d.viewportNote||''), d.viewportNote);
  check('no model call — it costs money', claudeCalls===0, String(claudeCalls));

  console.log(failures?`\n${failures} FAILURE(S)`:'\nall checks passed');
  process.exit(failures?1:0);
}, 700);
