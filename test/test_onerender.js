// The report the client gets, and the report we keep, must be the same bytes.
//
// A delivered audit was fourteen pages, five of them blank, with the
// right-hand group of every section missing: 17 of its 40 questions survived.
// The copy the advisor downloaded was fine. Only the copy in history -- the
// one linked from Airtable, the one anybody looks at later -- was wrong.
//
// The cause was two renders of one object:
//
//     const pdf = pdfMake.createPdf(doc);
//     await new Promise(res => pdf.download(name, res));   // render 1
//     const b64 = await new Promise(r => pdf.getBase64(r)); // render 2
//
// pdfmake annotates the document definition while laying it out, so the second
// render walks an already-measured tree and lays out a DIFFERENT document. The
// comment above that code claimed it filed "the exact bytes the client just
// received". It did not, and had not since the day it was written.
//
// Section A keeps the hazard on the record, because the fix looks like a
// pointless detour unless you can see what it avoids.
const path = require('path');
const fs   = require('fs');
const os   = require('os');
process.env.CHROMIUM_PATH = process.env.CHROMIUM_PATH ||
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let failures = 0;
const check = (l, c, d) => {
  console.log((c ? '  PASS  ' : '  FAIL  ') + l + (d ? '   -> ' + d : ''));
  if (!c) failures++;
};

const inspect = b64 => {
  const f = path.join(os.tmpdir(), 'once-' + Math.random() + '.pdf');
  fs.writeFileSync(f, Buffer.from(b64, 'base64'));
  const out = require('child_process').execFileSync('python3', ['-c', `
import pymupdf, json, re, sys
d = pymupdf.open(sys.argv[1])
raw = ' '.join(p.get_text() for p in d)
flat = re.sub(r'\\s+', '', raw).lower()
blank = []
for i, p in enumerate(d):
    t = p.get_text().strip()
    t = t.replace('For financial professional use only. Not for use with the public.', '')
    t = re.sub(r'Reviewed\\s*\\d{1,2}/\\d{1,2}/\\d{4}\\s*·\\s*Page\\s*\\d+', '', t)
    if not ''.join(t.split()): blank.append(i + 1)
print(json.dumps({'pages': d.page_count, 'blank': blank,
                  'questions': raw.count('?'),
                  'flat': flat}))
`, f]).toString();
  fs.unlinkSync(f);
  return JSON.parse(out);
};

(async () => {
  let browser;
  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
    const page = await browser.newPage();
    const errs = []; page.on('pageerror', e => errs.push(e.message));
    await page.goto('file://' + path.resolve(__dirname, '..', 'index.html'),
                    { waitUntil: 'load', timeout: 60000 });

    const both = await page.evaluate(async () => {
      UNK.clear();
      const boxes = [...document.querySelectorAll('.ci input')];
      boxes.forEach((i, n) => { i.checked = (n % 3 !== 0); });
      document.getElementById('clientName').value = 'Lovett & Associates';
      document.getElementById('clientURL').value  = 'https://www.lovettfinancial.com';
      recalc();
      const A = window.REPORT_ASSETS;
      pdfMake.vfs = Object.assign({}, pdfMake.vfs || {}, A.vfs);
      pdfMake.fonts = A.fonts;
      const d = assembleReport(); d.preparedBy = 'Emma Petter';
      const doc = buildReportDoc(d,
        { logoWhite: A.logoWhite, logoPurple: A.logoPurple, coverBg: A.cover });
      const pdf = pdfMake.createPdf(doc);
      const first  = await new Promise(r => pdf.getBase64(x => r(x)));
      const second = await new Promise(r => pdf.getBase64(x => r(x)));
      return { first, second, groups: d.sections.flatMap(s => s.groups.map(g => g.name)) };
    });
    check('the page built a report without throwing', errs.length === 0, errs.join(' | '));

    const one = inspect(both.first);
    const two = inspect(both.second);

    console.log('\nA. the hazard this guards against is real');
    console.log('   render 1: ' + one.pages + ' pages, ' + one.questions + ' questions' +
                (one.blank.length ? ', blank ' + one.blank.join(',') : ''));
    console.log('   render 2: ' + two.pages + ' pages, ' + two.questions + ' questions' +
                (two.blank.length ? ', blank ' + two.blank.join(',') : ''));
    check('rendering the same pdfmake object twice really does differ — ' +
          'which is why the report is rendered once',
          one.pages !== two.pages || one.questions !== two.questions,
          one.pages + 'p/' + one.questions + 'q vs ' + two.pages + 'p/' + two.questions + 'q');

    console.log('\nB. the page renders once and downloads those bytes');
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8')
      .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
    check('nothing calls pdf.download() any more',
          !/pdf\.download\(/.test(src));
    check('getBase64 is called exactly once in the whole page',
          (src.match(/getBase64\(/g) || []).length === 1,
          (src.match(/getBase64\(/g) || []).length + ' call sites');
    check('and the download is built from those same bytes',
          /URL\.createObjectURL\(new Blob\(\[bytes\]/.test(src) &&
          /a\.download = name/.test(src));
    check('the audit is filed with that same b64, not a fresh render',
          /fileAudit\(b64, '', d\)/.test(src));

    console.log('\nC. the single render is a complete report');
    const norm = s => s.replace(/\s+/g, '').toLowerCase();
    const missing = both.groups.filter(g => !one.flat.includes(norm(g)));
    check('every group of every section is in it',
          missing.length === 0,
          missing.length ? 'missing: ' + missing.join(', ') : both.groups.length + ' groups');
    check('all forty questions are in it', one.questions >= 40,
          one.questions + ' question marks');
    check('and no page carries only the footer', one.blank.length === 0,
          one.blank.length ? 'blank: ' + one.blank.join(',') : 'none');
  } catch (e) {
    console.log('  FAIL  threw: ' + e.message); failures++;
  } finally { if (browser) await browser.close(); }

  console.log();
  console.log(failures ? failures + ' check(s) failed' : 'all checks passed');
  process.exit(failures ? 1 : 0);
})();
