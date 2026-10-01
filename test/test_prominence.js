// A failing row is the reason the scorecard page exists, and in a column of
// fifteen it was one bold line among fourteen others. It now carries a tint and
// a magenta edge. Unmeasured gets its OWN amber treatment rather than sharing
// the failure one -- the whole point of that state is that it is not a failure,
// and washing both the same colour would undo the distinction the audit is
// built on.
//
// Read off the document definition: the question is which colours were emitted
// for which rows, and rendering a PDF to ask it is slower and less precise.
const path = require('path');
const PAGE = 'file://' + path.resolve(__dirname, '..', 'index.html');
const { chromium } = require('playwright');
let failures = 0;
const check = (l, c, d) => {
  console.log((c ? '  PASS  ' : '  FAIL  ') + l + (d ? '   → ' + d : ''));
  if (!c) failures++;
};

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await b.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(PAGE);

  const build = (fails, unknown) => page.evaluate(([f, u]) => {
    UNK.clear();
    document.querySelectorAll('.ci input').forEach(i => i.checked = true);
    f.forEach(id => { const e = document.getElementById(id); if (e) e.checked = false; });
    if (u) {
      document.getElementById(u).checked = false;
      UNK.set(u, 'homepage returned HTTP 403 from Cloudflare');
    }
    recalc();
    const d = assembleReport();
    const A = window.REPORT_ASSETS;
    const doc = buildReportDoc(d, { logoWhite: A.logoWhite, logoPurple: A.logoPurple, coverBg: A.cover });
    // Walk the content for the scorecard tables and ask their layout what
    // colour each row got -- the same call pdfmake makes when it draws them.
    const rows = [];
    const walk = n => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!n || typeof n !== 'object') return;
      if (n.table && n.layout && typeof n.layout.fillColor === 'function'
          && n.table.widths && n.table.widths.length === 3 && n.table.widths[0] === 12) {
        n.table.body.forEach((_, i) => rows.push({
          fill: n.layout.fillColor(i, n) || null,
          edge: n.layout.vLineColor ? n.layout.vLineColor(0, n, i) : null
        }));
      }
      Object.values(n).forEach(walk);
    };
    walk(doc.content);
    return {
      rows, json: JSON.stringify(doc.content),
      states: d.sections.flatMap(s => s.groups.flatMap(g => g.items.map(k => k.state)))
    };
  }, [fails, unknown]);

  console.log('\nA. a failing row is tinted and edged; a passing one is not');
  let r = await build(['c-gbp-r', 'c-szp', 'c-tag'], null);
  let paired = r.rows.map((x, i) => ({ ...x, state: r.states[i] }));
  const fails = paired.filter(x => x.state === 'fail');
  const passes = paired.filter(x => x.state === 'pass');
  check('found the failing rows', fails.length === 3, String(fails.length));
  check('every failing row is tinted', fails.every(x => x.fill === '#FBEEF5'),
        JSON.stringify([...new Set(fails.map(x => x.fill))]));
  check('every failing row has the magenta edge', fails.every(x => x.edge === '#87006E'),
        JSON.stringify([...new Set(fails.map(x => x.edge))]));
  check('passing rows are left plain', passes.every(x => !x.fill),
        String(passes.filter(x => x.fill).length) + ' tinted');
  check('and carry no coloured edge', passes.every(x => x.edge === '#FFFFFF'),
        JSON.stringify([...new Set(passes.map(x => x.edge))]));

  console.log('\nB. unmeasured is marked differently from failed');
  r = await build(['c-gbp-r'], 'c-mob');
  paired = r.rows.map((x, i) => ({ ...x, state: r.states[i] }));
  const unk = paired.filter(x => x.state === 'unknown');
  const fal = paired.filter(x => x.state === 'fail');
  check('found the unmeasured row', unk.length === 1, String(unk.length));
  check('it is amber, not magenta', unk[0] && unk[0].fill === '#FFFBEB', unk[0] && unk[0].fill);
  check('its edge is gold', unk[0] && unk[0].edge === '#FFC864', unk[0] && unk[0].edge);
  check('the two states never share a colour',
        unk[0] && fal[0] && unk[0].fill !== fal[0].fill && unk[0].edge !== fal[0].edge);

  console.log('\nC. the scorecard header is the title and the logo, nothing else');
  // The weight / KPIs-passed / need-work line was removed: the cover already
  // carries those figures, and the score and tinted rows repeat them on the
  // page itself. It must not creep back in, even when there is plenty to count.
  check('no "N need work" line on the scorecard pages', !/\d+ need work/.test(r.json),
        (r.json.match(/\d+ need work/) || ['absent'])[0]);
  check('no "% of overall score" line', !/% of overall score/.test(r.json));
  check('the magenta accent is still used for the rows', r.json.includes('#87006E'));

  console.log('\nD. nothing failing: no tint, and still no header stat line');
  r = await build([], null);
  check('no row is tinted', r.rows.every(x => !x.fill), String(r.rows.filter(x => x.fill).length));
  check('header stays clean', !/\d+ need work/.test(r.json) && !/% of overall score/.test(r.json));

  console.log('\nE. the cover lifts the needs-work figure out of the row');
  r = await build(['c-gbp-r', 'c-szp'], null);
  check('flagged in gold', r.json.includes('"need work"') && r.json.includes('#FFC864'));

  console.log('\nF. page health');
  check('zero page errors', errs.length === 0, errs.join(' | ') || 'none');
  await b.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})();
