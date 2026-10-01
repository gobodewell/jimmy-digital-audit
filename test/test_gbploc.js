// "GBP not found — DataForSEO 40501: Invalid Field: 'location_name'."
//
// DataForSEO matches location_name against its own list and nothing else:
// "Houston,Texas,United States", no space after the comma, the state spelled
// out, the country on the end. The audit asks for "City, State" in free text,
// and the page used to half-normalise it -- it stripped the spaces and added
// ",United States" unless the text already said USA. So "Houston, TX" kept its
// TX and "Houston, Texas, USA" kept its USA, and both were refused. Retrying
// sent the identical string, so the retry button could never help.
//
// The proxy now owns the conversion, and falls back to the country rather than
// losing four checks when a city is genuinely not in the list.
process.env.DATAFORSEO_LOGIN='u'; process.env.DATAFORSEO_PASSWORD='p';
process.env.ANTHROPIC_KEY='test'; process.env.PORT='3987'; delete process.env.AUDIT_KEY;

let failures=0;
const check=(l,c,d)=>{console.log((c?'  PASS  ':'  FAIL  ')+l+(d?'   → '+d:'')); if(!c) failures++;};

// DataForSEO's real behaviour: one exact spelling is accepted, everything else
// is 40501. Every request is recorded so the retry can be inspected.
// Worcester is the case that was reported from the field: "Worcester, MA".
const VALID = ['Houston,Texas,United States', 'Worcester,Massachusetts,United States'];
let sent = [], listing = { title:'Totus', url:'https://totuswm.com', is_claimed:true,
                           rating:{value:4.8,votes_count:12} };
const realFetch = global.fetch;
global.fetch = async (u,o) => {
  if (!String(u).includes('dataforseo.com')) return realFetch(u,o);
  const loc = JSON.parse(o.body)[0].location_name;
  sent.push(loc);
  if (!VALID.includes(loc) && loc !== 'United States')
    return new Response(JSON.stringify({ status_code:20000, tasks:[
      { status_code:40501, status_message:"Invalid Field: 'location_name'." }]}), {status:200});
  return new Response(JSON.stringify({ status_code:20000, tasks:[
    { status_code:20000, result:[{ items:[listing] }] }]}), {status:200});
};
require('../server.js');

const get = async city => {
  sent = [];
  const r = await realFetch('http://127.0.0.1:3987/gbp/info?name=Totus&url=' +
    encodeURIComponent('https://totuswm.com') +
    (city ? '&location=' + encodeURIComponent(city) : ''));
  return r.json();
};

setTimeout(async () => {
  console.log('\nA. what a person actually types is converted, not rejected');
  for (const [typed, why] of [
    ['Houston, Texas',            'the placeholder spelling, with the space'],
    ['Houston, TX',               'a two-letter state'],
    ['Houston, tx',               'lower case'],
    ['Houston, Texas, USA',       'USA rather than United States'],
    ['Houston,Texas,United States','already canonical'],
    ['  Houston ,  Texas  ',      'stray whitespace'],
    ['Worcester, MA',             'the one reported from the field'],
    ['Worcester,MA,United States','what the old page sent for it']
  ]) {
    const d = await get(typed);
    check(`"${typed}" (${why})`, d.found === true && VALID.includes(sent[0]), sent[0] || 'none');
    check('   and it was not a fallback', d.degraded === false, String(d.degraded));
  }

  console.log('\nB. a city DataForSEO does not list falls back, it does not fail');
  const d = await get('Nowhereville, Texas');
  check('the check still returns a listing', d.found === true, JSON.stringify(d.note||''));
  check('it tried the city first', sent[0] === 'Nowhereville,Texas,United States', sent[0]);
  check('then the country', sent[1] === 'United States', sent[1]);
  check('and says so', d.degraded === true, String(d.degraded));
  check('reporting which location answered', d.searchedLocation === 'United States', d.searchedLocation);
  check('the domain match still governs scoring', d.verified === true, String(d.verified));

  console.log('\nC. no city given still works');
  const e = await get('');
  check('goes straight to the country', sent.length === 1 && sent[0] === 'United States', JSON.stringify(sent));
  check('and is found', e.found === true);

  console.log('\nD. "No Search Results" is retried wider, not surrendered to');
  // 40102 is not an error in the usual sense -- the request was understood and
  // the place accepted. But a listing is registered at one address, and a city
  // that is not where Google has it filed returns nothing while a nationwide
  // search for the same name finds it at once. Reported verbatim it read
  // "GBP not found — DataForSEO 40102: No Search Results", which told nobody
  // what had happened.
  global.fetch = async (u,o) => {
    if (!String(u).includes('dataforseo.com')) return realFetch(u,o);
    const loc = JSON.parse(o.body)[0].location_name;
    sent.push(loc);
    if (loc !== 'United States')
      return new Response(JSON.stringify({ status_code:20000, tasks:[
        { status_code:40102, status_message:'No Search Results.' }]}), {status:200});
    return new Response(JSON.stringify({ status_code:20000, tasks:[
      { status_code:20000, result:[{ items:[listing] }] }]}), {status:200});
  };
  let g = await get('Worcester, MA');
  check('the city was tried first', sent[0] === 'Worcester,Massachusetts,United States', sent[0]);
  check('then the country', sent[1] === 'United States', sent[1]);
  check('and the listing was found', g.found === true, JSON.stringify(g.note||''));
  check('marked as the wider search', g.degraded === true, String(g.degraded));

  console.log('\nE. nothing anywhere is said in words, not an error code');
  global.fetch = async (u,o) => {
    if (!String(u).includes('dataforseo.com')) return realFetch(u,o);
    sent.push(JSON.parse(o.body)[0].location_name);
    return new Response(JSON.stringify({ status_code:20000, tasks:[
      { status_code:40102, status_message:'No Search Results.' }]}), {status:200});
  };
  g = await get('Worcester, MA');
  check('not found', g.found === false, String(g.found));
  check('no raw error code in the message', !/40102/.test(g.note||''), g.note);
  check('says what was searched', /Worcester,Massachusetts,United States/.test(g.note||''), g.note);
  check('and what to do about it', /by hand|name matches/.test(g.note||''), g.note);

  console.log('\nF. a failure that is NOT about the location is not retried');
  global.fetch = async (u,o) => {
    if (!String(u).includes('dataforseo.com')) return realFetch(u,o);
    sent.push(JSON.parse(o.body)[0].location_name);
    return new Response(JSON.stringify({ status_code:20000, tasks:[
      { status_code:40200, status_message:'Payment Required.' }]}), {status:200});
  };
  const f = await get('Houston, Texas');
  check('one call only — a second would waste a credit', sent.length === 1, String(sent.length));
  check('the real reason is reported', /40200/.test(f.note||''), f.note);
  check('and it is not claimed as found', f.found === false, String(f.found));

  console.log(failures?`\n${failures} FAILURE(S)`:'\nall checks passed');
  process.exit(failures?1:0);
}, 700);
