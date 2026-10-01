// LinkedIn serves an AUTHWALL to anything not signed in, so the model reports
// what it landed on and that wrapper was being written into the handle field
// verbatim. SocialFetch was then handed a login page instead of a profile: the
// follower count fails for a profile that exists, and it reads as a broken
// integration rather than what it is.
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

  const norm = (plat,u) => page.evaluate(([p,x])=>normalizeSocialUrl(p,x), [plat,u]);

  console.log('\nA. the authwall is unwrapped to the profile inside it');
  let r = await norm('linkedin',
    'https://www.linkedin.com/authwall?trk=bf&sessionRedirect=https%3A%2F%2Fwww.linkedin.com%2Fcompany%2Ftotus-wealth');
  check('recovered the profile', r.url==='https://linkedin.com/company/totus-wealth', JSON.stringify(r));

  console.log('\nB. an authwall with nothing inside is refused, not stored');
  r = await norm('linkedin','https://www.linkedin.com/authwall?trk=qf');
  check('refused', !!r.error, JSON.stringify(r));
  check('says why in plain words', /sign-in wall/.test(r.error||''), r.error);

  console.log('\nC. tracking noise is stripped from a good URL');
  r = await norm('linkedin',
    'https://www.linkedin.com/company/totus-wealth/?trk=abc&originalSubdomain=us&utm_source=x');
  check('clean profile URL', r.url==='https://linkedin.com/company/totus-wealth', JSON.stringify(r));

  console.log('\nD. a good URL is left alone');
  for (const [p,u,want] of [
    ['linkedin','https://www.linkedin.com/company/totus-wealth','https://linkedin.com/company/totus-wealth'],
    ['linkedin','https://linkedin.com/in/jane-doe','https://linkedin.com/in/jane-doe'],
    ['facebook','https://www.facebook.com/TotusWM','https://facebook.com/TotusWM'],
    ['youtube','https://www.youtube.com/@totuswm','https://youtube.com/@totuswm']
  ]) {
    r = await norm(p,u);
    check(p+' untouched', r.url===want, JSON.stringify(r));
  }

  console.log('\nE. a bare handle needs no unwrapping');
  r = await norm('instagram','@totuswm');
  check('handle kept, @ stripped', r.url==='totuswm', JSON.stringify(r));

  console.log('\nF. a URL on the wrong platform is caught');
  r = await norm('linkedin','https://www.facebook.com/TotusWM');
  check('refused', !!r.error, JSON.stringify(r));
  check('names the mismatch', /facebook\.com, not linkedin/.test(r.error||''), r.error);

  console.log('\nG. end to end: an authwall does NOT tick "has LinkedIn"');
  const out = await page.evaluate(()=>{
    document.getElementById('c-hli').checked=false;
    document.getElementById('h-li').value='';
    applySocialJSON({ linkedin:{ found:true, url:'https://www.linkedin.com/authwall?trk=x', followers:400 } });
    return { ticked:document.getElementById('c-hli').checked,
             field:document.getElementById('h-li').value,
             note:document.getElementById('sf-lastpost').textContent };
  });
  check('box not ticked on a login page', out.ticked===false, JSON.stringify(out.ticked));
  check('junk not written to the field', out.field==='', JSON.stringify(out.field));
  check('the skip is reported, not silent', /Could not use the URL/.test(out.note), out.note.slice(0,70));
  check('tells you what to do', /paste the profile URL in by hand/.test(out.note));

  console.log('\nH. end to end: a wrapped-but-recoverable URL DOES tick it');
  const ok = await page.evaluate(()=>{
    document.getElementById('c-hli').checked=false;
    document.getElementById('h-li').value='';
    applySocialJSON({ linkedin:{ found:true, followers:400,
      url:'https://www.linkedin.com/authwall?sessionRedirect=https%3A%2F%2Fwww.linkedin.com%2Fcompany%2Ftotus-wealth' } });
    return { ticked:document.getElementById('c-hli').checked,
             field:document.getElementById('h-li').value };
  });
  check('box ticked', ok.ticked===true);
  check('clean URL stored', ok.field==='https://linkedin.com/company/totus-wealth', ok.field);

  console.log('\nI. page health');
  check('zero page errors', errs.length===0, errs.join(' | ')||'none');
  await b.close();
  console.log(failures?`\n${failures} FAILURE(S)`:'\nall checks passed');
  process.exit(failures?1:0);
})();
