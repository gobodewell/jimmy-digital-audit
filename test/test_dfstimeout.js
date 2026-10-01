// DataForSEO's "live" endpoints scrape on demand while the request is open.
// my_business_info routinely runs past half a minute, so a flat 25s cut it off
// every time -- the call was never failing, it was being abandoned -- and the
// user saw a bare "This operation was aborted" with a Retry that hit the same
// wall.
process.env.DATAFORSEO_LOGIN='u'; process.env.DATAFORSEO_PASSWORD='p';
process.env.ANTHROPIC_KEY='t'; process.env.PORT='3992';
// Runs the real timeout logic at 1/30 scale so the suite is not two minutes long.
process.env.DFS_TIMEOUT_SCALE='0.0333'; delete process.env.AUDIT_KEY;

let failures=0;
const check=(l,c,d)=>{console.log((c?'  PASS  ':'  FAIL  ')+l+(d?'   → '+d:'')); if(!c) failures++;};

let delayMs = 0;
const seen = [];
const realFetch=global.fetch;
global.fetch=async(u,o)=>{
  const s=String(u);
  if(!s.includes('dataforseo.com')) return realFetch(u,o);
  seen.push(s);
  if (delayMs) {
    // Hang until the caller's own AbortController gives up, exactly as a slow
    // live endpoint does.
    await new Promise((res, rej) => {
      const t = setTimeout(res, delayMs);
      o.signal.addEventListener('abort', () => { clearTimeout(t); rej(o.signal.reason || new Error('aborted')); });
    });
  }
  return new Response(JSON.stringify({status_code:20000,tasks:[{status_code:20000,
    result:[{items:[{title:'Totus Wealth', url:'https://totuswm.com', rating:{value:4.9,votes_count:12}}]}]}]}),{status:200});
};
require('../server.js');
const gbp=async()=>(await realFetch('http://127.0.0.1:3992/gbp/info?name=Totus&url='+
  encodeURIComponent('https://totuswm.com'))).json();

setTimeout(async()=>{
  console.log('\nA. a normal answer still works');
  let d=await gbp();
  check('found', d.found===true, JSON.stringify(d.found));
  check('matched by domain', d.verified===true);

  console.log('\nB. a call slower than the old 25s limit now SUCCEEDS');
  delayMs = 1100;    // 33s at full scale: abandoned under the old 25s limit
  const t0 = Date.now();
  d = await gbp();
  const took = Date.now() - t0;
  check('answered instead of aborting', d.found===true, JSON.stringify(d.error || d.found));
  check('waited past the old 25s limit', took > 25000 * 0.0333, Math.round(took)+'ms at scale');

  console.log('\nC. a genuine timeout says what happened, not "operation was aborted"');
  delayMs = 999000;  // never answers
  d = await gbp();
  check('not the raw DOM message', !/This operation was aborted/.test(d.error||''), d.error);
  check('names the real limit as configured', /did not answer within 3s/.test(d.error||''), d.error);
  check('names the endpoint', /my_business_info/.test(d.error||''));
  check('says a retry will not help', /same limit rather than fixing it/.test(d.error||''));

  console.log(failures?`\n${failures} FAILURE(S)`:'\nall checks passed');
  process.exit(failures?1:0);
},400);
