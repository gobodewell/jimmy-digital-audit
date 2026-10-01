// The promise of history is: run an audit, find that client months later,
// reopen it and get the same audit back. That round trip is what this checks --
// state captured, state restored, and the delivered PDF retrievable.
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

  console.log('\nA. the captured state carries everything needed to rebuild');
  const cap = await page.evaluate(()=>{
    document.getElementById('clientName').value='Totus Wealth Management';
    document.getElementById('clientURL').value='https://totuswm.com';
    document.getElementById('clientCity').value='Houston, Texas';
    document.getElementById('h-li').value='https://linkedin.com/company/totus';
    document.getElementById('n-web').value='Homepage is heavy.';
    document.getElementById('man-spd').value='4.2';
    AD.da=13; AD.traffic=15633;
    CHECKS.forEach((c,n)=>{ const e=document.getElementById(c.id); if(e) e.checked = n%2===0; });
    UNK.set('c-mob','homepage returned HTTP 403 from Cloudflare');
    DIRECT.add('c-spd');
    recalc();
    return auditState();
  });
  check('version stamped', cap.v===1, String(cap.v));
  check('all 40 check states', cap.checks.length===40, String(cap.checks.length));
  check('unmeasured reasons kept', cap.unk.length===1 && /Cloudflare/.test(cap.unk[0][1]));
  check('measured-directly set kept', cap.direct.includes('c-spd'));
  const f=Object.fromEntries(cap.fields);
  check('client fields kept', f.clientName==='Totus Wealth Management' && f.clientURL==='https://totuswm.com');
  check('notes kept', f['n-web']==='Homepage is heavy.');
  check('social handle kept', f['h-li'].includes('linkedin.com/company/totus'));
  check('hand-entered figure kept', f['man-spd']==='4.2');
  check('AD carried', cap.AD.da===13);
  const kb=Math.round(JSON.stringify(cap).length/1024);
  check('state is a sane size', kb>0 && kb<200, kb+'KB');

  console.log('\nB. restoring it reproduces the same audit');
  const back = await page.evaluate(st=>{
    // Wipe everything first, so a pass cannot come from leftover state.
    clearAll();
    applyState(st);
    return {
      name: getVal('clientName'), city: getVal('clientCity'),
      note: getVal('n-web'), spd: getVal('man-spd'),
      checks: CHECKS.map(c=>[c.id, !!(document.getElementById(c.id)||{}).checked]),
      unk: [...UNK.entries()], direct:[...DIRECT], da: AD.da
    };
  }, cap);
  check('name restored', back.name==='Totus Wealth Management', back.name);
  check('city restored', back.city==='Houston, Texas');
  check('notes restored', back.note==='Homepage is heavy.');
  check('hand-entered figure restored', back.spd==='4.2');
  check('every checkbox matches', JSON.stringify(back.checks)===JSON.stringify(cap.checks));
  check('unmeasured reason restored', back.unk.length===1 && /Cloudflare/.test(back.unk[0][1]));
  check('measured set restored', back.direct.includes('c-spd'));
  check('AD restored', back.da===13);

  console.log('\nC. filing sends the domain, the scores and the PDF');
  const sent = await page.evaluate(async()=>{
    let body=null;
    window.pf = async (p,o) => { body={path:p, json:JSON.parse(o.body)};
      return { json: async()=>({ ok:true, id:'abc', domain:'totuswm.com' }) }; };
    await fileAudit('JVBERi0xLjQ=', 'note');
    return body;
  });
  check('posted to the history route', sent.path==='/history/save', sent.path);
  check('sent the client URL', sent.json.clientUrl==='https://totuswm.com');
  check('sent the scores', sent.json.scores && sent.json.scores.overall!=null);
  check('sent the PDF', sent.json.pdfBase64==='JVBERi0xLjQ=');
  check('sent the build stamp', !!sent.json.build);
  check('sent the state', !!sent.json.state && sent.json.state.checks.length===40);

  console.log('\nD. history unavailable falls back to the local copy, and says so');
  const fb = await page.evaluate(async()=>{
    localStorage.setItem('audit_history', JSON.stringify([
      {clientName:'Old Firm', clientURL:'https://old.com', savedAt:new Date().toISOString(), scores:{overall:70}}]));
    window.pf = async()=>{ throw new Error('could not reach the proxy'); };
    await renderHist();
    return { msg: document.getElementById('hist-msg').textContent,
             list: document.getElementById('histList').textContent };
  });
  check('says the central store is down', /unavailable/.test(fb.msg), fb.msg.slice(0,60));
  check('warns they cannot be reopened', /cannot be reopened/.test(fb.msg));
  check('still shows the local audit', /Old Firm/.test(fb.list));

  console.log('\nE. the list groups a client\'s runs together');
  const grouped = await page.evaluate(async()=>{
    const mk=(n,d,o,t)=>({id:'11111111-2222-3333-4444-55555555555'+n, created_at:t,
      client_domain:d, client_name:n, score_overall:o, score_v:o, score_w:o, score_s:o,
      kpis_passed:29, kpis_total:40, pdf_path: o===89 ? d+'/a.pdf' : null, prepared_by:'', build:'x'});
    window.pf = async()=>({ json: async()=>({ audits:[
      mk('1','totuswm.com',91,'2026-09-30T10:00:00Z'),
      mk('2','totuswm.com',89,'2026-06-01T10:00:00Z'),
      mk('3','other.com',  75,'2026-05-01T10:00:00Z')] }) });
    await renderHist();
    return { msg: document.getElementById('hist-msg').textContent,
             html: document.getElementById('histList').innerHTML };
  });
  check('counts audits and clients', /3 audits across 2 clients/.test(grouped.msg), grouped.msg);
  check('domain shown once per client',
        (grouped.html.match(/totuswm\.com/g)||[]).length >= 1 &&
        (grouped.html.match(/·\s*2 audits/)||[]).length===1, 'grouping');
  check('a run with a report offers the PDF', /histPdf\(/.test(grouped.html));
  check('a run without one does not offer it',
        (grouped.html.match(/histPdf\(/g)||[]).length===1,
        String((grouped.html.match(/histPdf\(/g)||[]).length));
  check('says when no report was generated', /no report was generated/.test(grouped.html));
  check('every run can be opened', (grouped.html.match(/histOpen\(/g)||[]).length===3);

  console.log('\nF. page health');
  check('zero page errors', errs.length===0, errs.join(' | ')||'none');
  await b.close();
  console.log(failures?`\n${failures} FAILURE(S)`:'\nall checks passed');
  process.exit(failures?1:0);
})();
