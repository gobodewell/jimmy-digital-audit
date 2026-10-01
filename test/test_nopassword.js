// Chrome offers to save a password whenever the document contains a password
// input. This page has no <form>, so Chrome scoped the implicit one to the
// whole document and paired the proxy access key with the City, State field --
// prompting to save "Houston, Texas" as a username on every run.
//
// The fix is that there is no password input at all: the key is a text input
// masked with -webkit-text-security. This pins both halves -- none exists, and
// the key still masks and still round-trips its value through save/load.
const path = require('path');
const PAGE = 'file://' + path.resolve(__dirname, '..', 'index.html');
const { chromium } = require('playwright');
let failures = 0;
const check = (l, c, d) => {
  console.log((c ? '  PASS  ' : '  FAIL  ') + l + (d ? '   → ' + d : ''));
  if (!c) failures++;
};

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await b.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(PAGE);

  console.log('\nA. nothing on the page can trigger the save-password prompt');
  const pw = await page.$$eval('input[type="password"]', els => els.map(e => e.id || e.name || '(unnamed)'));
  check('no password input anywhere', pw.length === 0, JSON.stringify(pw));
  // A <form> would scope Chrome's heuristics, but there is none -- which is why
  // a stray password field reaches across the whole document.
  const forms = await page.$$eval('form', els => els.length);
  check('and still no <form> to scope one to', forms === 0, String(forms));

  // The key lives on the Settings tab, which is hidden until it is opened.
  await page.evaluate(() => showPage('settings'));

  console.log('\nB. the access key is still masked');
  const m = await page.$eval('#s-audit', e => ({
    type: e.type,
    sec: getComputedStyle(e).webkitTextSecurity || getComputedStyle(e).getPropertyValue('-webkit-text-security'),
    auto: e.getAttribute('autocomplete')
  }));
  check('it is a text input', m.type === 'text', m.type);
  check('masked with text-security', m.sec === 'disc', m.sec || '(none)');
  check('autocomplete is off', m.auto === 'off', m.auto);

  console.log('\nC. the key still saves and loads');
  await page.fill('#s-audit', 'test-key-12345');
  const round = await page.evaluate(() => {
    saveSettings();
    const stored = localStorage.getItem('cfg_audit');
    document.getElementById('s-audit').value = '';
    loadSettings();
    return { stored, back: document.getElementById('s-audit').value };
  });
  check('written to storage', round.stored === 'test-key-12345', round.stored);
  check('read back into the field', round.back === 'test-key-12345', round.back);

  console.log('\nD. page health');
  check('zero page errors', errs.length === 0, errs.join(' | ') || 'none');
  await b.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})();
