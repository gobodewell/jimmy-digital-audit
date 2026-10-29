// Letters instead of numbers, on the PDF only.
//
// Three things have to hold at once, and the third is the one that is easy to
// lose:
//
//   1. The bands are the client's: A 90-100, B 80-89, C 70-79, D 0-69.
//   2. The app keeps its numbers. A reviewer ticking a box needs to see 84
//      become 86; a letter that sits still for ten points makes the tool feel
//      broken to the one person who uses it all day.
//   3. The projection still gives a reason to act. "Completing all five keeps
//      this firm at B" is true and motivates nobody, and a letters-only report
//      can say nothing else -- which is why the near miss is tested here by
//      name, on a fixture that really lands one point short of an A.
const path = require('path');
const fs = require('fs');
const RD = require('../assets/report-doc.js');
const { chromium } = require('playwright');

let failures = 0;
const check = (l, c, d) => {
  console.log((c ? '  PASS  ' : '  FAIL  ') + l + (d ? '   → ' + d : ''));
  if (!c) failures++;
};

(async () => {
  console.log('\nA. the bands are the ones that were asked for');
  for (const [n, g] of [[100,'A'],[90,'A'],[89,'B'],[80,'B'],[79,'C'],[70,'C'],[69,'D'],[0,'D']])
    check(n + ' → ' + g, RD.gradeFor(n) === g, RD.gradeFor(n));
  check('nothing is above A', RD.toNextGrade(95) === null, String(RD.toNextGrade(95)));
  check('89 is one point short of an A', RD.toNextGrade(89) === 1, String(RD.toNextGrade(89)));
  check('and 84 is six', RD.toNextGrade(84) === 6, String(RD.toNextGrade(84)));

  console.log('\nB. one definition of the bands, not two');
  // airtable.js had grade bands first, for the score columns it pushes. A
  // second copy here would drift, and a client reading B on the report beside
  // an Airtable row saying A is the kind of thing nobody catches.
  // Asked of the behaviour, not of the source. The first version of this check
  // grepped airtable.js for "90:A" and failed on the example inside its own
  // error message -- a test reporting a defect that was a string in a sentence.
  const AT = require('../airtable.js');
  const atGrade = AT.makeFormatter('grade', '');   // no env spec set
  const disagree = [100, 95, 90, 89, 85, 80, 79, 75, 70, 69, 40, 0]
    .filter(n => atGrade(n) !== RD.gradeFor(n));
  check('with no env spec, Airtable grades exactly as the report does',
        disagree.length === 0,
        disagree.map(n => n + ': at=' + atGrade(n) + ' pdf=' + RD.gradeFor(n)).join(', '));
  // The env var still wins, because a client who wants different columns in
  // their own base is allowed to have them.
  check('an explicit AIRTABLE_GRADE_BANDS still overrides it',
        AT.makeFormatter('grade', '50:PASS,0:FAIL')(60) === 'PASS',
        AT.makeFormatter('grade', '50:PASS,0:FAIL')(60));
  check('and a malformed spec is still refused rather than guessed at',
        (() => { try { AT.makeFormatter('grade', 'nonsense'); return false; }
                 catch (e) { return /malformed/.test(e.message); } })());

  console.log('\nC. the app is left alone');
  const page = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  check('the page never asks for grade mode', !/scoreStyle/.test(page));
  // Grades ship as the default now. The app is unaffected because it never
  // builds this document to display a score -- it reads its own numbers off
  // the scoring engine, which is why the check above matters more than ever.
  check('grades are the default for a report',
        RD.SCORE_STYLE_DEFAULT === 'grade' && RD.graded({}) === true &&
        RD.showScore({}, 84) === 'B', RD.showScore({}, 84));
  check('and numbers are still reachable, for a caller that asks',
        RD.graded({ scoreStyle: 'number' }) === false &&
        RD.showScore({ scoreStyle: 'number' }, 84) === '84',
        RD.showScore({ scoreStyle: 'number' }, 84));

  // ── rendered ───────────────────────────────────────────────────────────────
  const b = await chromium.launch({ executablePath: require('../chromium-path.js')() });
  const p = await b.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('file://' + path.resolve(__dirname, '..', 'index.html'));

  // light:true fails the lowest-impact checks first, which is what produces a
  // near miss rather than a clean crossing.
  const build = (k, style) => p.evaluate(o => {
    UNK.clear();
    document.querySelectorAll('.ci input').forEach(i => i.checked = true);
    CHECKS.filter(c => gtextFor(c.id)).slice().sort((a, b) => a.pts - b.pts)
      .slice(0, o.k).forEach(c => { document.getElementById(c.id).checked = false; });
    recalc();
    const d = assembleReport();
    if (o.style) d.scoreStyle = o.style;
    const A = window.REPORT_ASSETS;
    const doc = buildReportDoc(d, { logoWhite: A.logoWhite, logoPurple: A.logoPurple, coverBg: A.cover });
    return { json: JSON.stringify(doc.content), overall: d.scores.overall,
             projected: d.projected, n: d.actions.length };
  }, { k, style });

  console.log('\nD. grade mode takes the digits off the cover');
  let r = await build(23, 'grade');
  check('the fixture is the crossing case', r.overall === 84 && r.projected === 90,
        r.overall + ' → ' + r.projected);
  check('no "n OF 100" label', !/OF 100/.test(r.json));
  check('the label says GRADE', /OVERALL DIGITAL GRADE/.test(r.json));
  check('and the KPI tally survives, because a count is not a score',
        /of 40/.test(r.json));

  console.log('\nE. the three projection sentences');
  check('crossing says so plainly',
        /moves this firm from .{0,60}B.{0,80}into the .{0,60}A/.test(r.json),
        'B → A');
  r = await build(24, 'grade');
  check('the near-miss fixture really is one point short',
        r.overall === 83 && r.projected === 89, r.overall + ' → ' + r.projected);
  check('it does NOT say the firm merely stays put',
        !/keeps this firm at/.test(r.json));
  check('it names the gap instead, with a reason to act',
        /top of the .{0,60}B.{0,40}band/.test(r.json) &&
        /1 point.{0,60}short of/.test(r.json),
        'top of B, 1 point short of A');
  check('and "1 point" is singular',
        !/1 points/.test(r.json), 'found "1 points"');

  console.log('\nF. a firm already at the top grade gets no band at all');
  // It used to print "adds 4 points, holding this firm at A" beside an arrow
  // pointing nowhere -- movement promised to a firm with nowhere left to move.
  r = await build(2, 'grade');
  check('the fixture really is at the top with room to gain',
        RD.gradeFor(r.overall) === 'A' && r.projected > r.overall,
        r.overall + ' → ' + r.projected);
  check('no projection band is printed',
        !/Completing/.test(r.json));
  check('and the five recommendations still are',
        /Do these|Do this one/.test(r.json));
  check('number mode keeps its band, because a number can still go up',
        /Completing/.test((await build(2, 'number')).json));

  console.log('\nG. but climbing INTO A still shows the band');
  // The first version of the suppression asked only whether anything sat above
  // the projection. Everything reaching A answers no -- so it deleted the
  // B -> A story the grades exist to tell. Caught in a render, not in the
  // arithmetic, which is why the fixture is pinned here by its numbers.
  r = await build(23, 'grade');
  check('84 → 90 is a crossing that lands on the top grade',
        r.overall === 84 && r.projected === 90 &&
        RD.gradeFor(r.projected) === 'A', r.overall + ' → ' + r.projected);
  check('the band is printed', /Completing/.test(r.json));
  check('and it says B into A', /from .{0,60}B.{0,80}into the .{0,60}A/.test(r.json));

  console.log('\nH. every letter sits on a filled box, inverted on the cover');
  r = await build(23, 'grade');
  const cover = r.json.slice(0, r.json.indexOf('Do these'));
  const rest  = r.json.slice(r.json.indexOf('Do these'));
  check('the cover badges are white, so they read on a purple field',
        new RegExp('"r":3,"color":"' + RD.RC.white + '"').test(cover));
  check('with the letter in purple',
        new RegExp('"color":"' + RD.RC.purple + '"').test(cover));
  check('all four of them — the overall and the three channels',
        (cover.match(/"r":3/g) || []).length === 4,
        String((cover.match(/"r":3/g) || []).length));
  check('the open ring is gone in grade mode', !/"ellipse"/.test(cover));
  check('but number mode still has it',
        /"ellipse"/.test((await build(23, 'number')).json));
  check('the scorecards and band badges are purple with a white letter',
        new RegExp('"r":3,"color":"' + RD.RC.purple + '"').test(rest));
  check('and a scorecard letter is a quarter larger than the number was',
        /"fontSize":50/.test(rest), '40 → 50');

  console.log('\nH2. the letter is centred in its box — measured off a render');
  // Asserted against pixels, not against a formula. The first version of this
  // test modelled the geometry itself, got the model wrong, and reported three
  // failures on output that a render showed was centred to within half a point.
  // A test that recomputes the thing it is checking only ever tests itself.
  //
  // The lift was originally set from the cap height and left the letter 11pt
  // low in a 68pt box: 25.7pt of air above it and 3.5 below. pdfmake positions
  // the text BLOCK, whose top is the ascent line, so centring the ink means
  // clearing the ascent-to-cap gap too.
  {
    const cp = require('child_process');
    const os = require('os');
    const { renderReport } = require('../render.js');
    const d = await p.evaluate(() => {
      UNK.clear();
      document.querySelectorAll('.ci input').forEach(i => i.checked = true);
      CHECKS.filter(c => gtextFor(c.id)).slice().sort((a, b) => a.pts - b.pts)
        .slice(0, 23).forEach(c => { document.getElementById(c.id).checked = false; });
      recalc();
      const r = assembleReport(); r.scoreStyle = 'grade'; return r;
    });
    const out = path.join(os.tmpdir(), 'grades-centring.pdf');
    fs.writeFileSync(out, await renderReport(d, { template: 'growthline' }));
    const probe = (page, white) => JSON.parse(cp.execSync(`python3 -c "
import pymupdf, json, sys
d = pymupdf.open(sys.argv[1]); pg = d[${page}]
c = [x['rect'] for x in pg.get_drawings() if x.get('fill')
     and 0.85 < x['rect'].width / max(x['rect'].height, 1) < 1.05
     and x['rect'].width > 30]
r = max(c, key=lambda v: v.width)
Z = 8
pm = pg.get_pixmap(dpi=72*Z, clip=pymupdf.Rect(r.x0+1.2, r.y0+1.2, r.x1-1.2, r.y1-1.2))
W, H, n, s = pm.width, pm.height, pm.n, pm.samples
xs = []; ys = []
for y in range(H):
  for x in range(W):
    i = (y*W+x)*n; px = (s[i], s[i+1], s[i+2])
    ink = all(v > 170 for v in px) if ${white ? 'True' : 'False'} else (px[0] < 120 and px[2] < 170)
    if ink: xs.append(x); ys.append(y)
print(json.dumps({'w': r.width, 'h': r.height,
  'dx': ((W-1-max(xs)) - min(xs))/2/Z, 'dy': ((H-1-max(ys)) - min(ys))/2/Z}))
" ${JSON.stringify(out)}`).toString());

    for (const [label, page, white] of [['scorecard, purple box', 2, true],
                                        ['cover, white box', 0, false]]) {
      const m = probe(page, white);
      check('  ' + label + ' (' + Math.round(m.w) + 'x' + Math.round(m.h) + '): ' +
            'horizontally centred', Math.abs(m.dx) <= 1, m.dx.toFixed(2) + 'pt out');
      check('  ' + label + ': vertically centred',
            Math.abs(m.dy) <= 1, m.dy.toFixed(2) + 'pt out');
    }
    fs.unlinkSync(out);
  }

  console.log('\nI. number mode is still reachable and untouched');
  r = await build(23, 'number');
  check('the cover still carries the score out of 100', /OF 100/.test(r.json));
  check('no letters stand in for it', !/OVERALL DIGITAL GRADE/.test(r.json));
  check('and the old band wording is still there',
        /moves this firm from|adds .{0,30}point/.test(r.json));

  check('zero page errors', errs.length === 0, errs.join(' | ') || 'none');
  await b.close();
  console.log();
  console.log(failures ? failures + ' check(s) failed' : 'all checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.log('  FAIL  threw: ' + e.message); process.exit(1); });
