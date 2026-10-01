// Advisory-firm sites overwhelmingly inject schema from a plugin or tag
// manager, so the HTML as served is bare while the rendered page carries a
// full FinancialService + PostalAddress block. The fallback chain only fired
// when the FETCH failed, so a healthy 200 with JS-injected markup was reported
// as "No structured data found" -- a hard failure on an 8-point check.
process.env.DATAFORSEO_LOGIN='u'; process.env.DATAFORSEO_PASSWORD='p';
process.env.ANTHROPIC_KEY='t'; process.env.PORT='3997'; delete process.env.AUDIT_KEY;

let failures=0;
const check=(l,c,d)=>{console.log((c?'  PASS  ':'  FAIL  ')+l+(d?'   → '+d:'')); if(!c) failures++;};

const ld = o => '<script type="application/ld+json">'+JSON.stringify(o)+'</script>';
const FULL = ld({ '@context':'https://schema.org', '@type':'FinancialService',
  name:'Totus Wealth Management', telephone:'(832) 220-3602',
  address:{ '@type':'PostalAddress', addressLocality:'Houston', addressRegion:'TX' } });
const THIN = ld({ '@context':'https://schema.org', '@type':'WebSite', name:'Totus' });

let served='<html><head></head><body>Totus</body></html>';
let onpage=null, onpageErr=false;
const realFetch=global.fetch;
global.fetch=async(u,o)=>{
  const s=String(u);
  if (s.includes('/on_page/')) {
    if (onpageErr) return new Response(JSON.stringify({status_code:40200,status_message:'Payment Required.'}),{status:200});
    return new Response(JSON.stringify({status_code:20000,tasks:[{status_code:20000,
      result:[{items:[{raw_html: onpage}]}]}]}),{status:200});
  }
  if (s.includes('/serp/')) return new Response(JSON.stringify({status_code:20000,
    tasks:[{status_code:20000,result:[{se_results_count:0,items:[]}]}]}),{status:200});
  if (s.includes('totuswm.com')) return new Response(served,{status:200});
  return realFetch(u,o);
};
require('../server.js');
const get=async()=>(await realFetch(
  'http://127.0.0.1:3997/site/schema?url='+encodeURIComponent('https://totuswm.com'))).json();

setTimeout(async()=>{
  console.log('\nA. THE BUG: served HTML bare, schema injected by JavaScript');
  served='<html><head></head><body>Totus</body></html>';
  onpage='<html><head>'+FULL+'</head><body></body></html>';
  let d=await get();
  check('found, not "none"', d.found===true, JSON.stringify(d.found));
  check('FinancialService detected', d.isFinancialService===true, JSON.stringify(d.types));
  check('address detected', d.hasAddress===true);
  check('city and state read', d.addressLocality==='Houston'&&d.addressRegion==='TX',
        d.addressLocality+'/'+d.addressRegion);
  check('credits the rendered read', d.readVia==='onpage-js', d.readVia);
  check('says the markup is JS-injected', /added markup/.test(d.renderedRead||''), d.renderedRead);

  console.log('\nB. served HTML already complete: no second call, no change');
  served='<html><head>'+FULL+'</head><body></body></html>';
  onpage='<html><head>'+THIN+'</head></html>';
  d=await get();
  check('read directly', d.readVia==='direct', d.readVia);
  check('no rendered read attempted', d.renderedRead===null, JSON.stringify(d.renderedRead));
  check('FinancialService still found', d.isFinancialService===true);

  console.log('\nC. a thinner rendered read never overwrites a richer served one');
  served='<html><head>'+FULL+'</head></html>';
  onpage='<html><head>'+THIN+'</head></html>';
  d=await get();
  check('served reading stands', d.isFinancialService===true&&d.hasAddress===true);

  console.log('\nD. partial served markup is topped up, not replaced wholesale');
  served='<html><head>'+THIN+'</head></html>';       // a type, but no address
  onpage='<html><head>'+FULL+'</head></html>';
  d=await get();
  check('escalated on the missing address', d.readVia==='onpage-js', d.readVia);
  check('address now present', d.hasAddress===true);

  console.log('\nE. genuinely no schema anywhere is still a real finding');
  served='<html><head></head><body>nothing</body></html>';
  onpage='<html><head></head><body>nothing</body></html>';
  d=await get();
  check('reported as not found', d.found===false, JSON.stringify(d.found));
  check('and it says the render was tried', /no better/.test(d.renderedRead||''), d.renderedRead);

  console.log('\nF. the render being unavailable is not read as "no schema"');
  served='<html><head></head><body>nothing</body></html>';
  onpageErr=true;
  d=await get();
  check('still not found', d.found===false);
  check('no false claim that JS was checked', d.renderedRead===null, JSON.stringify(d.renderedRead));

  console.log(failures?`\n${failures} FAILURE(S)`:'\nall checks passed');
  process.exit(failures?1:0);
},400);
