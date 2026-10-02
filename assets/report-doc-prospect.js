// ── The prospect report ─────────────────────────────────────────────────────
// A second document, not a restyle of the first.
//
// The GrowthLine report carries "For financial professional use only. Not for
// use with the public." in its footer. A prospect running their own audit is
// exactly the public, so that document cannot be handed to them whatever it
// looks like. The disclosure below is a PLACEHOLDER awaiting Cetera
// compliance, and this template refuses to render as final until it is
// replaced -- see DISCLOSURE and draft mode at the bottom.
//
// SHAPE: same signature as the GrowthLine document, buildReportDoc(d, assets),
// returning a pdfmake document definition. render.js picks between them by the
// audit record's `template`, so nothing else has to know which one ran.
//
// FOR WHOEVER DESIGNS THIS: everything you can change without touching data is
// in LAYOUT and PALETTE at the top. Everything below reads the audit; the
// field names are fixed by what the app measures, and reference/
// REPORT_DESIGN_BRIEF.md lists all of them with real values.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.REPORT_DOC_PROSPECT = api;
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

// ── Everything a designer changes ───────────────────────────────────────────
const PALETTE = {
  ink:      '#1F2A33',   // body text
  inkSoft:  '#5A6672',   // secondary text
  rule:     '#D8DEE4',   // hairlines
  pass:     '#2E7D52',
  fail:     '#B3261E',
  unknown:  '#8A6D1F',   // NOT a fail -- see the three states below
  accentBg: '#37006E',
  onAccent: '#FFFFFF',
  tint:     '#F4F2F8'
};

const LAYOUT = {
  pageSize: 'LETTER',            // 612 x 792 pt
  margin:   48,
  gutter:   16,
  type: {
    pageTitle:  { font: 'Display', size: 26, bold: true },
    sectionTtl: { font: 'Display', size: 17, bold: true },
    scoreBig:   { font: 'Display', size: 44, bold: true },
    lead:       { font: 'Body',    size: 11 },
    body:       { font: 'Body',    size: 9.5 },
    small:      { font: 'Body',    size: 8 },
    footer:     { font: 'Body',    size: 7 }
  }
};

const PAGE_W = 612;
const CONTENT = PAGE_W - LAYOUT.margin * 2;

// ── The disclosure ──────────────────────────────────────────────────────────
// Deliberately not written here. Nobody on this side of the work is qualified
// to write a compliance line for a document going to the public, and an
// invented one that looks plausible is worse than an obvious placeholder.
const DISCLOSURE_PENDING = true;
const DISCLOSURE = 'DRAFT — disclosure pending compliance review. Not for distribution.';

// ── Helpers ─────────────────────────────────────────────────────────────────
const t = (text, style, extra) => Object.assign(
  { text, font: LAYOUT.type[style].font, fontSize: LAYOUT.type[style].size,
    bold: !!LAYOUT.type[style].bold, color: PALETTE.ink }, extra || {});

const em = v => (v === null || v === undefined || v === '') ? '—' : String(v);

const rule = (gap) => ({
  canvas: [{ type: 'line', x1: 0, y1: 0, x2: CONTENT, y2: 0,
             lineWidth: 0.5, lineColor: PALETTE.rule }],
  margin: [0, gap == null ? 10 : gap, 0, 8] });

// THREE states, never two. A check the audit could not measure is not a
// failure, and a design that offers only a tick and a cross forces it to be
// drawn as one. `note` carries why it could not be measured, and a prospect
// report has MORE of these than an internal one -- the browser extension that
// defeats a Cloudflare-fronted site needs a person, and a prospect run has
// nobody. Showing them honestly is the whole credibility of the document.
const MARK = {
  pass:    { glyph: '✓', color: PALETTE.pass,    label: 'Yes' },
  fail:    { glyph: '✗', color: PALETTE.fail,    label: 'No' },
  unknown: { glyph: '?',      color: PALETTE.unknown, label: 'Not measured' }
};
const markFor = state => MARK[state] || MARK.unknown;

// ── Page 1 · cover ──────────────────────────────────────────────────────────
function cover(d, assets) {
  const s = d.scores || {};
  return [
    { svg: assets.logoPurple, width: 150, margin: [0, 0, 0, 28] },
    t('Digital Audit', 'pageTitle'),
    t([d.firm, d.url, 'Reviewed ' + d.reviewed].filter(Boolean).join('   ·   '),
      'small', { color: PALETTE.inkSoft, margin: [0, 6, 0, 0] }),
    rule(22),
    d.summary ? t(d.summary, 'lead', { margin: [0, 0, 0, 24] }) : {},
    {
      columns: [
        { width: 140, stack: [
          t(em(s.overall), 'scoreBig', { color: PALETTE.accentBg }),
          t(em(s.band), 'body', { color: PALETTE.inkSoft })
        ]},
        { width: '*', stack: [
          t(em(d.kpiPassed) + ' checks passed', 'body'),
          t(em(d.needWork) + ' need work', 'body', { margin: [0, 3, 0, 0] }),
          t(em(d.aeoPassed) + ' answer-engine checks passed', 'body', { margin: [0, 3, 0, 0] })
        ]}
      ], columnGap: LAYOUT.gutter
    },
    rule(24),
    // The three category scores. Weights are in the data so a design can show
    // them or not, but the numbers must not be invented.
    { columns: (d.sections || []).map(sec => ({
        width: '*', stack: [
          t(sec.name, 'small', { color: PALETTE.inkSoft }),
          t(em(sec.score), 'sectionTtl', { margin: [0, 2, 0, 0] }),
          t(sec.passed + ' of ' + sec.total, 'small', { color: PALETTE.inkSoft })
        ]})), columnGap: LAYOUT.gutter }
  ];
}

// ── Page 2 · what to do first ───────────────────────────────────────────────
// `actions` is pre-filtered to checks with APPROVED copy. A failed check with
// no approved wording is deliberately absent rather than written up in the
// tool's own words -- do not fill the gap with generated text.
function priorities(d) {
  const rows = (d.actions || []).map((a, i) => ([
    t(String(i + 1), 'sectionTtl', { color: PALETTE.accentBg, alignment: 'center' }),
    { stack: [
        t(a.title, 'body', { bold: true }),
        t(a.q, 'small', { color: PALETTE.inkSoft, margin: [0, 2, 0, 4] }),
        t(a.why, 'body'),
        t([a.cat, a.effort, a.aeo ? 'Answer-engine signal' : null]
            .filter(Boolean).join('   ·   '),
          'small', { color: PALETTE.inkSoft, margin: [0, 4, 0, 0] })
    ]}
  ]));

  return [
    t('Where to start', 'sectionTtl'),
    rows.length
      ? { table: { widths: [26, '*'], body: rows }, layout: lineLayout(), margin: [0, 12, 0, 0] }
      // Two different things leave this empty and they are not the same news.
      : t(d.failedCount
            ? 'Nothing is listed here yet — approved wording for the remaining items is ' +
              'still being prepared.'
            : 'Nothing needs attention.',
          'body', { margin: [0, 12, 0, 0] }),
    (d.projected != null && d.actions && d.actions.length)
      ? t('Addressing these would put the score at about ' + d.projected +
          ' (' + em(d.projectedBand) + ').', 'small',
          { color: PALETTE.inkSoft, margin: [0, 14, 0, 0] })
      : {}
  ];
}

// ── Pages 3-5 · one per category ────────────────────────────────────────────
function scorecard(sec) {
  const tiles = (sec.tiles || []).map(x => ({
    width: '*', stack: [
      t(x.label, 'small', { color: PALETTE.inkSoft }),
      t(em(x.value) + (x.value != null && x.unit ? ' ' + x.unit : ''),
        'sectionTtl', { margin: [0, 2, 0, 0],
          color: x.ok === true ? PALETTE.pass : x.ok === false ? PALETTE.fail : PALETTE.ink }),
      x.good ? t(x.good, 'small', { color: PALETTE.inkSoft }) : {}
    ]}));

  const groups = (sec.groups || []).map(g => ([
    t(g.name, 'body', { bold: true, margin: [0, 12, 0, 6] }),
    { table: { widths: [14, '*'], body: g.items.map(it => {
        const m = markFor(it.state);
        return [
          t(m.glyph, 'body', { color: m.color, alignment: 'center' }),
          { stack: [
              t(it.q, 'body'),
              // The reason it could not be measured. Printing the question with
              // no answer and no explanation is what makes an audit look broken.
              it.note ? t(it.note, 'small', { color: PALETTE.unknown, margin: [0, 2, 0, 0] }) : {},
              it.aeo ? t('Answer-engine signal', 'small', { color: PALETTE.inkSoft }) : {}
          ]}
        ];
      })}, layout: lineLayout() }
  ])).flat();

  return [
    { columns: [
        { width: '*', stack: [ t(sec.name, 'sectionTtl'),
            sec.blurb ? t(sec.blurb, 'small', { color: PALETTE.inkSoft, margin: [0, 4, 0, 0] }) : {} ]},
        { width: 90, stack: [
            t(em(sec.score), 'scoreBig', { alignment: 'right', color: PALETTE.accentBg }),
            t(em(sec.band), 'small', { alignment: 'right', color: PALETTE.inkSoft }) ]}
      ], columnGap: LAYOUT.gutter },
    sec.intro ? t(sec.intro, 'body', { margin: [0, 10, 0, 0] }) : {},
    rule(14),
    { columns: tiles, columnGap: LAYOUT.gutter },
    ...groups
  ];
}

function lineLayout() {
  return {
    hLineWidth: (i, node) => (i === 0 || i === node.table.body.length) ? 0 : 0.5,
    vLineWidth: () => 0,
    hLineColor: () => PALETTE.rule,
    paddingTop: () => 5, paddingBottom: () => 5,
    paddingLeft: () => 0, paddingRight: () => 6
  };
}

// ── The document ────────────────────────────────────────────────────────────
function buildReportDoc(d, assets) {
  const content = [];
  content.push(...cover(d, assets));
  content.push({ text: '', pageBreak: 'after' });
  content.push(...priorities(d));
  (d.sections || []).forEach(sec => {
    content.push({ text: '', pageBreak: 'before' });
    content.push(...scorecard(sec));
  });

  return {
    pageSize: LAYOUT.pageSize,
    pageOrientation: 'portrait',
    pageMargins: [LAYOUT.margin, LAYOUT.margin, LAYOUT.margin, 54],
    info: { title: 'Digital Audit — ' + (d.firm || 'Client'), author: 'Story Amplify' },
    // Visible on every page until compliance supplies the real line. A draft
    // that does not look like a draft is the one that gets emailed by mistake.
    watermark: DISCLOSURE_PENDING
      ? { text: 'DRAFT', color: PALETTE.accentBg, opacity: 0.06, bold: true }
      : undefined,
    footer: page => ({
      columns: [
        t(DISCLOSURE, 'footer', { color: PALETTE.inkSoft }),
        t('Page ' + page, 'footer', { color: PALETTE.inkSoft, alignment: 'right' })
      ], margin: [LAYOUT.margin, 8, LAYOUT.margin, 0] }),
    content,
    defaultStyle: { font: 'Body', fontSize: LAYOUT.type.body.size, color: PALETTE.ink }
  };
}

return { buildReportDoc, PALETTE, LAYOUT, MARK, DISCLOSURE, DISCLOSURE_PENDING };
});
