// Blank pages in the delivered report.
//
// An audit reached a client as fourteen pages, five of them empty. Pages 4, 8,
// 11 and 14 each carried the running footer and ONE stray gold rule, four
// millimetres wide, alone on the sheet. Page 5 carried the footer and nothing
// at all.
//
// Two faults, both visible in that file:
//
//   The rule. ctaBar is a `columns` block -- a 4pt canvas, the copy, the
//   button -- and pdfmake measures and breaks each column separately. When the
//   space left fits the copy but not the 44pt rule beside it, the copy stays
//   and the rule goes over the fold on its own. Every section ends with one of
//   these, which is why there was one after every section.
//
//   The spacer. `{ text: '', pageBreak: 'after' }` is still an element. It can
//   land at the top of a fresh page, and then its own break pushes the real
//   content to the page after -- leaving a sheet with only the footer.
//
// Checked structurally. An earlier version of this file tried to reproduce the
// split by rendering the ctaBar at eighty different offsets across a page
// boundary, and it never once broke -- the real document's nesting is what
// provokes it, not a bar after plain text. A sweep that passes either way
// proves nothing, so it is gone; what is left asserts the two properties that
// make the faults impossible, and that a full report comes out clean.
const path = require('path');
const fs   = require('fs');
process.env.CHROMIUM_PATH = process.env.CHROMIUM_PATH ||
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let failures = 0;
const check = (l, c, d) => {
  console.log((c ? '  PASS  ' : '  FAIL  ') + l + (d ? '   -> ' + d : ''));
  if (!c) failures++;
};

const R = require(path.resolve(__dirname, '..', 'assets', 'report-doc.js'));

(async () => {
  let browser;
  try {
    console.log('\nA. a call-to-action cannot be split from its own rule');
    const plain  = R.ctaBar('https://example.com', null, 'Body copy.', 'Go', 16);
    const headed = R.ctaBar('https://example.com', 'A heading', 'Body copy.', 'Go', 20);
    check('the plain variant is unbreakable', plain.unbreakable === true,
          JSON.stringify(Object.keys(plain)));
    check('the headed variant is unbreakable', headed.unbreakable === true);
    check('and both are still the three-column block they were',
          plain.columns.length === 3 && headed.columns.length === 3);

    console.log('\nB. no empty element carries a page break on the report\'s behalf');
    // Comments stripped first: the fix is explained in a comment that quotes
    // the very thing it removed, and the first version of this check matched
    // that and reported the bug still present.
    const src = fs.readFileSync(
      path.resolve(__dirname, '..', 'assets', 'report-doc.js'), 'utf8')
      .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
    check('there is no { text: \'\', pageBreak } spacer left in the code',
          !/text:\s*''\s*,\s*pageBreak/.test(src));
    check('the break is put on the first real element instead',
          /breakBefore/.test(src) && /pageBreak:\s*'before'\s*\}\)/.test(src));

    console.log('\nC. a whole report, rendered through the proxy\'s own printer');
    const { chromium } = require('playwright');
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
    const page = await browser.newPage();
    const errs = []; page.on('pageerror', e => errs.push(e.message));
    await page.goto('file://' + path.resolve(__dirname, '..', 'index.html'),
                    { waitUntil: 'load', timeout: 60000 });
    const doc = await page.evaluate(() => {
      UNK.clear();
      // A real audit, not a perfect one: a firm with work to do is what makes
      // the sections long enough to run past a page.
      const boxes = [...document.querySelectorAll('.ci input')];
      boxes.forEach((i, n) => { i.checked = (n % 3 !== 0); });
      const miss = boxes.find(i => !i.checked);
      if (miss) UNK.set(miss.id, 'homepage returned HTTP 403 from Cloudflare');
      document.getElementById('clientName').value = 'Lovett & Associates';
      document.getElementById('clientURL').value  = 'https://www.lovettfinancial.com';
      recalc();
      const A = window.REPORT_ASSETS;
      return JSON.parse(JSON.stringify(buildReportDoc(assembleReport(),
        { logoWhite: A.logoWhite, logoPurple: A.logoPurple, coverBg: A.cover })));
    });
    check('the page built a document without throwing', errs.length === 0,
          errs.join(' | '));

    const asrc = fs.readFileSync(
      path.resolve(__dirname, '..', 'assets', 'report-assets.js'), 'utf8');
    const w = {}; new Function('window', asrc)(w);
    const A = w.REPORT_ASSETS;
    const fonts = {};
    Object.entries(A.fonts).forEach(([fam, st]) => {
      fonts[fam] = {};
      Object.entries(st).forEach(([k, f]) => {
        fonts[fam][k] = Buffer.from(A.vfs[f], 'base64');
      });
    });
    const printer = new (require('pdfmake'))(fonts);
    const buf = await new Promise((res, rej) => {
      const pdf = printer.createPdfKitDocument(doc);
      const cs = []; pdf.on('data', c => cs.push(c));
      pdf.on('error', rej); pdf.on('end', () => res(Buffer.concat(cs)));
      pdf.end();
    });
    const out = path.join(require('os').tmpdir(), 'blankpages-check.pdf');
    fs.writeFileSync(out, buf);
    const pages = JSON.parse(require('child_process').execFileSync('python3', ['-c', `
import pymupdf, json, re, sys
d = pymupdf.open(sys.argv[1])
rows = []
for p in d:
    t = p.get_text().strip()
    t = t.replace('For financial professional use only. Not for use with the public.', '')
    t = re.sub(r'Reviewed\\s*\\d{1,2}/\\d{1,2}/\\d{4}\\s*·\\s*Page\\s*\\d+', '', t)
    rows.append({'chars': len(''.join(t.split())), 'draw': len(p.get_drawings())})
print(json.dumps(rows))
`, out]).toString());
    fs.unlinkSync(out);

    console.log('   ' + pages.length + ' pages — ' +
      pages.map((p, i) => (i + 1) + ':' + p.chars).join('  '));
    const blank = pages.map((p, i) => ({ n: i + 1, p })).filter(x => x.p.chars === 0);
    check('not one page carries only the footer',
          blank.length === 0,
          blank.length ? 'blank: ' + blank.map(x => x.n).join(', ') : 'none');
    // The orphan had a shape of its own: ink, but not a word of text.
    check('and no page carries a drawing with no text beside it',
          !pages.some(p => p.chars === 0 && p.draw > 1));
  } catch (e) {
    console.log('  FAIL  threw: ' + e.message); failures++;
  } finally { if (browser) await browser.close(); }

  console.log();
  console.log(failures ? failures + ' check(s) failed' : 'all checks passed');
  process.exit(failures ? 1 : 0);
})();
