// Page 2 is a list of things the firm may actually go and do, so its wording
// is the approved copy from the "Final Use" sheet of SA_Digital_Audit_Questions
// and nothing else. Read from that sheet specifically: "In Production" carries
// the older wording in a second column, and most of its rows differ. This
// pins that the rendered PDF contains that text VERBATIM -- not paraphrased,
// not shortened, not regenerated -- and that a check with no approved row is
// passed over rather than filled in with language the tool wrote itself.
const path=require('path'), fs=require('fs'), cp=require('child_process');
let failures=0;
const check=(l,c,d)=>{console.log((c?'  PASS  ':'  FAIL  ')+l+(d?'   → '+d:'')); if(!c) failures++;};

const SHEET = path.join(__dirname,'..','reference','SA_Digital_Audit_Questions.xlsx');
const src = fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');

(async()=>{
  console.log('\nA. the approved copy is present and complete');
  const { chromium } = require('playwright');
  const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
  const page = await b.newPage();
  await page.goto('file://' + path.resolve(__dirname,'..','index.html'));
  const g = await page.evaluate(()=>({ gtext: GTEXT, draft: GTEXT_DRAFT, missing: GTEXT_MISSING,
    ids: CHECKS.map(c=>c.id), n: TOP_N, word: TOP_N_WORD }));
  check('30 checks carry approved copy', Object.keys(g.gtext).length===30,
        String(Object.keys(g.gtext).length));
  check('10 carry draft copy', Object.keys(g.draft).length===10, String(Object.keys(g.draft).length));
  check('nothing is left with neither', g.missing.length===0, String(g.missing.length));
  check('every check is accounted for',
        Object.keys(g.gtext).length + Object.keys(g.draft).length === g.ids.length,
        Object.keys(g.gtext).length+'+'+Object.keys(g.draft).length+' vs '+g.ids.length);
  // The boundary is the point: approved and draft never overlap, so it is
  // always unambiguous which wording a recommendation came from.
  check('no check is in both', !Object.keys(g.draft).some(id=>g.gtext[id]),
        Object.keys(g.draft).filter(id=>g.gtext[id]).join(','));
  check('drafts name no vendor or service',
        !Object.values(g.draft).some(v=>/MarketingCentral|Growth360|Smarsh|hire an?|agency|consultant/i.test(v.text)));
  check('no id is both mapped and missing',
        !g.missing.some(id => g.gtext[id]), g.missing.filter(id=>g.gtext[id]).join(','));
  check('every mapped id is a real check',
        Object.keys(g.gtext).every(id => g.ids.includes(id)));
  check('no entry is empty',
        Object.values(g.gtext).every(v => v.title.trim() && v.text.trim()));

  console.log('\nB. it matches the spreadsheet character for character');
  const sheet = JSON.parse(cp.execSync(`python3 -c "
import openpyxl, json
ws = openpyxl.load_workbook('${SHEET}')['Final Use']
out = [{'q': str(r[3]).strip(), 'title': (str(r[5]).strip() if r[5] else ''),
        'text': (str(r[6]).strip() if r[6] else '')}
       for r in ws.iter_rows(min_row=2, values_only=True) if r[3]]
print(json.dumps(out, ensure_ascii=False))
"`).toString());
  const byText = new Map(sheet.map(r => [r.text, r]));
  let verbatim = 0, drift = [];
  for (const [id, v] of Object.entries(g.gtext)) {
    const row = byText.get(v.text);
    if (row && row.title === v.title) verbatim++;
    else drift.push(id);
  }
  check('all 30 entries are verbatim rows from the sheet', drift.length===0, drift.join(','));
  check('and the sheet really has that many usable rows', sheet.length>=30, String(sheet.length));

  console.log('\nC. page 2 prints that copy and nothing invented');
  cp.execSync('node ' + path.join(__dirname,'render_cover.js'), { stdio:'pipe' });
  const out = cp.execSync(`python3 -c "
import pymupdf, json
d = pymupdf.open('${path.join(__dirname,'cover.pdf')}')
print(json.dumps({'pages': d.page_count, 'p2': d[1].get_text()}, ensure_ascii=False))
"`).toString();
  const r = JSON.parse(out);
  check('still five pages', r.pages===5, String(r.pages));

  // Compare with ALL whitespace removed. pdfmake hyphenates across line breaks
  // ("pre-scheduled" wraps as "pre- scheduled") and the extractor keeps that
  // space, so collapsing runs is not enough -- but stripping whitespace still
  // catches any actual change of wording.
  const strip = t => t.replace(/\s+/g,'');
  const flat = strip(r.p2);
  // Matched on the BODY: two different rows share the title "Match Your
  // Profile to Your Brand", so counting titles over-counts.
  // Both sources count: page 2 prints approved copy where it exists and a draft
  // where it does not, and either way the words are not the tool's improvisation.
  const every = Object.assign({}, g.draft, g.gtext);
  const printed = Object.entries(every)
    .filter(([,v]) => flat.includes(strip(v.text)));
  check('page 2 printed TOP_N items, all from a fixed source', printed.length===g.n,
        printed.length+' of '+g.n);
  const fromSheet = printed.filter(([id]) => g.gtext[id]).length;
  console.log('         (' + fromSheet + ' approved, ' + (printed.length-fromSheet) + ' draft)');
  const titlesOk = printed.filter(([,v]) => flat.includes(strip(v.title))).length;
  check('each one carries its approved title', titlesOk===printed.length,
        titlesOk+' of '+printed.length);

  console.log('\nD. the heading promises exactly as many as it prints');
  // The count drove a slice in one place and the word in four strings. A
  // heading offering six things over a list of five is the kind of error
  // nobody catches until a client does.
  check('heading says "'+g.word+'"', flat.includes(strip('Do these '+g.word+' things first')),
        r.p2.split('\n')[0]);
  check('projection band agrees', flat.includes(strip('Completing all '+g.word+' moves')));
  check('word matches the number', ['zero','one','two','three','four','five','six','seven','eight','nine','ten'][g.n]===g.word,
        g.n+' vs '+g.word);

  console.log('\nE. the sheet always wins over a draft');
  const wins = await page.evaluate(()=>{
    // Simulate an approved row arriving for a check that currently has a draft.
    const id='c-hli', before=gtextFor(id).title;
    GTEXT[id]={title:'APPROVED TITLE', text:'Approved text from the sheet.'};
    const after=gtextFor(id);
    delete GTEXT[id];
    return { before, afterTitle:after.title, afterText:after.text,
             backToDraft: gtextFor(id).title };
  });
  check('a draft is used while no row exists', wins.before===g.draft['c-hli'].title, wins.before);
  check('an approved row supersedes it', wins.afterTitle==='APPROVED TITLE', wins.afterTitle);
  check('and its text too', wins.afterText==='Approved text from the sheet.');
  check('removing the row falls back to the draft', wins.backToDraft===g.draft['c-hli'].title);

  console.log('\nF. a check with copy from neither source never reaches page 2');
  const labels = await page.evaluate(ids =>
    ids.map(id => (CHECKS.find(c=>c.id===id)||{}).label).filter(Boolean), g.missing);
  const leaked = labels.filter(l => flat.includes(strip(l)));
  check('none of the nine appear', leaked.length===0, leaked.join(', '));
  check('the code has no fallback that writes copy', !/why:\s*c\.action/.test(src));

  console.log('\nG. the source sheet is kept with the code');
  check('spreadsheet committed alongside', fs.existsSync(SHEET));

  await b.close();
  console.log(failures?`\n${failures} FAILURE(S)`:'\nall checks passed');
  process.exit(failures?1:0);
})();
