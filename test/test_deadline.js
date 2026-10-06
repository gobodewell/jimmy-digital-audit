// How long a run is allowed to take, and why the number is not arbitrary.
//
// The deadline was 420 seconds, sitting next to a comment that said "a real
// run is 2-4 minutes". The only successful unattended run at the time --
// Archstone, scored 92 on 32 of 40 KPIs -- had taken 421 SECONDS, and that
// figure was in the commit message of the change that introduced the deadline.
// So the ceiling was set one second below the single measurement in evidence.
//
// The next real audit, the first ever started from Airtable, died on it at
// 425s. Everything the page had found was thrown away, the job was marked
// failed, and the Airtable row said Failed to anyone looking.
//
// This file exists so that number cannot quietly drift back under a run that
// is known to work. It is a unit test over a constant, which is usually a
// smell; here the constant is the thing that broke.
const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (l, c, d) => {
  console.log((c ? '  PASS  ' : '  FAIL  ') + l + (d ? '   -> ' + d : ''));
  if (!c) failures++;
};

// The longest run we have actually watched finish and produce a scored audit.
const KNOWN_GOOD_SECONDS = 421;

const src = fs.readFileSync(path.join(__dirname, '..', 'runner.js'), 'utf8');

console.log('\nA. the default deadline clears a run that is known to work');
const m = /const deadline = o\.timeout \|\|[^;]*?(\d{5,})\s*;/s.exec(src);
check('the runner still has a single default deadline to check', !!m,
      m ? m[1] : 'could not find `const deadline = ...` in runner.js');

if (m) {
  const seconds = Number(m[1]) / 1000;
  check('it is longer than the longest successful run on record',
        seconds > KNOWN_GOOD_SECONDS,
        seconds + 's vs ' + KNOWN_GOOD_SECONDS + 's known good');
  // Headroom, not a hair's breadth. A site slower than Archstone's is not a
  // stuck page, and the gap between "slow" and "hung" has to be wide enough
  // that ordinary variance never lands in it.
  check('with real headroom — at least double, not a few seconds',
        seconds >= KNOWN_GOOD_SECONDS * 2,
        seconds + 's is ' + (seconds / KNOWN_GOOD_SECONDS).toFixed(1) + 'x');
  // And still finite: the deadline exists to stop a hung page holding a
  // browser and a queue lane for ever.
  check('and still bounded, so a hung page cannot hold a lane for ever',
        seconds <= 3600, seconds + 's');
}

console.log('\nB. the number can be moved without a deploy');
check('an environment variable overrides it',
      /AUDIT_RUN_TIMEOUT_MS/.test(src));
check('and an explicit per-call timeout still wins over both',
      /o\.timeout \|\|/.test(src));

console.log('\nC. the message a timeout produces is actionable');
const msg = /did not finish within[\s\S]{0,400}?\)\),/.exec(src);
check('it names the limit it hit', !!msg && /Math\.round\(deadline/.test(msg[0]));
check('it names a duration known to be healthy, so the next person does not ' +
      'repeat the mistake',
      !!msg && new RegExp(KNOWN_GOOD_SECONDS + 's').test(msg[0]),
      msg ? msg[0].slice(0, 160) : 'no timeout message found');
check('and it says which knob to turn',
      !!msg && /AUDIT_RUN_TIMEOUT_MS/.test(msg[0]));

console.log();
console.log(failures ? failures + ' check(s) failed' : 'all checks passed');
process.exit(failures ? 1 : 0);
