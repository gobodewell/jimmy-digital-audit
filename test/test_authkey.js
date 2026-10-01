const path = require('path');
// Resolved from this file so the suite runs from any directory.
const PAGE = 'file://' + path.resolve(__dirname, '..', 'index.html');
// The audit key lives in localStorage: per browser, per device. So the person
// who set it sees a working app and a teammate opening the same URL sees every
// step fail with "unauthorized". Same build, same server, different browser.
const { chromium } = require('playwright');
let failures=0;
const check=(l,c,d)=>{console.log((c?'  PASS  ':'  FAIL  ')+l+(d?'   → '+d:'')); if(!c) failures++;};

(async()=>{
  const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});

  const open = async (ctx, key) => {
    const page = await ctx.newPage();
    await page.addInitScript(k => {
      if (k) localStorage.setItem('cfg_audit', k);
      localStorage.setItem('cfg_proxy', 'https://proxy.test');
    }, key);
    // One handler: Playwright consults the LAST-registered route first, so a
    // separate /health route is shadowed by the catch-all, and continue() then
    // sends the probe to the real network instead of the mock.
    const CORS = { 'access-control-allow-origin': '*' };
    await page.route('**/proxy.test/**', r => {
      const url = r.request().url();
      if (url.includes('/health')) return r.fulfill({ status:200,
        contentType:'application/json', headers:CORS,
        body: JSON.stringify({ ok:true, locked:true }) });
      const sent = r.request().headers()['x-audit-key'];
      return sent === 'correct-key'
        ? r.fulfill({ status:200, contentType:'application/json', headers:CORS, body:'{"da":42}' })
        : r.fulfill({ status:401, contentType:'application/json', headers:CORS,
                      body:'{"error":"unauthorized"}' });
    });
    await page.goto(PAGE);
    await page.waitForTimeout(1200);
    return page;
  };

  console.log('\nA. the teammate: no key in this browser');
  const them = await open(await b.newContext({ ignoreHTTPSErrors: true }), null);
  check('warned before running anything',
        await them.evaluate(() => document.getElementById('key-warn').style.display !== 'none'));
  const warn = await them.locator('#key-warn').textContent();
  check('says where the key goes', /Settings.{0,3}→.{0,3}Audit key/.test(warn), warn.slice(0,90));
  check('explains why it did not travel', /per browser/.test(warn));

  console.log('\nB. and a step failure now names the fix, not just "unauthorized"');
  const msg = await them.evaluate(async () => {
    try { await pf('/domain/overview?domain=x.com'); return 'no error'; }
    catch (e) { return e.message; }
  });
  check('not a bare unauthorized', !/^unauthorized$/.test(msg), msg.slice(0,80));
  check('names the missing key', /needs a shared audit key/.test(msg), msg.slice(0,80));
  check('points at Settings', /Settings.{0,3}→.{0,3}Audit key/.test(msg));

  console.log('\nC. the owner: same build, same server, key present');
  const you = await open(await b.newContext({ ignoreHTTPSErrors: true }), 'correct-key');
  check('no warning shown',
        await you.evaluate(() => document.getElementById('key-warn').style.display === 'none'));
  const ok = await you.evaluate(async () => {
    const r = await pf('/domain/overview?domain=x.com'); return (await r.json()).da;
  });
  check('calls succeed', ok === 42, JSON.stringify(ok));

  console.log('\nD. a WRONG key is a different message from a missing one');
  const wrong = await open(await b.newContext({ ignoreHTTPSErrors: true }), 'stale-key');
  const m2 = await wrong.evaluate(async () => {
    try { await pf('/domain/overview?domain=x.com'); return 'no error'; }
    catch (e) { return e.message; }
  });
  check('says it was rejected, not absent', /rejected this audit key/.test(m2), m2.slice(0,80));
  check('no warning banner (a key IS set)',
        await wrong.evaluate(() => document.getElementById('key-warn').style.display === 'none'));

  console.log('\nE. an unlocked server warns nobody');
  const ctx = await b.newContext({ ignoreHTTPSErrors: true });
  const p3 = await ctx.newPage();
  await p3.addInitScript(() => localStorage.setItem('cfg_proxy','https://proxy.test'));
  await p3.route('**/health', r => r.fulfill({ status:200, contentType:'application/json',
    headers:{'access-control-allow-origin':'*'}, body: JSON.stringify({ ok:true, locked:false }) }));
  await p3.goto(PAGE);
  await p3.waitForTimeout(400);
  check('no warning when no key is required',
        await p3.evaluate(() => document.getElementById('key-warn').style.display === 'none'));

  await b.close();
  console.log(failures?`\n${failures} FAILURE(S)`:'\nall checks passed');
  process.exit(failures?1:0);
})();
