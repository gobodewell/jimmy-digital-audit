// ── The report document ───────────────────────────────────────
// Lifted out of index.html unchanged, because the browser is no longer the
// only thing that builds a report. An audit filed from the public page or run
// from Airtable has nobody sitting in front of it, so the proxy has to render
// the same document from the same code -- two renderers would drift, and the
// one nobody watches would be the one that drifted.
//
// It takes the report's DATA and returns a pdfmake document definition. It
// touches no DOM and reads no globals, which is what made the move possible:
// assembleReport() does the DOM reading and stays in the page.
//
// Loads in both places. The browser gets window.REPORT_DOC; node gets the same
// object from require().
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.REPORT_DOC = api;
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

// ── The GrowthLine by Cetera audit report ────────────────────────────────────
// Builds the pdfmake document definition from one audit. Pure: give it the
// same data twice and it produces the same five pages. Every value it prints
// comes from `d` -- nothing is fetched, inferred or written here.
//
// Tokens are the Cetera design system's, named as it names them.
// The booking link on the report's call to action. The month parameter Calendly
// puts in a shared URL pins the calendar to that month — harmless when it is
// the current one, an empty grid a year later — so it is left off.
const CTA_LINK = 'https://calendly.com/growthline/30min';
const ROADMAP_LINK = 'https://growth360.actifi.com/auth/wall?relayState=GrowthLineRecommendations';

// The banner both calls to action are built from: a gold rule, the copy, and a
// gold button. Heading is optional — the roadmap banner on the scorecard pages
// is one line and does not need one. Every piece carries the link, so a reader
// who clicks the words rather than the button still gets there.
// The banner both calls to action are built from: a gold rule, the copy, and a
// gold button.
//
// The headingless variant -- the roadmap bar on the three scorecard pages --
// set its copy at 8.8pt, which left one thin grey line of type beside a bold
// button twice its size, with the rule running past both. It read as a button
// with a caption rather than a call to action. The copy now matches the
// button's weight, and the rule is sized to the block instead of a fixed 38pt.
function ctaBar(link, heading, body, button, gap) {
  const bodySize = heading ? 8.8 : 10.5;
  // Two lines of copy at 10.5pt, or the heading stack, decide the height.
  const ruleH    = heading ? 52 : 44;
  return { columns: [
      { width: 4, canvas: [{ type: 'rect', x: 0, y: 0, w: 4, h: ruleH, color: RC.gold }] },
      { width: '*', stack: [
          ...(heading ? [{ text: heading, font: 'Display', bold: true, fontSize: 13,
                           color: '#1F2A33', margin: [12, 2, 0, 4], link }] : []),
          { text: body, font: 'Body', fontSize: bodySize,
            color: heading ? RC.gray : '#1F2A33', lineHeight: 1.4,
            // Nudged down so a two-line block sits level with the button
            // rather than riding above it.
            margin: [14, heading ? 0 : 7, 14, 0], link }
        ] },
      { width: 132, table: { widths: [132], body: [[{
            text: button, font: 'Body', bold: true, fontSize: 10.5,
            color: '#1F2A33', alignment: 'center', margin: [0, 9, 0, 9], link
          }]] },
        layout: { hLineWidth: () => 0, vLineWidth: () => 0, fillColor: () => RC.gold },
        margin: [0, heading ? 6 : 4, 0, 0] }
    ], columnGap: 0, margin: [0, gap == null ? 20 : gap, 0, 0] };
}

const RC = {
  purple:  '#37006E',
  magenta: '#87006E',
  green:   '#407371',
  gold:    '#FFC864',
  blueLt:  '#94B1C7',
  gray:    '#585B5E',
  grayMid: '#808285',
  g050:    '#F6F7F8',
  g100:    '#ECEDEE',
  g200:    '#D8DADB',
  white:   '#FFFFFF'
};
const DISCLOSURE = 'For financial professional use only. Not for use with the public.';
const PAGE_W = 612, M = 48, CONTENT = PAGE_W - M * 2;

const n = v => (v === null || v === undefined || v === '') ? '—' : String(v);

// The Latin subsets of Gelasio and Arimo have no U+2713 tick, U+2715 cross or
// U+2192 arrow -- they render as tofu. Drawn as SVG so they are always present
// and always match each other's weight.
const MARK = {
  pass: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M5 12.5l4.7 4.7L19 7.6" fill="none" stroke="#FFFFFF" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  fail: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M7 7l10 10M17 7L7 17" fill="none" stroke="#FFFFFF" stroke-width="3.2" stroke-linecap="round"/></svg>',
  unknown: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M9 9a3 3 0 1 1 3.6 2.9c-.7.2-1.1.8-1.1 1.6v.6" fill="none" stroke="#3B2E0C" stroke-width="2.6" stroke-linecap="round"/><circle cx="12" cy="17.6" r="1.5" fill="#3B2E0C"/></svg>',
  arrow: '<svg viewBox="0 0 28 12" xmlns="http://www.w3.org/2000/svg"><path d="M1 6h22M18 1.5L23.5 6 18 10.5" fill="none" stroke="#37006E" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
};

// A mark in its coloured chip. Kept as one helper so the checklist and the
// legend can never drift apart.
const chip = (state, size) => ({
  table: { widths: [size], body: [[{ svg: MARK[state], width: size - 4,
    alignment: 'center', margin: [0, 2, 0, 2] }]] },
  layout: {
    hLineWidth: () => 0, vLineWidth: () => 0,
    // pdfmake's default cell padding is 4pt a side: left in, the chip is 8pt
    // wider than its column and the text beside it prints on top.
    paddingLeft: () => 2, paddingRight: () => 2,
    paddingTop: () => 0, paddingBottom: () => 0,
    fillColor: () => state === 'pass' ? RC.green : state === 'fail' ? RC.magenta : RC.gold
  }
});

// A horizontal bar: filled portion, then the track. Drawn rather than tabled
// so the fill lands on an exact fraction.
const bar = (pct, w, h, fill, track) => ({
  canvas: [
    { type: 'rect', x: 0, y: 0, w, h, color: track || RC.g200 },
    { type: 'rect', x: 0, y: 0, w: Math.max(0, Math.min(1, pct / 100)) * w, h, color: fill }
  ]
});

const rule = (w, color) => ({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: w, y2: 0, lineWidth: 0.6, lineColor: color || RC.g200 }] });


// The summary sits in a fixed box on a fixed grid: SUMMARY_LINES lines at
// SUMMARY_SIZE, and nothing below it moves whatever it does. Overrunning can
// no longer push the page -- it would only crowd the score label -- so the cap
// is set to fit the box. 54 characters a line is deliberately pessimistic: the
// measured average is 66, and this has to hold for the raggedest wrap, not the
// average one.
const SUMMARY_SIZE = 12.5, SUMMARY_LEAD = 23.8, SUMMARY_LINES = 7;
const SUMMARY_MAX = SUMMARY_LINES * 54;      // 378
function fitSummary(text) {
  const t = (text || '').trim();
  if (t.length <= SUMMARY_MAX) return t;
  // Drop whole sentences from the end rather than cutting mid-thought.
  const parts = t.match(/[^.!?]+[.!?]+(\s|$)/g) || [t];
  let out = '';
  for (const p of parts) {
    if ((out + p).trim().length > SUMMARY_MAX) break;
    out += p;
  }
  out = out.trim();
  // Dropping a whole sentence can waste most of the budget -- one 190-character
  // sentence kept and a 210-character one dropped leaves the box two-thirds
  // empty, which on a fixed grid is a visible hole rather than tighter spacing.
  // Below three quarters of the budget, cut at a word instead and fill it.
  if (out.length < SUMMARY_MAX * 0.75)
    out = t.slice(0, SUMMARY_MAX).replace(/\s+\S*$/, '') + '…';
  return out;
}

// Cover art geometry. The source is 1920x1080; scaled to fill the page height
// it is 1408pt wide, so 796pt of it sits outside a 612pt page. COVER_X decides
// which part shows.
//
//   0      the dark top-left of the gradient, no mark
//  -398    centred
//  -796    the right edge, where the mark's arcs live, at true proportions
//
// Centred: the gradient reads as intended and the distorted arcs are gone,
// which is what was asked for. Change the one number to bring them back --
// they will be circular now rather than squeezed.
const COVER_ASPECT = 1920 / 1080;
const COVER_W = Math.round(792 * COVER_ASPECT);      // 1408
const COVER_X = Math.round((612 - COVER_W) / 2);     // -398, centred

// ── cover ────────────────────────────────────────────────────────────────────
// The cover is a FIXED GRID, not a flow. Every block is placed at a hard-coded
// y from the top of the page and nothing below it can be pushed.
//
// It used to be a stack of margins. That works until one value runs long -- a
// summary two lines over, say -- and then everything below shifts down, the
// unbreakable score block will not fit, and pdfmake moves the whole of it to
// page 2. Page 2 has no purple behind it, and the cover's text is white, so
// the block did not look misplaced: it looked erased. Only the gold and grey
// survived. That failure was shipped twice.
//
// With fixed positions the worst a long value can do is crowd its neighbour.
// It cannot move anything, it cannot add a page, and nothing can disappear.
// Change the design by changing these numbers -- they are measured from the
// rendered sheet, and test_cover.js reads them back out of the PDF.
const COVER_Y = {
  logo:      62,   // right-aligned mark
  title:    152,   // "Digital Audit"
  meta:     211,   // firm · url · reviewed
  chip:     255,   // SUMMARY
  summary:  288,   // fixed box: SUMMARY_LINES at SUMMARY_LEAD
  scoreLbl: 461,   // OVERALL DIGITAL SCORE — n OF 100
  band:     476,   // "On track"
  // No delta slot. The cover carried "Up 3 points since the last review",
  // compared against an earlier run of the same client saved in this browser's
  // local history -- which in practice is a half-finished test run, not a
  // review anyone agreed was a baseline. Citing it to a client as "the last
  // review" claims a history that was never established.
  stats:    527,   // score ring + the four figures
  channels: 635,   // the three category scores and their bars
  foot:     721    // disclosure
};
const COVER_LOGO_W = 168;
const SUMMARY_W = CONTENT - 120;   // the box the summary wraps inside

function cover(d, logoWhite) {
  const s = d.scores;
  // Place a block at a hard y. Columns rather than a bare node so the width is
  // the one named here and not whatever pdfmake infers from the page.
  const at = (y, node, w) => ({
    columns: [{ width: w || CONTENT, ...node }],
    absolutePosition: { x: M, y }
  });

  // `flag` lifts a figure out of the row: on a purple cover magenta is too
  // close to the background to read, so the accent is the gold used for every
  // other call to action in the report.
  const stat = (big, small, flag) => ({
    stack: [
      { text: big, font: 'Display', bold: true, fontSize: 17,
        color: flag ? RC.gold : RC.white, margin: [0, 0, 0, 1] },
      { text: small, font: 'Body', fontSize: 8, color: flag ? '#F2DFA8' : '#D9CBE6' }
    ]
  });
  const chan = (name, score) => ({
    width: '*',
    stack: [
      { text: name, font: 'Body', bold: true, fontSize: 8.5, color: RC.white, margin: [0, 0, 0, 4] },
      { text: String(score), font: 'Display', bold: true, fontSize: 26, color: RC.white, margin: [0, 0, 0, 5] },
      bar(score, 150, 3.2, RC.white, '#6B4A8C')   // no rgba in canvas
    ]
  });

  return [
    { svg: logoWhite, width: COVER_LOGO_W,
      absolutePosition: { x: PAGE_W - M - COVER_LOGO_W, y: COVER_Y.logo } },

    at(COVER_Y.title, { text: 'Digital Audit', font: 'Display', fontSize: 38, color: RC.white }),

    at(COVER_Y.meta, { text: [d.firm, '  ·  ', d.url, '  ·  Reviewed ', d.reviewed].join(''),
                       font: 'Body', fontSize: 9.5, color: '#CBB8DC' }),

    { table: { body: [[{ text: 'SUMMARY', font: 'Body', bold: true, fontSize: 7, color: RC.white,
        characterSpacing: 1.1, margin: [5, 3, 5, 3] }]] },
      layout: { hLineWidth: () => 0.7, vLineWidth: () => 0.7,
                hLineColor: () => '#A88FC0', vLineColor: () => '#A88FC0' },
      absolutePosition: { x: M, y: COVER_Y.chip } },

    at(COVER_Y.summary, { text: fitSummary(d.summary), font: 'Display', fontSize: SUMMARY_SIZE,
                          lineHeight: 1.5, color: '#F2EAF7' }, SUMMARY_W),

    at(COVER_Y.scoreLbl, { text: `OVERALL DIGITAL SCORE — ${s.overall} OF 100`, font: 'Body',
                           bold: true, fontSize: 7.5, color: '#CBB8DC', characterSpacing: 1.1 }),

    at(COVER_Y.band, { text: s.band, font: 'Display', fontSize: 23, color: RC.white }),

    { columns: [
        { width: 110, stack: [
            { canvas: [{ type: 'ellipse', x: 34, y: 34, r1: 33, r2: 33, lineColor: '#B9A3D0', lineWidth: 2.4 }] },
            { text: String(s.overall), font: 'Display', bold: true, fontSize: 25, color: RC.white,
              alignment: 'left', margin: [19, -45, 0, 0] }
          ] },
        { width: '*', columns: [
            { width: '*', stack: [ stat(d.kpiPassed, 'KPIs passed'), { text: '', margin: [0, 9, 0, 0] }, stat(d.aeoPassed, 'AEO KPIs passed') ] },
            { width: '*', stack: [ stat(d.needWork, 'need work', true), { text: '', margin: [0, 9, 0, 0] }, stat(d.ptsAvailable, d.actions.length
                  ? `available in ${NUM_WORD(d.actions.length)} ${d.actions.length === 1 ? 'fix' : 'fixes'}`
                  : 'no fixes listed', true) ] }
          ] }
      ], absolutePosition: { x: M, y: COVER_Y.stats } },

    { columns: [chan('Company Visibility', s.v), chan('Website Performance', s.w), chan('Social Media', s.s)],
      columnGap: 16, absolutePosition: { x: M, y: COVER_Y.channels } },

    at(COVER_Y.foot, { text: `${DISCLOSURE}  ·  Prepared by Cetera GrowthLine`,
                       font: 'Body', fontSize: 7, color: '#B9A6CC' })
  ];
}

// How many recommendations page 2 carries. The number drove a slice in one
// place and the word "six" in four separate strings, so changing it meant
// finding all five -- and a heading that promises six things over a list of
// five is the kind of error nobody notices until a client does.
const TOP_N = 5;
// TOP_N is the MOST page 2 will carry, not a quota. A firm with two failing
// checks gets two, and the report has to say two -- it used to print "Do these
// five things first" over a list of two and promise a gain "in five fixes",
// which a client reads before anyone else does.
const NUM_WORD = n => ['zero','one','two','three','four','five','six','seven','eight','nine','ten'][n] || String(n);
const TOP_N_WORD = NUM_WORD(TOP_N);

// Approved recommendation copy, transcribed verbatim from the "Final Use" sheet
// of SA_Digital_Audit_Questions -- its "Current - Action Items" column. That
// sheet is the decided version: the "In Production" sheet carries the older
// wording alongside the newer in a second column, and 20 of its 31 rows differ
// between the two.
//
// This is the language the client-facing page is allowed to use. It is not
// paraphrased, shortened or regenerated -- a recommendation on page 2 is a
// commitment the firm may act on, so the wording is theirs, not the tool's.
//
// 30 of the 40 checks have copy. The ten that do not are listed in
// GTEXT_MISSING below; nothing invents copy to fill those gaps.
const GTEXT = {
  "c-gbp-f":  { title: "Google Business Profile is Vital to Being Found on Google",
               text: "Create and verify your Google Business Profile at no cost. A verified, regularly updated profile boosts credibility, improves search rankings, and strengthens AEO by helping AI tools reference your firm accurately. Add or claim your profile listing by following these steps and tips to optimize your profile." },
  "c-gbp-r":  { title: "Reviews on Google Business Profile",
               text: "More reviews and higher ratings help your business rank higher in search and improve AEO, making it more likely your firm appears in AI-generated answers. To request reviews in a compliant way, use one of the two pre-approved email templates titled “Request a Google Review” in MarketingCentral’s Content Library." },
  "c-gbp-v":  { title: "Verify Your Google Business Profile",
               text: "Once your Google Business Profile is created, verify it by requesting a postcard or using Google’s video verification option. A verified profile strengthens your visibility in both local search and AI-driven results." },
  "c-gbp-l":  { title: "Match Your Profile to Your Brand",
               text: "Upload a clear logo to your Google Business Profile to build brand recognition. A consistent logo across your site, social media, and listings boosts credibility and increases the chances your business is referenced in search and AI results." },
  "c-idx":    { title: "Make Sure Your Website is Properly indexed by Google",
               text: "Permission to Index allows search engines to scan your site and rank it for prospects. All public-facing pages should be indexable so both search engines and AI tools can reference your content, strengthening AEO." },
  "c-cgpt":   { title: "Does AI know your firm?",
               text: "Add your firm name to ChatGPT by entering it as a search prompt (e.g., “Who is [Firm Name]?”). ChatGPT pulls from public sources like your website, news, and awards to shape its answers. Testing this helps you see how your brand appears in AI conversations, especially after a rebrand or new launch." },
  "c-sm":     { title: "Sitemap Indexed by Google",
               text: "A sitemap is a file that lists all of your website’s pages and tells search engines which ones are most important to show. It also helps AI tools better understand and reference your site, strengthening AEO. Building a sitemap is simple—there are many tools available, or you can speak with our team for support." },
  "c-meta":   { title: "Write Meta Descriptions to Tell What a Page is About",
               text: "Every page should have a unique meta description, managed through the SEO tool in your website platform. Meta descriptions appear in search results, help drive organic traffic, and support AEO by giving AI tools clear summaries of your content to reference." },
  "c-ga":     { title: "Use Google Analytics to Monitor Traffic",
               text: "Google Analytics tracks your website traffic and performance, helping you see which pages and content drive engagement. While it doesn’t directly impact rankings, these insights let you improve content and user experience—factors that support stronger SEO and AEO visibility." },
  "c-rcta":   { title: "Add a Google Review Call-to-Action",
               text: "Add a call-to-action on your website that directs clients to your Google Business Profile. There is a Referral systems page in the MarketingCentral website channel you can add to your site.  Simply add it to a resources section to start encouraging reviews.  Be sure to follow Cetera’s compliance rules when including this information." },
  "c-awd":    { title: "Highlight Awards and Recognition",
               text: "Showcase industry awards, community recognition, or firm accolades on your website. Highlighting awards builds credibility with prospects and reinforces authority signals that help your firm surface in both search results and AI-generated answers." },
  "c-spd":    { title: "A New Website Update May help",
               text: "Upgrading your website technology may reduce technical issues that cause your site to load slowly. Things like large images may also cause a site to load slowly." },
  "c-mob":    { title: "Mobile Optimize Your Website",
               text: "More and more each year people are accessing website on their mobile phones.  A mobile ready website ensures that people can interact with your brand on smaller mobile devices." },
  "c-https":  { title: "Ensure Your Site is Secure",
               text: "Your website must have an SSL or TLS certification to ensure it is secure or it will be flagged by web browsers. A\nsimple way to check is by visiting your website address/URL and ensure it starts with HTTPS:// once loaded, which means you are secure. Speak with your domain provider about an SSL Certificate if your site is not secure." },
  "c-img":    { title: "Resize Images to Increase Website Speed",
               text: "You may have a beautiful image from your region on your homepage but if that image is more than 500 KB it is\nloading slow and testing the patience of your visitors. Use Adobe Spark to resize images that are over 500 KB." },
  "c-faq":    { title: "Add a Frequently Asked Questions (FAQ) Section",
               text: "Add FAQ sections to your website addressing common client questions. FAQs not only provide quick answers for prospects but also improve search visibility and support AEO by giving AI tools clear, structured information to reference. FMG includes an FAQ module you can use to easily build and manage this section on your site." },
  "c-nav":    { title: "Keep the Navigation Simple and Under 6 Options",
               text: "Ensure your website has a simple layout and top navigation so visitors can easily find information about your\nbusiness, your team and the services you provide. Use OnceHub to schedule meetings online." },
  "c-cta":    { title: "Use Descriptive CTA's",
               text: "Your homepage should include prominent call to actions (CTAs), with links to your account tools for clients and contact information for prospects. using benefit-based headlines that convey what a person can gain, learn or benefit from working with you." },
  "c-res":    { title: "Write a Blog For Your Website",
               text: "Writing a blog boosts local search, builds thought leadership, and supports AEO so your expertise appears in AI-driven answers. MarketingCentral makes it simple to post articles to your blog, helping you stay visible in both search engines and AI tools." },
  "c-pho":    { title: "Use High Quality Photos to Improve your Site",
               text: "Stock photography is a very helpful tool to filling out a web page's content but it is also a key reason visitors will leave your website.  Photos should be professional and not look too staged, should look similiar and should never repeat across pages unless they are for the same content." },
  "c-lnk":    { title: "Encourage Prospects to Browse More Pages",
               text: "Your unique value proposition should be prominent to capture a prospect's attention immediately. Furthermore,\nsocial media has changed how people scroll through web pages. Now, longer pages are considered better.\nConsider adding a section on the homepage for every page of your site." },
  "c-hdl":    { title: "Write Benefit Based Headlines",
               text: "Writing good headlines is also an important part of helping your prosepcts engage with your brand.  Prospects are looking to solve a problem or find a solution and using benefit-based headlines convey what a person can gain, learn or benefit from by working with you." },
  "c-pst":    { title: "Post Frequently to Establish Yourself as a Thought Leader",
               text: "Post on social media 2–3 times per week to stay visible and relevant. Frequent, consistent posting not only helps you compete for space in client feeds but also signals credibility to search engines and AI tools. MarketingCentral offers automated campaigns and pre-scheduled content to make hitting this frequency easier." },
  "c-bhd":    { title: "Use Consistent Branding Across Your Digital Properties",
               text: "Building branded headers that match your website helps your social media visitors know they are at the trusted source for your business and reinforces your brand." },
  "c-sum":    { title: "Update the Contact and Summary Content on Your Pages",
               text: "Write a keyword-rich summary for your social profiles that includes your company name, services, and unique value proposition. Tailor it to character limits and use headlines to showcase your strengths. Consistent, optimized profiles improve visibility and support AEO by helping AI tools recognize and reference your firm." },
  "c-cni":    { title: "Update Your Contact Information to Be Found",
               text: "One of the ways a referral to your company will explore your offering is via their preferred social media platform. Keeping your contact information up to date can ensure a client or prospect can connect with your office." },
  "c-url":    { title: "Change Your Social Media URL",
               text: "Customize your social media profile URLs to include your company name (e.g., facebook.com/Name). Branded URLs make your profiles easier to find, strengthen credibility, and create consistency across platforms. This consistency helps AI tools and search engines clearly identify and reference your firm, supporting stronger AEO." },
  "c-lgp":    { title: "Match Your Profile to Your Brand",
               text: "Keep your social media profile pages updated with your logo or a headhsot if you are a single-advisor office." },
  "c-sln":    { title: "Link Your Social Channels from Your Website",
               text: "Ensure your website includes links to your social media accounts and vice-versa to make it easy to connect with you across multiple channels." },
  "c-tag":    { title: "Create Posts that Drive Traffic and Engagement",
               text: "Tag centers of influence, community organizations, and relevant individuals in your social media posts to expand reach and spark engagement. Combine tags with relevant hashtags to boost discoverability, appear in more feeds, and strengthen both visibility and credibility." }
};

// Copy written for this tool, NOT taken from SA_Digital_Audit_Questions.
//
// These ten checks had no row in the sheet, so page 2 withheld their
// recommendation entirely and a lower-value fix was promoted in its place --
// including LinkedIn, the second most valuable fix in the whole audit. That was
// costing real audits, so this fills the gap in the meantime.
//
// It is kept in its own object rather than merged into GTEXT so the boundary
// stays visible: everything in GTEXT is the firm's approved language, and
// everything here is awaiting their sign-off. When a row lands in the sheet,
// delete the entry here -- the sheet always wins.
//
// Written to the same constraints as the approved copy: second person, roughly
// the same length, what to do stated lightly and why it matters stated
// plainly, and no service, vendor, agency or tool recommended anywhere.
const GTEXT_DRAFT = {
  "c-hli":    { title: "Claim a LinkedIn Page for the Firm Itself",
               text: "A firm page is separate from the personal profiles of your advisors, and it is where prospects and referral sources look to confirm a business is real and active. It also gives search engines and AI tools a single authoritative entity to associate with your firm rather than a scattering of individuals." },
  "c-szp":    { title: "Reduce the Weight of Your Homepage",
               text: "A heavy homepage is slow to appear, and the delay is worst on phones and weaker connections, which is where a good share of first visits happen. Visitors leave pages that make them wait, and load time is one of the factors search engines weigh when deciding how to rank you." },
  "c-gbp-d":  { title: "Describe Your Business in Your Own Words",
               text: "The description on your profile is often the first thing a prospect reads about your firm, before they ever reach your website. It is also text that AI tools quote directly when asked what your firm does, so leaving it blank hands that answer to whatever else has been written about you." },
  "c-hfb":    { title: "Claim Your Firm's Page on Facebook",
               text: "Even where it is not your main channel, a claimed page is a public record that your firm exists and is current. Prospects and referral sources check, and an absent or unclaimed page reads as a gap. A claimed page also gives you control of the information shown about your business." },
  "c-sch":    { title: "Tell Search Engines Plainly What Your Firm Is",
               text: "Structured data states in a form machines read directly what your business is, where it operates and who works there, rather than leaving search engines and AI tools to infer it from your page copy. It is one of the clearest ways to be described accurately in AI-generated answers." },
  "c-aicite": { title: "Become the Source AI Quotes About You",
               text: "When an AI tool answers a question about your firm it draws on sources and often names them. If your own site is not among those sources, the answer is assembled from third-party pages you do not control. Being the cited source is how you keep that answer accurate and current." },
  "c-da5":    { title: "Build the Authority of Your Domain",
               text: "Domain authority reflects how many credible sites reference yours, and it influences both how you rank in search and whether AI tools treat your site as dependable enough to cite. It builds slowly through being referenced in places that matter, so it is worth starting early." },
  "c-hig":    { title: "Consider an Instagram Presence",
               text: "Instagram reaches a different audience than your other channels and favours the visual: the people behind the firm, the community you work in, the moments that show character. For firms building recognition with younger prospects and referral sources, it is a reasonable place to be findable." },
  "c-gbp-p":  { title: "Show the People and the Place",
               text: "Photos of your team and office give a prospect something to picture before a first conversation, and listings with images hold attention longer than those without. They also signal an actively maintained profile, which helps how your listing performs in local results." },
  "c-hyt":    { title: "Give Your Video Content a Home",
               text: "A channel gives video a permanent address that can be found, linked and referenced, rather than living only inside a social feed that scrolls past. Video is surfaced in search results and drawn on by AI tools, so it works hardest when it sits somewhere durable." },
};

// One lookup for the report. GTEXT first, always: an approved row supersedes a
// draft the moment it exists, without anything else having to change.
const gtextFor = id => GTEXT[id] || GTEXT_DRAFT[id] || null;

// Checks with no copy from EITHER source. Page 2 still withholds these rather
// than inventing anything; the list is empty today and the machinery stays so
// that a check added later cannot quietly print nothing.
const GTEXT_MISSING = [
  // Empty: the ten that had no approved row are covered by GTEXT_DRAFT until
  // their wording lands in the sheet.
];

// ── page 2 · priorities ──────────────────────────────────────────────────────
function priorities(d, logoPurple) {
  const rows = [];
  d.actions.forEach((a, i) => {
    // No per-row point value. Indexed to a 60-100 scale and then weighted by
    // category share, the heaviest single fix any firm can have is worth two
    // points, so every row printed "+1" or "+2" and the column read as broken.
    // The rank already carries the priority; the total is on the cover and in
    // the projection band below, where the arithmetic still holds.
    rows.push([
      { text: String(i + 1), font: 'Display', fontSize: 15, color: RC.g200, margin: [0, 3, 0, 0] },
      { stack: [
          // Two lines only. The scorecard question was tried here as a third and
          // pushed the report to six pages; the box it came from is named in the
          // title, and the question is on its own scorecard page.
          { text: a.title, font: 'Body', bold: true, fontSize: 10.5, color: RC.purple, margin: [0, 2, 0, 4] },
          { text: a.why, font: 'Body', fontSize: 8.9, color: RC.gray, lineHeight: 1.38, margin: [0, 0, 0, 5] },
          { text: [a.cat, ' · ', a.effort, a.aeo ? ' · Impacts AEO' : ''].join(''),
            font: 'Body', fontSize: 7.8, color: RC.grayMid }
        ].filter(Boolean) }
    ]);
  });

  const n = d.actions.length;
  // A firm can pass everything. pdfmake throws on a table with no rows, so the
  // whole report died rather than printing the best result the audit can give.
  const unmeasured = d.sections
    .flatMap(sec => sec.groups).flatMap(g => g.items)
    .filter(k => k.state === 'unknown').length;

  // Nothing to list has two causes and they are not the same claim. Either
  // nothing failed, or something failed and its wording is not approved yet --
  // and saying "all clear" over a withheld recommendation would be a lie the
  // audit is built not to tell.
  const emptyNote = d.failedCount === 0
    ? 'No measured check failed.' +
      (unmeasured ? ' ' + unmeasured + ' ' + (unmeasured === 1 ? 'check' : 'checks') +
        ' could not be measured — those are marked on the scorecard pages that follow.'
        : ' Every check in this audit passed.')
    : d.failedCount + ' ' + (d.failedCount === 1 ? 'check needs' : 'checks need') +
      ' work, but approved wording for them is not available yet. They are marked ' +
      'on the scorecard pages that follow.';

  const heading = n === 0 ? 'No priority fixes'
                : n === 1 ? 'Do this one thing first'
                : `Do these ${NUM_WORD(n)} things first`;

  return [
    { columns: [
        { text: heading, font: 'Display', fontSize: 21, color: RC.purple, width: '*' },
        { svg: logoPurple, width: 95, alignment: 'right' }
      ], margin: [0, 0, 0, 16] },
    rule(CONTENT),
    n === 0
      ? { text: emptyNote, font: 'Body', fontSize: 10, color: RC.gray, lineHeight: 1.45,
          margin: [0, 14, 60, 16] }
      : { table: { widths: [22, '*'], body: rows },
          layout: {
            hLineWidth: (i, node) => (i === 0 || i === node.table.body.length) ? 0 : 0.6,
            vLineWidth: () => 0, hLineColor: () => RC.g200,
            paddingTop: () => 10, paddingBottom: () => 10, paddingLeft: () => 0, paddingRight: () => 0
          }, margin: [0, 4, 0, 16] },

    // The band projects a gain, so it is printed only when there is one. With
    // nothing to complete it claimed "Completing all five moves this firm from
    // Strong into the Strong band" -- five fixes that are not listed, and a
    // move from a band into itself.
    ...(n > 0 && d.projected > d.scores.overall ? [
    { table: { widths: ['*'], body: [[{
        columns: [
          // 26pt held two digits at 19pt Display bold and wrapped a third, so a
          // firm reaching 100 saw "10" above a lone "0". Both score columns are
          // sized for three digits, and the band widened to match.
          { width: 150, columns: [
              { width: 36, text: String(d.scores.overall), font: 'Display', bold: true, fontSize: 19, color: RC.purple, noWrap: true },
              { width: 24, svg: MARK.arrow, margin: [0, 8, 0, 0] },
              { width: 36, text: String(d.projected), font: 'Display', bold: true, fontSize: 19, color: RC.purple, noWrap: true }
            ], columnGap: 9 },
          { width: '*', text: (d.projectedBand === d.scores.band
              // Already in the top band, or the gain is not enough to cross
              // into the next one. Either way the points are real and the band
              // is not changing, so say that instead of inventing a move.
              // "Completing all two" is not English; "all five" is.
              ? [ n === 1 ? 'Completing this one adds ' : n === 2 ? 'Completing both adds '
                  : `Completing all ${NUM_WORD(n)} adds `,
                  { text: (d.projected - d.scores.overall) + ' points', bold: true },
                  ', holding this firm in the ', { text: d.scores.band, bold: true }, ' band.' ]
              : [ n === 1 ? 'Completing this one moves this firm from '
                  : n === 2 ? 'Completing both moves this firm from '
                  : `Completing all ${NUM_WORD(n)} moves this firm from `,
                  { text: d.scores.band, bold: true }, ' into the ',
                  { text: d.projectedBand, bold: true }, ' band.' ]),
            font: 'Body', fontSize: 9.5, color: '#1F2A33', lineHeight: 1.4, margin: [0, 3, 0, 0] }
        ], margin: [18, 12, 14, 12]
      }]] },
      layout: { hLineWidth: () => 0, vLineWidth: () => 0, fillColor: () => RC.blueLt },
      margin: [0, 0, 0, 12] }] : []),

    ...(n > 0 ? [{ text: 'Ranked by the score each fix unlocks, hardest-hitting first. Your GrowthLine consultant can walk through the detail with you.',
      font: 'Body', fontSize: 8, color: RC.grayMid }] : []),

    // The call to action, at the foot of the priorities page — the moment the
    // reader has just seen what six fixes are worth to their score.
    ctaBar(CTA_LINK, 'Schedule a Free Digital Audit Review',
      'Connect with the Cetera GrowthLine team to get a 30-minute review of this audit ' +
      'and gain more valuable resources to improve your digital presence.',
      'Schedule Now')
  ];
}

// ── pages 3-5 · scorecards ───────────────────────────────────────────────────
function scorecard(sec, logoPurple) {
  const tile = t => ({
    stack: [
      { canvas: [{ type: 'rect', x: 0, y: 0, w: 118, h: 2.2, color: t.ok ? RC.green : RC.magenta }] },
      { table: { widths: [118], body: [[{ stack: [
            { text: t.label.toUpperCase(), font: 'Body', bold: true, fontSize: 6.6, color: RC.grayMid, characterSpacing: .7, margin: [0, 0, 0, 5] },
            { text: n(t.value), font: 'Display', bold: true, fontSize: 21, color: RC.magenta, margin: [0, 0, 0, 2] },
            { text: t.unit || '', font: 'Body', fontSize: 7.6, color: RC.gray, margin: [0, 0, 0, 5] },
            { text: t.good || '', font: 'Body', fontSize: 7, color: RC.grayMid }
          ], margin: [8, 8, 6, 9] }]] },
        layout: { hLineWidth: (i, node) => i === node.table.body.length ? 0.6 : 0,
                  vLineWidth: (i, node) => (i === 0 || i === node.table.widths.length) ? 0.6 : 0,
                  hLineColor: () => RC.g200, vLineColor: () => RC.g200 } }
    ]
  });

  const item = k => {
    return [
      chip(k.state, 12),
      { stack: [
          { text: k.q, font: 'Body', bold: k.state !== 'pass', fontSize: 8.2,
            color: k.state === 'pass' ? RC.gray : '#1F2A33', lineHeight: 1.32 },
          k.note ? { text: k.note, font: 'Body', fontSize: 6.8, color: RC.grayMid, margin: [0, 2, 0, 0] } : null
        ].filter(Boolean) },
      k.aeo ? { table: { body: [[{ text: 'AEO', font: 'Body', bold: true, fontSize: 5.6, color: '#2C4457',
                                   alignment: 'center' }]], widths: [18] },
               layout: { hLineWidth: () => 0, vLineWidth: () => 0,
                         paddingLeft: () => 0, paddingRight: () => 0,
                         paddingTop: () => 2.5, paddingBottom: () => 2.5,
                         fillColor: () => RC.blueLt } }
            : { text: '' }
    ];
  };

  // A failing row is the reason the page exists, and in a column of fifteen it
  // was one bold line among fourteen others -- the reader had to hunt for the
  // magenta mark. It now gets a tint and a magenta edge, so the things needing
  // work can be counted from across a desk.
  //
  // Unmeasured gets its own amber tint rather than sharing the failure one: the
  // whole point of that state is that it is NOT a failure, and washing both in
  // the same colour would undo the distinction the audit is built on.
  const ROW_FILL = { fail: '#FBEEF5', unknown: '#FFFBEB' };
  const ROW_EDGE = { fail: RC.magenta, unknown: RC.gold };

  const group = g => [
    { text: g.name.toUpperCase(), font: 'Body', bold: true, fontSize: 7, color: RC.grayMid,
      characterSpacing: .9, margin: [0, 0, 0, 5] },
    { canvas: [{ type: 'rect', x: 0, y: 0, w: 232, h: 1.6, color: RC.purple }], margin: [0, 0, 0, 4] },
    { table: { widths: [12, '*', 18], body: g.items.map(item) },
      layout: { hLineWidth: (i, node) => i === 0 ? 0 : 0.5,
                // A 2pt edge down the left of a flagged row, drawn as the
                // table's own left border so it lines up with the fill.
                vLineWidth: (i, node) => i === 0 ? 2 : 0,
                vLineColor: (i, node, r) => ROW_EDGE[g.items[r] && g.items[r].state] || '#FFFFFF',
                hLineColor: () => RC.g100, paddingTop: () => 5, paddingBottom: () => 5,
                fillColor: (i) => (g.items[i] && ROW_FILL[g.items[i].state]) || null,
                // Column 1 is the question: it needs a real gutter or it prints
                // over the mark beside it. Columns shift right to clear the edge.
                paddingLeft: i => i === 0 ? 5 : i === 1 ? 7 : 0,
                paddingRight: i => i === 1 ? 5 : 3 } }
  ];

  const cols = sec.groups.map(g => ({ width: '*', stack: group(g) }));

  return [
    { columns: [
        { width: '*', text: sec.name, font: 'Display', fontSize: 21, color: RC.purple },
        // The weight / KPIs-passed / need-work line used to sit between the
        // title and the logo. The same figures are on the cover and in the
        // score and the tinted rows just below, so it was a third telling.
        { width: 88, svg: logoPurple, alignment: 'right' }
      ], columnGap: 0, margin: [0, 0, 0, 14] },

    { columns: [
        { width: 76, text: String(sec.score), font: 'Display', bold: true, fontSize: 40, color: RC.purple },
        { width: '*', stack: [
            { text: sec.band, font: 'Body', bold: true, fontSize: 11, color: RC.purple, margin: [0, 8, 0, 3] },
            { text: sec.blurb, font: 'Body', fontSize: 9, color: RC.grayMid }
          ] }
      ], margin: [0, 0, 0, 10] },

    bar(sec.score, CONTENT, 6, RC.magenta, RC.g100),
    { columns: [
        { text: '0', font: 'Body', fontSize: 7, color: RC.grayMid },
        { text: '100', font: 'Body', fontSize: 7, color: RC.grayMid, alignment: 'right' }
      ], margin: [0, 3, 0, 12] },

    { text: sec.intro, font: 'Body', fontSize: 9.2, color: '#1F2A33', lineHeight: 1.45, margin: [0, 0, 60, 16] },
    { columns: sec.tiles.map(tile), columnGap: 12, margin: [0, 0, 0, 18] },
    { columns: cols, columnGap: 24 },

    // "Not measured" is dropped from the legend on a page that has none -- it
    // was explaining a mark the reader never sees. It stays on a page that DOES
    // have one, because an unexplained "?" beside a question is worse than a
    // legend entry: the whole point of that mark is that the check was not
    // failed, and without the key it reads as one.
    { columns: [
        { width: 11, ...chip('pass', 11) },
        { width: 40, text: 'Passed', font: 'Body', fontSize: 7.4, color: RC.gray, margin: [4, 1.5, 0, 0] },
        { width: 11, ...chip('fail', 11) },
        { width: 58, text: 'Needs work', font: 'Body', fontSize: 7.4, color: RC.gray, margin: [4, 1.5, 0, 0] },
        ...(sec.groups.some(g => g.items.some(k => k.state === 'unknown')) ? [
          { width: 11, ...chip('unknown', 11) },
          { width: 68, text: 'Not measured', font: 'Body', fontSize: 7.4, color: RC.gray, margin: [4, 1.5, 0, 0] }
        ] : []),
        { width: '*', text: sec.legend || '', font: 'Body', fontSize: 7.4, color: RC.grayMid, margin: [0, 1.5, 0, 0] }
      ], columnGap: 0, margin: [0, 14, 0, 0] },

    // Every scorecard page ends with the roadmap, so whichever section the
    // reader stops on has the next step on it.
    ctaBar(ROADMAP_LINK, null,
      'Add and follow the Implement GrowthLine Audit Recommendations roadmap in Growth360.',
      'Launch Roadmap', 16)
  ];
}

function buildReportDoc(d, assets) {
  const content = [];
  content.push(...cover(d, assets.logoWhite));
  content.push({ text: '', pageBreak: 'after' });
  content.push(...priorities(d, assets.logoPurple));
  d.sections.forEach(sec => {
    content.push({ text: '', pageBreak: 'before' });
    content.push(...scorecard(sec, assets.logoPurple));
  });

  return {
    pageSize: 'LETTER',
    pageOrientation: 'portrait',
    pageMargins: [M, M, M, 58],
    info: { title: `Digital Audit — ${d.firm}`, author: 'Cetera GrowthLine' },
    // The cover art is 1920x1080 -- 16:9 landscape. Forcing it into a 612x792
    // portrait page squeezed it horizontally by 2.3x, which is why the Cetera
    // mark's circles came out as tall ellipses. Giving both width and height
    // is what does that: pdfmake stretches to fit rather than preserving the
    // aspect ratio.
    //
    // So scale it by HEIGHT only and let the width fall where it must, then
    // slide it left so the page shows a crop of a correctly-proportioned
    // image. Nothing is distorted because nothing is being squeezed; the part
    // that does not fit is simply off the page, which is what the mark's
    // stretched arcs were doing to the design anyway.
    background: page => page === 1
      ? { image: 'cover', width: COVER_W, absolutePosition: { x: COVER_X, y: 0 } }
      : { canvas: [{ type: 'rect', x: 0, y: 786, w: PAGE_W, h: 6, color: RC.purple }] },
    footer: page => page === 1 ? null : ({
      columns: [
        { text: DISCLOSURE, font: 'Body', fontSize: 7, color: RC.grayMid },
        { text: `Reviewed ${d.reviewed}  ·  Page ${page}`, font: 'Body', fontSize: 7, color: RC.grayMid, alignment: 'right' }
      ], margin: [M, 8, M, 0]
    }),
    images: { cover: assets.coverBg },
    content,
    defaultStyle: { font: 'Body', fontSize: 9.5, color: RC.gray }
  };
}



return { RC, DISCLOSURE, GTEXT, GTEXT_DRAFT, GTEXT_MISSING, gtextFor,
         TOP_N, TOP_N_WORD, NUM_WORD, MARK, CTA_LINK, ROADMAP_LINK,
         PAGE_W, COVER_W, COVER_X, COVER_Y, COVER_ASPECT, COVER_LOGO_W,
         SUMMARY_MAX, SUMMARY_SIZE, SUMMARY_W, fitSummary,
         n, bar, chip, rule, ctaBar, cover, priorities, scorecard,
         buildReportDoc };
});
