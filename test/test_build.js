// index.html is served by Netlify and server.js runs on Render, deployed
// separately from the same zip. Upload one and not the other and a fix is half
// applied, with no symptom except that it does not work. Nobody should have to
// remember which they uploaded, so the app checks.
const path = require('path');
const PAGE = 'file://' + path.resolve(__dirname, '..', 'index.html');
const { chromium } = require('playwright');
let failures=0;
const check=(l,c,d)=>{console.log((c?'  PASS  ':'  FAIL  ')+l+(d?'   → '+d:'')); if(!c) failures++;};

(async()=>{
  const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
  const errs=[];

  const open = async health => {
    const page = await (await b.newContext({ignoreHTTPSErrors:true})).newPage();
    page.on('pageerror',e=>errs.push(e.message));
    await page.addInitScript(()=>{ localStorage.setItem('cfg_proxy','https://proxy.test');
                                   localStorage.setItem('cfg_audit','k'); });
    await page.route('**/proxy.test/**', r => r.fulfill({ status:200,
      contentType:'application/json', headers:{'access-control-allow-origin':'*'},
      body: JSON.stringify(health) }));
    await page.goto(PAGE);
    await page.waitForTimeout(1200);
    return page;
  };
  const shown = (p,sel) => p.evaluate(s=>{
    const el=document.querySelector(s); return !!el && el.style.display!=='none'; }, sel);

  // Both files carry the same literal, so the page can name its own vintage.
  const BUILD = await (await open({ok:true,locked:false,build:'x'})).evaluate(()=>BUILD);
  console.log('\nA. matching builds say nothing');
  let p = await open({ ok:true, locked:false, build: BUILD });
  check('no warning', !(await shown(p,'#build-warn')));
  check('settings shows the page build', (await p.locator('#build-stamp').textContent())===BUILD,
        await p.locator('#build-stamp').textContent());
  check('and the proxy build', (await p.locator('#build-stamp-proxy').textContent())===BUILD);

  console.log('\nB. a stale proxy is named, with what to upload where');
  p = await open({ ok:true, locked:false, build:'2026-01-01.1' });
  check('warned', await shown(p,'#build-warn'));
  const t = await p.locator('#build-warn-detail').textContent();
  check('names both builds', t.includes(BUILD)&&t.includes('2026-01-01.1'), t.slice(0,90));
  check('says which file goes where', /index\.html goes to Netlify/.test(t)&&/server\.js to Render/.test(t));

  console.log('\nC. a proxy too old to report a build is treated as out of date');
  p = await open({ ok:true, locked:false });
  check('warned', await shown(p,'#build-warn'));
  check('says it predates the stamp', /predates it/.test(await p.locator('#build-warn-detail').textContent()));
  check('settings says so too',
        /older than the build stamp/.test(await p.locator('#build-stamp-proxy').textContent()));

  console.log('\nD. an unreachable proxy is a different problem, not a build one');
  const page = await (await b.newContext({ignoreHTTPSErrors:true})).newPage();
  page.on('pageerror',e=>errs.push(e.message));
  await page.addInitScript(()=>localStorage.setItem('cfg_proxy','https://proxy.test'));
  await page.route('**/proxy.test/**', r => r.abort());
  await page.goto(PAGE); await page.waitForTimeout(1200);
  check('no build warning', !(await shown(page,'#build-warn')));
  check('settings says it could not reach it',
        (await page.locator('#build-stamp-proxy').textContent())==='could not reach it',
        await page.locator('#build-stamp-proxy').textContent());

  console.log('\nE. page health');
  check('zero page errors', errs.length===0, errs.join(' | ')||'none');
  await b.close();
  console.log(failures?`\n${failures} FAILURE(S)`:'\nall checks passed');
  process.exit(failures?1:0);
})();
