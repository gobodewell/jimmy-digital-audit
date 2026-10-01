// Some CDNs refuse Google's crawler outright, so on those sites nobody can
// measure the technical numbers automatically. A person running Lighthouse
// themselves and typing the result in IS a measurement -- it should score, it
// should record a FAILURE as readily as a pass, and it must not be silently
// thrown away by a later automatic run.
const path = require('path');
const PAGE = 'file://' + path.resolve(__dirname, '..', 'index.html');
const { chromium } = require('playwright');
let failures=0;
const check=(l,c,d)=>{console.log((c?'  PASS  ':'  FAIL  ')+l+(d?'   → '+d:'')); if(!c) failures++;};

(async()=>{
  const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
  const page=await (await b.newContext({ignoreHTTPSErrors:true})).newPage();
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  await page.goto(PAGE);
  await page.evaluate(()=>{ initSteps(); st('website'); });   // the inputs live on the Website tab

  console.log('\nA. a failing number entered by hand records the FAILURE');
  await page.fill('#man-spd','4.2'); await page.fill('#man-sz','5.4'); await page.fill('#man-ps','38');
  let r = await page.evaluate(()=>({ spd:document.getElementById('c-spd').checked,
    szp:document.getElementById('c-szp').checked, speed:AD.speed, size:AD.size,
    tile:document.getElementById('m-spd').textContent, src:AD.speedSource }));
  check('under-3s box NOT ticked', r.spd===false, JSON.stringify(r.spd));
  check('under-3MB box NOT ticked', r.szp===false, JSON.stringify(r.szp));
  check('value recorded', r.speed==='4.2'&&r.size==='5.4', r.speed+'/'+r.size);
  check('tile shows it', r.tile==='4.2s', r.tile);
  check('marked hand-entered', r.src==='entered by hand', r.src);
  const msg = await page.locator('#man-tech-msg').textContent();
  check('states what it scored', /fails the under-3s check/.test(msg), msg.slice(0,80));

  console.log('\nB. a passing number ticks the boxes');
  await page.fill('#man-spd','1.8'); await page.fill('#man-sz','2.1');
  r = await page.evaluate(()=>({ spd:document.getElementById('c-spd').checked,
    szp:document.getElementById('c-szp').checked }));
  check('speed box ticked', r.spd===true);
  check('size box ticked', r.szp===true);

  console.log('\nC. an AI pass cannot overwrite a hand-entered measurement');
  const held = await page.evaluate(()=>{
    document.getElementById('man-spd').value='4.9'; applyManualTech();
    return { blockedByGuard: DIRECT.has('c-spd'), stillFalse: !document.getElementById('c-spd').checked };
  });
  check('claimed as measured', held.blockedByGuard===true);
  check('failure stands', held.stillFalse===true);

  console.log('\nD. a later PageSpeed run does not silently replace it');
  const after = await page.evaluate(async()=>{
    window.pf = async () => ({ json: async () => ({ speed:'1.1', sizeMB:'0.9', perfScore:95,
      strategy:'desktop', speedPass:true, sizePass:true, isHttps:true, thirdParty:[] }) });
    await runLighthouse('https://x.com');
    return { speed:AD.speed, ticked:document.getElementById('c-spd').checked,
             tile:document.getElementById('m-spd').textContent,
             note:document.getElementById('man-tech-msg').textContent };
  });
  check('human figure kept', after.speed==='4.9', after.speed);
  check('box still reflects the human figure', after.ticked===false);
  check('tile unchanged', after.tile==='4.9s', after.tile);
  check('the disagreement is surfaced', /disagrees/.test(after.note), after.note.slice(0,90));
  check('names both numbers', /4\.9/.test(after.note)&&/1\.1/.test(after.note));

  console.log('\nE. clearing the field hands the check back, as unmeasured');
  const cleared = await page.evaluate(()=>{
    document.getElementById('man-spd').value=''; applyManualTech();
    return { speed:AD.speed, src:AD.speedSource, ticked:document.getElementById('c-spd').checked,
             unknown:UNK.has('c-spd'), tile:document.getElementById('m-spd').textContent };
  });
  check('value dropped', cleared.speed===null, JSON.stringify(cleared.speed));
  check('provenance dropped', cleared.src===null);
  check('box unticked', cleared.ticked===false);
  check('recorded as unmeasured, not failed', cleared.unknown===true, JSON.stringify(cleared.unknown));
  check('tile reset', cleared.tile==='—', cleared.tile);

  console.log('\nF. the report says the figure was hand-entered');
  const rep = await page.evaluate(()=>{
    document.getElementById('man-sz').value='5.4'; applyManualTech();
    return summaryPayload().metrics['Homepage size (MB)'];
  });
  check('provenance carried into the summary', /entered by hand/.test(String(rep)), String(rep));

  console.log('\nG. with nothing entered, automatic values work as before');
  const auto = await page.evaluate(async()=>{
    ['man-spd','man-sz','man-ps'].forEach(i=>document.getElementById(i).value='');
    applyManualTech();
    window.pf = async () => ({ json: async () => ({ speed:'2.0', sizeMB:'1.5', perfScore:88,
      strategy:'desktop', speedPass:true, sizePass:true, isHttps:true, thirdParty:[] }) });
    await runLighthouse('https://x.com');
    return { speed:AD.speed, ticked:document.getElementById('c-spd').checked,
             src:AD.speedSource };
  });
  check('automatic value used', auto.speed==='2.0', auto.speed);
  check('box ticked by PageSpeed', auto.ticked===true);
  check('not labelled hand-entered', auto.src==null, JSON.stringify(auto.src));

  console.log('\nH. page health');
  check('zero page errors', errs.length===0, errs.join(' | ')||'none');
  await b.close();
  console.log(failures?`\n${failures} FAILURE(S)`:'\nall checks passed');
  process.exit(failures?1:0);
})();
