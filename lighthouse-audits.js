// ── Lighthouse audit ids, and the ones Google replaced ───────────────────────
//
// PageSpeed runs Lighthouse, and Lighthouse 13 (October 2025) deleted a batch
// of audits outright. Four of the eleven this proxy reads went with it. Nothing
// errored -- `audits['viewport']` simply became undefined, which this code
// correctly treats as "not measured", so the audit quietly stopped being able
// to answer whether a site is mobile-friendly. It was unmeasured on 58% of runs
// before anyone noticed, and it is the heaviest single check in the report.
//
// Each replacement is taken from the new audit's own `replacesAudits` field in
// the Lighthouse source, not guessed:
//
//   viewport               -> viewport-insight
//   third-party-summary    -> third-parties-insight
//   uses-optimized-images  -> image-delivery-insight
//   uses-responsive-images -> image-delivery-insight
//
// Both names are read, newest first, so this works whichever Lighthouse
// PageSpeed happens to be serving -- and keeps working through the next
// rename, because the old id stays as the fallback rather than being deleted.
//
// tools/lighthouse-audit-drift.js checks this list against the live Lighthouse
// config and names anything that has gone missing. Run it when a check starts
// reporting "not measured" for no visible reason.
const LH_AUDITS = {
  'largest-contentful-paint': ['largest-contentful-paint'],
  'first-contentful-paint':   ['first-contentful-paint'],
  'total-blocking-time':      ['total-blocking-time'],
  'total-byte-weight':        ['total-byte-weight'],
  'network-requests':         ['network-requests'],
  'resource-summary':         ['resource-summary'],
  'js-libraries':             ['js-libraries'],
  // Removed in Lighthouse 13. New id first.
  'viewport':                 ['viewport-insight', 'viewport'],
  'third-party-summary':      ['third-parties-insight', 'third-party-summary'],
  'uses-optimized-images':    ['image-delivery-insight', 'uses-optimized-images'],
  'uses-responsive-images':   ['image-delivery-insight', 'uses-responsive-images']
};

// Reads an audit by the name this code knows it as, trying the current
// Lighthouse id first. Returns the audit object, plus which id answered, so a
// rename shows up in the stored run instead of having to be deduced from a
// check that stopped working.
function lhAudit(audits, name) {
  const ids = LH_AUDITS[name] || [name];
  for (const id of ids) {
    if (audits && audits[id] !== undefined) return { audit: audits[id], via: id };
  }
  return { audit: undefined, via: null };
}

module.exports = { LH_AUDITS, lhAudit };
