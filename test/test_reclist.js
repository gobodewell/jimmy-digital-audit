// The reference document: every recommendation the audit can make.
//
// A client report carries at most TOP_N of them, which is right for the client
// and useless for anyone reviewing the wording or asking what the tool
// actually tells people to do. tools/recommendations-pdf.js prints all forty.
//
// The one way that document could do real harm is by drifting: a second copy
// of the recommendation prose, edited once and then slowly diverging from what
// a client is handed, with nothing to reveal the gap. So it holds no copy of
// its own -- every title and paragraph is read through gtextFor, the same
// lookup report-doc.js uses -- and this test fails if any of that wording ever
// appears in the tool's own source.
const path = require('path'), fs = require('fs');
const RD = require('../assets/report-doc.js');
const TOOL = path.join(__dirname, '..', 'tools', 'recommendations-pdf.js');
const T = require(TOOL);

let failures = 0;
const check = (l, c, d) => {
  console.log((c ? '  PASS  ' : '  FAIL  ') + l + (d ? '   → ' + d : ''));
  if (!c) failures++;
};
const flat = s => String(s).replace(/\s+/g, ' ').trim();

(async () => {
  console.log('\nA. it holds no copy of its own');
  const src = fs.readFileSync(TOOL, 'utf8');
  const ALL = Object.assign({}, RD.GTEXT_DRAFT, RD.GTEXT);
  const pasted = Object.keys(ALL).filter(id =>
    src.includes(ALL[id].title) || src.includes(flat(ALL[id].text).slice(0, 60)));
  check('no recommendation wording is pasted into the tool',
        pasted.length === 0, pasted.join(', '));
  check('it reads the copy through the report\'s own lookup',
        /gtextFor\(c\.id\)/.test(src));
  check('and the five habits from the report\'s own list',
        /KEEP_GOING/.test(src) && !RD.KEEP_GOING.some(k => src.includes(k.title)));

  console.log('\nB. the document covers everything');
  const data = await T.readChecks();
  check('it read all forty checks out of the page',
        data.checks.length === 40, String(data.checks.length));
  const doc = T.build(data, T.assets());
  const text = flat(JSON.stringify(doc.content));

  const ids = Object.keys(ALL);
  const missT = ids.filter(id => !text.includes(flat(ALL[id].title)));
  const missB = ids.filter(id => !text.includes(flat(ALL[id].text)));
  check('every recommendation title is in it', missT.length === 0, missT.join(', '));
  check('and every paragraph, in full', missB.length === 0, missB.join(', '));
  check('every check question is in it, so a row can be traced to its box',
        data.checks.every(c => text.includes(flat(c.q))),
        data.checks.filter(c => !text.includes(flat(c.q))).map(c => c.id).join(', '));

  console.log('\nC. the five that are not checks are marked as such');
  check('all five are there',
        RD.KEEP_GOING.every(k => text.includes(flat(k.text))));
  check('each is labelled Not scored, so it cannot be read as a failed check',
        (text.match(/Not scored/g) || []).length === RD.KEEP_GOING.length,
        String((text.match(/Not scored/g) || []).length));
  check('and the page says when a client would see them',
        /fewer than five checks failed/.test(text));

  console.log('\nD. draft wording is visible as draft');
  // 30 of the 40 come from the approved sheet; the rest are drafts standing in
  // until their wording lands. Anyone reviewing this document needs to know
  // which is which -- that is most of why it exists.
  const drafts = data.checks.filter(c => !RD.GTEXT[c.id] && RD.gtextFor(c.id));
  check('the document marks each draft row',
        (text.match(/Draft wording/g) || []).length === drafts.length,
        (text.match(/Draft wording/g) || []).length + ' marks for ' + drafts.length + ' drafts');
  check('and does not mark an approved row as draft',
        (text.match(/Draft wording/g) || []).length < ids.length);

  console.log('\nE. no row can be cut in half');
  // The report had exactly this bug: a recommendation split across the fold,
  // half a sentence opening a page. Every table here moves a row whole.
  // Only the tables that hold a LIST of rows. ctaBar's gold button is a
  // one-cell table and is held together by `unbreakable` instead.
  const multi = doc.content.filter(e => e && e.table && e.table.body &&
                                   e.table.body.length > 1);
  check('every table of rows forbids splitting one',
        multi.length > 0 && multi.every(e => e.table.dontBreakRows === true),
        multi.filter(e => !e.table.dontBreakRows).length + ' of ' + multi.length + ' unprotected');

  console.log();
  console.log(failures ? failures + ' check(s) failed' : 'all checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.log('  FAIL  threw: ' + e.message); process.exit(1); });
