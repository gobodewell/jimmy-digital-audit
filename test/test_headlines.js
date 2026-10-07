// What counts as a benefit headline.
//
// The criterion was one line: 'are headlines benefit-based (not just
// "About Us")?'. The bar that sets is "is it different from the literal words
// About Us", and essentially everything clears it. On a real audit the model
// answered true and cited, as evidence of benefit-based headlines:
//
//   "Advanced Planning Strategies"   — a service label
//   "Schedule A Consultation"        — a call to action, scored separately
//   "Entrepreneurs & Executives"     — an audience label
//   "My Primary Purpose"             — about the firm, not the reader
//
// None of those names anything the reader gets. A benefit headline says what
// changes for them: what they will know, avoid, or be able to do.
const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (l, c, d) => {
  console.log((c ? '  PASS  ' : '  FAIL  ') + l + (d ? '   -> ' + d : ''));
  if (!c) failures++;
};

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
// The definition block handed to the model.
const def = (/- headlines:[\s\S]*?(?=\n- ctas:)/.exec(html) || [''])[0];

console.log('\nA. the criterion is about the reader, not the wording');
check('it exists and is more than one line', def.split('\n').length > 3,
      def.split('\n').length + ' lines');
check('it defines the test as an outcome the READER gets',
      /outcome the\s+READER gets/.test(def), def.slice(0, 90));
check('and says explicitly that the old bar is not the bar',
      /not "is it more interesting than About Us"/.test(def));

console.log('\nB. the four things that fooled it are named as failures');
for (const [what, probe] of [
  ['a service label',  /Advanced Planning Strategies/],
  ['a call to action', /Schedule A Consultation/],
  ['an audience label', /Entrepreneurs & Executives/],
  ['a firm-centred line', /My Primary Purpose/]
]) check(what + ' is listed as NOT counting', probe.test(def), what);

console.log('\nC. it says what a real one looks like');
check('with examples that promise a result',
      /Retire five years earlier/.test(def) && /Keep more of what you earn/.test(def));
// Whitespace-tolerant: the prompt is wrapped, so these phrases span lines.
check('and it judges the MAIN headlines, not any one good line',
      /hero and the primary section\s+headings/.test(def) &&
      /single good line under a page of\s+labels is false/.test(def));
check('a CTA is sent to the check that actually scores CTAs',
      /scored separately under ctas/.test(def));
check('and a false answer has to name the headline it read',
      /name the actual headline you read/.test(def));

console.log('\nD. the advice the client reads names the same traps');
const action = (/action:'Rewrite the main headlines[\s\S]*?\} ,?/.exec(html) ||
                /action:'Rewrite the main headlines[\s\S]*?\},/.exec(html) || [''])[0];
check('the fix text was updated too', action.length > 0);
check('it names service, audience and button as the three traps',
      /service label/.test(action) && /audience label/.test(action) &&
      /button/.test(action), action.slice(0, 120));

console.log();
console.log(failures ? failures + ' check(s) failed' : 'all checks passed');
process.exit(failures ? 1 : 0);
