// The Lighthouse ids this proxy depends on.
//
// Lighthouse 13 (October 2025) deleted four of the eleven audits server.js
// reads. Nothing errored: `audits['viewport']` became undefined, the code
// treated an undefined as "not measured" -- which is exactly right, and is why
// nobody saw it -- and the audit silently lost the ability to say whether a
// site is mobile-friendly. Unmeasured on 58% of runs, for months, on the
// heaviest single check in the report.
//
// The lesson is not "read viewport-insight". It is that a dependency on
// somebody else's string constant needs something that notices when the string
// stops existing. This file is that, for the half that can be checked offline;
// tools/lighthouse-audit-drift.js is the half that asks Google.
const path = require('path');
const fs = require('fs');
const { LH_AUDITS, lhAudit } = require('../lighthouse-audits.js');

let failures = 0;
const check = (l, c, d) => {
  console.log((c ? '  PASS  ' : '  FAIL  ') + l + (d ? '   → ' + d : ''));
  if (!c) failures++;
};

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

console.log('\nA. nothing reads an audit id behind the manifest\'s back');
// The whole guard rests on every read going through lhAudit. A stray
// audits['something'] is a dependency nothing is watching -- which is the
// precise shape of the bug this file exists for.
const direct = [...src.matchAll(/audits\[\s*'([a-z0-9-]+)'\s*\]/g)].map(m => m[1]);
check('server.js reads no Lighthouse audit by a literal id',
      direct.length === 0,
      direct.length ? direct.join(', ') + ' — route these through lhAudit()' : '');

const named = [...src.matchAll(/lhAudit\([^,]+,\s*'([a-z0-9-]+)'\s*\)/g)].map(m => m[1]);
check('and every id it does ask for is in the manifest',
      named.every(n => LH_AUDITS[n]),
      named.filter(n => !LH_AUDITS[n]).join(', '));
// `|| true` made this vacuous when first written -- a check that cannot fail,
// which is worse than no check because it reads like coverage.
const unread = Object.keys(LH_AUDITS).filter(k => !named.includes(k));
check('the manifest carries no entry nothing reads',
      unread.length === 0, unread.join(', '));

console.log('\nB. the four Lighthouse 13 removed each name their replacement');
// Taken from the new audit's own `replacesAudits` field in the Lighthouse
// source. Pinned here so a well-meaning tidy-up cannot drop the new id and
// leave the dead one behind.
const REPLACED = {
  'viewport':                 'viewport-insight',
  'third-party-summary':      'third-parties-insight',
  'uses-optimized-images':    'image-delivery-insight',
  'uses-responsive-images':   'image-delivery-insight'
};
for (const [old, now] of Object.entries(REPLACED)) {
  check('  ' + old + ' → ' + now,
        LH_AUDITS[old] && LH_AUDITS[old][0] === now,
        JSON.stringify(LH_AUDITS[old]));
  check('  ' + old + ': the old id is kept as a fallback, not deleted',
        LH_AUDITS[old] && LH_AUDITS[old].includes(old));
}

console.log('\nC. the reader prefers the new id and falls back to the old');
check('a Lighthouse 13 response answers',
      lhAudit({ 'viewport-insight': { score: 1 } }, 'viewport').audit.score === 1);
check('a Lighthouse 12 response still answers',
      lhAudit({ 'viewport': { score: 0 } }, 'viewport').audit.score === 0);
check('with both present the newer one wins',
      lhAudit({ 'viewport-insight': { score: 1 }, 'viewport': { score: 0 } },
              'viewport').via === 'viewport-insight');
check('and neither present is undefined, not a zero',
      lhAudit({}, 'viewport').audit === undefined);

console.log('\nD. a missing audit must never read as a failure');
// The one invariant the whole project is built on. An absent audit is a thing
// nobody measured; scoring it 0 would mark a mobile-friendly site as failing.
check('an absent audit yields no score to compare',
      lhAudit({}, 'viewport').audit?.score === undefined);
check('and a score of 0 is still a real measurement, not an absence',
      lhAudit({ 'viewport-insight': { score: 0 } }, 'viewport').audit.score === 0);
// The null-vs-missing arithmetic in server.js, repeated here because it is the
// line that turns an absence into a finding if it is ever written as `?? 0`.
check('server.js converts a null score to null, never to false',
      /viewportAudit != null \? viewportAudit >= 0\.9 : null/.test(src));
check('and does not coerce a missing audit with ?? 0',
      !/audits\[[^\]]+\]\?\.score \?\? 0/.test(src));

console.log('\nE. which id answered is recorded with the run');
// So the next rename is a visible fact in the stored audit rather than
// something to be deduced from a check that stopped working.
check('the response carries lhVia', /lhVia:\s*\{/.test(src));
check('naming the viewport and third-party sources',
      /lhVia:[\s\S]{0,160}viewport:/.test(src) &&
      /lhVia:[\s\S]{0,160}thirdParty:/.test(src));

console.log('\nF. the drift tool exists and reads this same list');
const tool = path.join(__dirname, '..', 'tools', 'lighthouse-audit-drift.js');
check('tools/lighthouse-audit-drift.js is present', fs.existsSync(tool));
check('and takes its ids from the manifest rather than its own copy',
      /require\([^)]*lighthouse-audits\.js'\)/.test(fs.readFileSync(tool, 'utf8')));

console.log();
console.log(failures ? failures + ' check(s) failed' : 'all checks passed');
process.exit(failures ? 1 : 0);
