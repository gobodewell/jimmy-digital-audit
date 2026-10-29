// Where Chromium actually is, asked rather than assumed.
//
// Every browser-driven test hard-coded
// /opt/pw-browsers/chromium-1194/chrome-linux/chrome. That is a build number
// and a directory layout, and both move: this container ships 1243 under
// chrome-linux64, so a fresh clone could not launch a browser and 25 of the 55
// suites failed at once -- not because anything was broken, but because the
// machine had been rebuilt. A test that cannot run is worth less than no test,
// because it reports nothing while looking like coverage.
//
// Nor can playwright be left to find it: the pinned npm package wants the
// build it shipped with (1248 here) and errors naming a directory that does
// not exist. The image keeps /opt/pw-browsers/chromium as a stable symlink for
// exactly this, so that is what we ask for.
const fs = require('fs');
const path = require('path');

const BROWSERS = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';

function chromiumPath() {
  const tried = [];
  // An explicit override always wins, so a developer on another machine can
  // point at their own build without editing anything.
  const candidates = [process.env.CHROMIUM_PATH, path.join(BROWSERS, 'chromium')];
  for (const c of candidates) {
    if (!c) continue;
    tried.push(c);
    if (fs.existsSync(c)) return c;
  }
  // Then whatever build is actually installed, newest first, under either
  // layout. This is the part that survives the next bump.
  let dirs = [];
  try {
    dirs = fs.readdirSync(BROWSERS)
      .filter(n => /^chromium-\d+$/.test(n))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  } catch (e) { /* no browsers directory at all */ }
  for (const d of dirs) {
    for (const leaf of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const c = path.join(BROWSERS, d, leaf);
      tried.push(c);
      if (fs.existsSync(c)) return c;
    }
  }
  // Returning undefined would let playwright try its own path and fail with a
  // message about a directory nobody chose. Say what was looked for instead.
  throw new Error('no Chromium found. Looked for:\n  ' + tried.join('\n  ') +
    '\nSet CHROMIUM_PATH to override.');
}

module.exports = chromiumPath;
