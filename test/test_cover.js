// The cover is a fixed budget: the score block cannot be split, so every point
// of spacing above it has to come out of the room left below. It silently cost
// a sixth page once already, so the page count and the fit are pinned here.
const path=require('path'), fs=require('fs'), cp=require('child_process');
let failures=0;
const check=(l,c,d)=>{console.log((c?'  PASS  ':'  FAIL  ')+l+(d?'   → '+d:'')); if(!c) failures++;};

(async()=>{
  cp.execSync('node ' + path.join(__dirname,'render_cover.js'), { stdio:'pipe' });
  const pdf = path.join(__dirname,'cover.pdf');
  check('the PDF was built', fs.existsSync(pdf));

  const out = cp.execSync(`python3 -c "
import pymupdf, json
d=pymupdf.open('${pdf}')
r={'pages': d.page_count, 'ends': []}
for i in range(d.page_count):
    bs=[b for b in d[i].get_text('blocks')]
    r['ends'].append(round(max(b[3] for b in bs),1))
r['cover']=d[0].get_text()
print(json.dumps(r))
"`).toString();
  const r = JSON.parse(out);

  console.log('\nA. still five pages — the cover has not spilled');
  check('five pages', r.pages===5, String(r.pages));

  console.log('\nB. the cover fills the sheet instead of stopping short');
  // 734 is the usable height (792 less the 58pt bottom margin). Ending much
  // above that is the dead band this spacing exists to remove.
  check('reaches the foot of the page', r.ends[0] > 690, r.ends[0]+' of 734');
  check('does not overrun it', r.ends[0] <= 734, r.ends[0]+' of 734');

  console.log('\nC. the cover still says everything it must');
  // The SUMMARY chip is letter-spaced, so it extracts as "S U M M A RY".
  // Comparing with spaces stripped tests the words, not the tracking.
  const flat = r.cover.replace(/\s+/g,'');
  check('contains "SUMMARY"', flat.includes('SUMMARY'));
  for (const t of ['Digital Audit','OVERALL DIGITAL SCORE','On track',
                   'KPIs passed','AEO KPIs passed','Company Visibility',
                   'Website Performance','Social Media','For financial professional use only'])
    check('contains "'+t+'"', r.cover.includes(t));

  console.log('\nD. the background is scaled by height only, so nothing is squeezed');
  const src = fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
  check('no forced width+height on the cover image',
        !/image: 'cover', width: PAGE_W, height: 792/.test(src));
  check('width derives from the real aspect ratio', /COVER_ASPECT = 1920 \/ 1080/.test(src));
  check('and is offset rather than stretched', /absolutePosition: \{ x: COVER_X/.test(src));

  console.log('\nE. the roadmap CTA is complete on all three scorecard pages');
  // It renders as a gold rule, the copy, and the button. A build that showed
  // the rule and the button with nothing between them is what prompted this,
  // so all three parts are checked on each page rather than just the button.
  const cta = JSON.parse(cp.execSync(`python3 -c "
import pymupdf, json
d = pymupdf.open('${pdf}')
print(json.dumps([d[i].get_text() for i in (2,3,4)]))
"`).toString());
  const COPY = 'Add and follow the Implement GrowthLine Audit Recommendations roadmap in Growth360.';
  cta.forEach((t, i) => {
    const flat = t.replace(/\s+/g,'');
    check('page '+(i+3)+' has the roadmap copy', flat.includes(COPY.replace(/\s+/g,'')));
    check('page '+(i+3)+' has the button', flat.includes('LaunchRoadmap'));
  });

  console.log('\nF. the projection band holds three digits without wrapping');
  // 26pt columns wrapped "100" into "10" above a lone "0". Rendered at the
  // worst case -- a firm at 99 projected to 100 -- and read as laid-out lines,
  // because a wrap still extracts the right characters and only the geometry
  // shows the fault.
  cp.execSync('node ' + path.join(__dirname,'render_cover.js'),
              { stdio:'pipe', env: Object.assign({}, process.env, { BAND_MAX:'1' }) });
  const bandPdf = path.join(__dirname,'band.pdf');
  const band = JSON.parse(cp.execSync(`python3 -c "
import pymupdf, json
d = pymupdf.open('${bandPdf}')
out = []
for blk in d[1].get_text('dict')['blocks']:
    for ln in blk.get('lines', []):
        txt = ''.join(sp['text'] for sp in ln['spans']).strip()
        size = max([sp['size'] for sp in ln['spans']] or [0])
        if txt: out.append({'t': txt, 'size': round(size,1), 'y': round(ln['bbox'][1],1)})
print(json.dumps(out))
"`).toString());
  // The band's two figures are the only 19pt text on the page.
  const big = band.filter(l => l.size > 17 && l.size < 21);
  check('both band figures are present', big.length === 2,
        JSON.stringify(big.map(l => l.t)));
  check('they read 99 and 100, whole and unwrapped',
        big.map(l => l.t).join(',') === '99,100', JSON.stringify(big.map(l => l.t)));
  check('they sit on the same line', big.length === 2 && big[0].y === big[1].y,
        JSON.stringify(big.map(l => l.y)));
  check('no stray single digit was orphaned',
        !band.some(l => l.size > 17 && l.size < 21 && /^\d$/.test(l.t)));
  // And the page count must survive the widened band.
  const bp = cp.execSync(`python3 -c "
import pymupdf
print(pymupdf.open('${bandPdf}').page_count)
"`).toString().trim();
  check('still five pages at the worst case', bp === '5', bp);

  console.log('\nG. the cover is a fixed grid, and a long summary cannot move it');
  // The cover used to be a stack of margins. A summary two lines over pushed the
  // unbreakable score block onto page 2, where white text on a white page read as
  // erased -- shipped twice. Every block now sits at a hard-coded y, so this reads
  // those numbers out of the source and checks the PDF put the ink exactly there,
  // both for the sample and for a summary far longer than it.
  const srcY = fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8')
                 .match(/const COVER_Y = \{([\s\S]*?)\};/);
  check('COVER_Y is declared in one place', !!srcY);
  const Y = {};
  (srcY ? srcY[1] : '').replace(/(\w+)\s*:\s*(\d+)/g, (_, k, v) => { Y[k] = +v; });
  check('it names every block', Object.keys(Y).length === 11, Object.keys(Y).join(','));

  cp.execSync('node ' + path.join(__dirname,'render_cover.js'),
              { stdio:'pipe', env: Object.assign({}, process.env, { COVER_STRESS:'1' }) });

  const linesOf = f => JSON.parse(cp.execSync(`python3 -c "
import pymupdf, json
d = pymupdf.open('${path.join(__dirname, f)}')
out = []
for blk in d[0].get_text('dict')['blocks']:
    for ln in blk.get('lines', []):
        t = ''.join(sp['text'] for sp in ln['spans']).strip()
        if t: out.append({'t': t, 'y': round(ln['bbox'][1],1), 'b': round(ln['bbox'][3],1)})
print(json.dumps({'lines': out, 'pages': d.page_count}))
"`).toString());

  // Each block identified by text only it carries.
  const MARK = [
    ['title',    /^Digital Audit$/],
    ['meta',     /Reviewed \d\d\/\d\d\/\d{4}/],
    ['summary',  /^Your firm is performing/],
    ['scoreLbl', /^OVERALL DIGITAL SCORE/],
    ['band',     /^On track$/],
    ['stats',    /^\d+ of \d+$/],
    ['channels', /^Company Visibility$/],
    ['foot',     /^For financial professional/]
  ];

  for (const [label, file, extra] of [['sample','cover.pdf',[]],
                                      ['long summary','cover-stress.pdf',[['delta',/^Up \d+ points/]]]]) {
    const r = linesOf(file);
    check(`${label}: still five pages`, r.pages === 5, String(r.pages));
    for (const [key, re] of MARK.concat(extra)) {
      const hit = r.lines.find(l => re.test(l.t));
      // 1pt of tolerance: pymupdf reports the glyph box, not the layout box.
      check(`${label}: ${key} sits at its declared y (${Y[key]})`,
            hit && Math.abs(hit.y - Y[key]) <= 1, hit ? String(hit.y) : 'MISSING');
    }
    // The one thing a long summary could still do is run into the score label.
    const sum = r.lines.filter(l => l.y >= Y.summary && l.y < Y.scoreLbl);
    const last = sum.length ? Math.max(...sum.map(l => l.b)) : 0;
    check(`${label}: the summary stays inside its box`, last < Y.scoreLbl,
          last + ' vs ' + Y.scoreLbl);
  }

  console.log(failures?`\n${failures} FAILURE(S)`:'\nall checks passed');
  process.exit(failures?1:0);
})();
