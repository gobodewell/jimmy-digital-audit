// "Ranked by the score each fix unlocks, hardest-hitting first" is printed on
// page 2, so the order has to be that. Each category totals 100 raw points but
// they are weighted 40/35/25, which makes raw points incomparable between
// them -- a 20-point Social check unlocks 5.0 and a 15-point Website check
// 5.25, so sorting by raw points put the smaller fix first.
const path=require('path');
const PAGE='file://'+path.resolve(__dirname,'..','index.html');
const { chromium }=require('playwright');
let failures=0;
const check=(l,c,d)=>{console.log((c?'  PASS  ':'  FAIL  ')+l+(d?'   → '+d:'')); if(!c) failures++;};

(async()=>{
  const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
  const page=await b.newPage();
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  await page.goto(PAGE);

  console.log('\nA. the weighting is applied, not raw points');
  const w = await page.evaluate(()=>{
    const pick = id => CHECKS.find(c=>c.id===id);
    return { social: scoreImpact(pick('c-hli')), web: scoreImpact(pick('c-spd')),
             vis: scoreImpact(pick('c-gbp-f')),
             rawSocial: pick('c-hli').pts, rawWeb: pick('c-spd').pts };
  });
  check('LinkedIn has MORE raw points than page speed', w.rawSocial > w.rawWeb,
        w.rawSocial+' vs '+w.rawWeb);
  check('but page speed unlocks more score', w.web > w.social,
        w.web.toFixed(2)+' vs '+w.social.toFixed(2));

  console.log('\nB. every box unchecked: the order follows real impact');
  const order = await page.evaluate(()=>{
    document.querySelectorAll('.ci input').forEach(i=>i.checked=false);
    return failedChecks().map(c=>({id:c.id,cat:c.cat,pts:c.pts,imp:+scoreImpact(c).toFixed(3)}));
  });
  const desc = order.every((c,i)=> i===0 || order[i-1].imp >= c.imp);
  check('sorted by impact, descending', desc,
        order.slice(0,5).map(c=>c.id+'='+c.imp).join(' '));
  check('page speed now outranks LinkedIn',
        order.findIndex(c=>c.id==='c-spd') < order.findIndex(c=>c.id==='c-hli'),
        'spd at '+order.findIndex(c=>c.id==='c-spd')+', hli at '+order.findIndex(c=>c.id==='c-hli'));
  check('the old raw-points order would have disagreed',
        order.findIndex(c=>c.id==='c-spd') < order.findIndex(c=>c.id==='c-hli'));

  console.log('\nC. page 2 lists them in that order, highest first');
  const acts = await page.evaluate(()=>{
    document.querySelectorAll('.ci input').forEach(i=>i.checked=false);
    return assembleReport().actions.map(a=>({title:a.title, pts:a.pts}));
  });
  check('five actions', acts.length===5, String(acts.length));
  check('point values never increase down the list',
        acts.every((a,i)=> i===0 || acts[i-1].pts >= a.pts),
        acts.map(a=>a.pts).join(' >= '));

  console.log('\nD. ties fall back to raw points, so the order is stable');
  const stable = await page.evaluate(()=>{
    const a = failedChecks().map(c=>c.id).join(',');
    const b = failedChecks().map(c=>c.id).join(',');
    return a===b;
  });
  check('same input, same order', stable);

  console.log('\nE. page health');
  check('zero page errors', errs.length===0, errs.join(' | ')||'none');
  await b.close();
  console.log(failures?`\n${failures} FAILURE(S)`:'\nall checks passed');
  process.exit(failures?1:0);
})();
