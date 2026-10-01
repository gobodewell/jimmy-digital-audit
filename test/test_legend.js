// "Not measured" stayed in the legend on pages that have none -- it explained a
// mark the reader never sees. It has to STAY on a page that has one: an
// unexplained "?" beside a question reads as a failure, and the whole point of
// that mark is that the check was NOT failed.
//
// Checked against the document definition rather than a rendered PDF: the
// question is which legend entries were emitted, and building two PDFs to ask
// it took minutes.
const path=require('path');
const PAGE='file://'+path.resolve(__dirname,'..','index.html');
const { chromium }=require('playwright');
let failures=0;
const check=(l,c,d)=>{console.log((c?'  PASS  ':'  FAIL  ')+l+(d?'   → '+d:'')); if(!c) failures++;};

const legends = (page, unk) => page.evaluate(id => {
  UNK.clear();
  document.querySelectorAll('.ci input').forEach(i => i.checked = true);
  if (id) { document.getElementById(id).checked = false;
            UNK.set(id, 'homepage returned HTTP 403 from Cloudflare'); }
  recalc();
  const d = assembleReport();
  const A = window.REPORT_ASSETS;
  const doc = buildReportDoc(d, { logoWhite:A.logoWhite, logoPurple:A.logoPurple, coverBg:A.cover });
  // Every legend row in the document, as the text it will print.
  const flat = JSON.stringify(doc.content);
  return {
    sections: d.sections.map(s => ({
      name: s.name,
      hasUnknown: s.groups.some(g => g.items.some(k => k.state === 'unknown'))
    })),
    notMeasuredCount: (flat.match(/Not measured/g) || []).length,
    passedCount: (flat.match(/"Passed"/g) || []).length
  };
}, unk);

(async()=>{
  const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
  const page=await b.newPage();
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  await page.goto(PAGE);

  console.log('\nA. nothing unmeasured — the key is not printed at all');
  let r = await legends(page, null);
  check('three scorecard sections', r.sections.length===3, String(r.sections.length));
  check('none of them has an unmeasured check',
        r.sections.every(s => !s.hasUnknown), JSON.stringify(r.sections));
  check('"Not measured" appears nowhere', r.notMeasuredCount===0, String(r.notMeasuredCount));
  check('the marks still in use are still keyed', r.passedCount===3, String(r.passedCount));

  console.log('\nB. one unmeasured check — the key returns, on that page only');
  // c-mob sits on the Website page: the Cloudflare case that keeps recurring.
  r = await legends(page, 'c-mob');
  const withUnk = r.sections.filter(s => s.hasUnknown);
  check('exactly one section has one', withUnk.length===1,
        withUnk.map(s=>s.name).join(','));
  check('and it is the Website page', withUnk[0] && withUnk[0].name==='Website Performance',
        withUnk[0] && withUnk[0].name);
  check('"Not measured" printed exactly once', r.notMeasuredCount===1, String(r.notMeasuredCount));
  check('the other two pages still omit it', r.passedCount===3, String(r.passedCount));

  console.log('\nC. page health');
  check('zero page errors', errs.length===0, errs.join(' | ')||'none');
  await b.close();
  console.log(failures?`\n${failures} FAILURE(S)`:'\nall checks passed');
  process.exit(failures?1:0);
})();
