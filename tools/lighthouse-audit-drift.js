#!/usr/bin/env node
// Which of the Lighthouse audits this proxy reads still exist?
//
// Lighthouse 13 deleted four of the eleven ids server.js depends on, and
// nothing anywhere said so. `audits['viewport']` became undefined, the code
// did the right thing with an undefined -- recorded "not measured" rather than
// inventing a failure -- and the audit quietly lost the ability to answer
// whether a site is mobile-friendly. 58% of runs, for months, in silence.
//
// This fetches the live Lighthouse default config and reports every id in
// LH_AUDITS that is no longer in it. Run it when a check starts reporting "not
// measured" for no visible reason, and after any report that PageSpeed has
// changed.
//
//   node tools/lighthouse-audit-drift.js [version]      (default: latest)
const path = require('path');
const { LH_AUDITS } = require(path.join(__dirname, '..', 'lighthouse-audits.js'));

// `main` by default, not a release tag. Resolving "latest" needs the GitHub
// API, which is refused from some networks (403 here), whereas
// raw.githubusercontent.com serves any ref including the branch tip. Pass a tag
// to pin: node tools/lighthouse-audit-drift.js v13.2.0
const VERSION = process.argv[2] || 'main';

async function configFor(tag) {
  const url = 'https://raw.githubusercontent.com/GoogleChrome/lighthouse/' +
              tag + '/core/config/default-config.js';
  const r = await fetch(url);
  if (!r.ok) throw new Error('could not read the Lighthouse config for ' + tag +
                             ' (HTTP ' + r.status + ') — is that a real tag?');
  return r.text();
}

(async () => {
  let tag = VERSION;
  if (tag === 'latest') {
    const r = await fetch('https://api.github.com/repos/GoogleChrome/lighthouse/releases/latest',
                          { headers: { 'Accept': 'application/vnd.github+json' } });
    if (!r.ok) throw new Error(
      'could not ask GitHub for the latest release (HTTP ' + r.status + '). ' +
      'The API is blocked on some networks — run with no argument to read ' +
      'the main branch, or name a tag such as v13.2.0.');
    tag = (await r.json()).tag_name;
  }
  const cfg = await configFor(tag);
  console.log('Lighthouse ' + tag + '\n');

  let missing = 0, stale = 0;
  for (const [name, ids] of Object.entries(LH_AUDITS)) {
    // An id counts as present if the config mentions it as a quoted audit id.
    const found = ids.filter(id => new RegExp("'" + id + "'").test(cfg));
    if (!found.length) {
      console.log('  GONE      ' + name + '  (tried: ' + ids.join(', ') + ')');
      missing++;
    } else if (found[0] !== ids[0]) {
      // The preferred id is absent but an older one answers: works today,
      // and is the shape this whole file exists to make visible.
      console.log('  FALLBACK  ' + name + '  -> using ' + found[0] +
                  ', preferred ' + ids[0] + ' is not in this config');
      stale++;
    } else {
      console.log('  ok        ' + name + (ids.length > 1 ? '  (' + found[0] + ')' : ''));
    }
  }
  console.log();
  if (missing) {
    console.log(missing + ' audit(s) this proxy reads do not exist in ' + tag + '.');
    console.log('Find the replacement by grepping the Lighthouse source for');
    console.log("replacesAudits: the new audit declares which old ids it takes over.");
    process.exit(1);
  }
  console.log(stale ? stale + ' using an older id than preferred; nothing is broken.'
                    : 'Every audit this proxy reads exists in ' + tag + '.');
})().catch(e => { console.error(e.message); process.exit(1); });
