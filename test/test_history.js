// Audit history: save an audit, find it again by client, reopen its state, and
// get the delivered PDF back. Runs against a mocked Supabase so the suite needs
// no credentials and writes no rows -- the real endpoints are exercised
// separately by tools/history-smoke.js.
process.env.SUPABASE_URL='https://sb.test'; process.env.SUPABASE_SERVICE_KEY='svc';
process.env.ANTHROPIC_KEY='t'; process.env.PORT='3987'; delete process.env.AUDIT_KEY;

let failures=0;
const check=(l,c,d)=>{console.log((c?'  PASS  ':'  FAIL  ')+l+(d?'   → '+d:'')); if(!c) failures++;};

const seen=[]; let rows=[];
const realFetch=global.fetch;
global.fetch=async(u,o)=>{
  const url=String(u);
  if(!url.startsWith('https://sb.test')) return realFetch(u,o);
  seen.push({url, method:(o&&o.method)||'GET', hasKey:!!(o&&o.headers&&o.headers.apikey),
             auth:(o&&o.headers&&o.headers.Authorization)||null});
  if(url.includes('/storage/v1/object/sign/'))
    return new Response(JSON.stringify({signedURL:'/object/sign/audit-reports/x?token=abc'}),{status:200});
  if(url.includes('/storage/v1/object/')) return new Response('{}',{status:200});
  if(url.includes('/rest/v1/audits') && (o&&o.method)==='POST'){
    const row=Object.assign({id:'11111111-2222-3333-4444-555555555555', created_at:new Date().toISOString()},
                            JSON.parse(o.body));
    rows.push(row);
    return new Response(JSON.stringify([row]),{status:201});
  }
  if(url.includes('/rest/v1/audits')){
    let out=rows;
    const m=url.match(/id=eq\.([0-9a-f-]+)/i); if(m) out=rows.filter(r=>r.id===m[1]);
    if(/ilike/.test(url)){
      const q=decodeURIComponent(url).match(/ilike\.\*([^*]*)\*/); 
      if(q) out=rows.filter(r=>(r.client_domain+' '+r.client_name).toLowerCase().includes(q[1].toLowerCase()));
    }
    // The list query must not ship 14KB of state per row.
    if(!/select=\*/.test(url)) out=out.map(r=>{const c={...r}; delete c.state; return c;});
    return new Response(JSON.stringify(out),{status:200});
  }
  return new Response('{}',{status:200});
};
require('../server.js');
const call=async(p,opt)=>{const r=await realFetch('http://127.0.0.1:3987'+p,opt); return {status:r.status, body:await r.json()};};
const post=(p,b)=>call(p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});

const STATE={AD:{name:'Totus'},checks:[['c-spd',true]],unk:[],fields:[]};

setTimeout(async()=>{
  console.log('\nA. an audit is filed under its DOMAIN, not the typed name');
  let r=await post('/history/save',{ clientName:'Totus wealth Managment',
    clientUrl:'https://WWW.TotusWM.com/about', state:STATE,
    scores:{overall:89,v:92,w:81,s:95}, kpisPassed:29, kpisTotal:40,
    pdfBase64:Buffer.from('%PDF-1.4 fake').toString('base64'), build:'2026-09-30.2' });
  check('saved', r.status===200 && r.body.ok===true, JSON.stringify(r.body).slice(0,90));
  check('domain normalised', r.body.domain==='totuswm.com', r.body.domain);
  check('pdf stored under the domain', /^totuswm\.com\//.test(r.body.pdfPath||''), r.body.pdfPath);
  check('pdf size recorded', r.body.pdfBytes>0, String(r.body.pdfBytes));

  console.log('\nB. the same firm typed differently lands in ONE history');
  await post('/history/save',{ clientName:'Totus Wealth Management',
    clientUrl:'totuswm.com', state:STATE, scores:{overall:91,v:95,w:84,s:95} });
  r=await call('/history/list?q=totuswm');
  check('both runs found', r.body.audits.length===2, String(r.body.audits.length));
  check('under one domain', new Set(r.body.audits.map(a=>a.client_domain)).size===1,
        JSON.stringify([...new Set(r.body.audits.map(a=>a.client_domain))]));

  console.log('\nC. the list stays light — no 14KB state per row');
  check('state not selected', r.body.audits.every(a=>a.state===undefined));
  check('but the scores are there', r.body.audits.every(a=>a.score_overall!=null));

  console.log('\nD. searching by the typed NAME works too');
  r=await call('/history/list?q=Totus');
  check('found by name', r.body.audits.length===2, String(r.body.audits.length));
  r=await call('/history/list?q=somebodyelse');
  check('a miss returns nothing, not everything', r.body.audits.length===0, String(r.body.audits.length));

  console.log('\nE. one audit can be reopened, with its state');
  r=await call('/history/get?id=11111111-2222-3333-4444-555555555555');
  check('state returned', !!r.body.state, JSON.stringify(r.body.state||'').slice(0,40));
  check('it is the audit we saved', r.body.state.AD.name==='Totus');
  r=await call('/history/get?id=not-a-uuid');
  check('a bad id is refused, not guessed at', r.status===400, String(r.status));

  console.log('\nF. the stored PDF comes back as a time-limited link');
  r=await call('/history/pdf?path=totuswm.com/x.pdf');
  check('signed URL returned', /token=/.test(r.body.url||''), r.body.url);
  const sign=seen.find(x=>x.url.includes('/object/sign/'));
  check('signed, not made public', !!sign);
  r=await call('/history/pdf?path=../../etc/passwd');
  check('path traversal refused', r.status===400, String(r.status));

  console.log('\nG. the service key never leaves the proxy');
  check('every Supabase call carried it', seen.every(x=>x.hasKey), String(seen.filter(x=>!x.hasKey).length)+' without');

  console.log('\nH. the key goes on BOTH headers, whatever its format');
  // This section used to assert the opposite -- that a new sb_secret_ key is
  // apikey-only -- on the strength of a docs line. It was wrong, and it is why
  // nothing was ever filed: Storage authenticates on Authorization, so the PDF
  // upload was refused, and because a save stores the PDF before inserting the
  // row, the table stayed empty too. supabase-js sets Bearer SPECIFICALLY for
  // a new-format key and falls back to the key itself for a legacy JWT, so
  // both formats carry both headers.
  check('a new secret key is sent on Authorization too',
        seen.length > 0 && seen.every(x => x.auth === 'Bearer svc'),
        JSON.stringify([...new Set(seen.map(x => x.auth))]));
  check('and on apikey', seen.every(x => x.hasKey));

  console.log('\nI. an audit with no URL is refused rather than filed under ""');
  r=await post('/history/save',{ clientName:'No URL', state:STATE });
  check('refused', r.status===400, String(r.status));
  check('says why', /client URL is required/.test(r.body.error||''), r.body.error);

  console.log('\nJ. a LEGACY service_role JWT still gets the Authorization header');
  // Both key types have to work: an existing project may still be on the
  // JWT-based service_role key, where Authorization is expected.
  seen.length = 0;
  await new Promise(r => { delete require.cache[require.resolve('../server.js')]; r(); });
  process.env.SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiJ9.fake.jwt';
  process.env.PORT = '3975';
  require('../server.js');
  await new Promise(r => setTimeout(r, 300));
  await realFetch('http://127.0.0.1:3975/history/list');
  check('legacy key sent on Authorization too',
        seen.length > 0 && seen.every(x => x.auth === 'Bearer eyJhbGciOiJIUzI1NiJ9.fake.jwt'),
        JSON.stringify(seen.map(x => x.auth)));
  check('and still on apikey', seen.every(x => x.hasKey));

  console.log(failures?`\n${failures} FAILURE(S)`:'\nall checks passed');
  process.exit(failures?1:0);
},400);
