// "I want you to find these firms. Look in Maps, look wherever you have to."
//
// Archstone Financial is in Google Maps -- name, address, phone, category, four
// reviews, a website link -- and my_business_info answered "No Search Results".
// That endpoint matches a name against its own records, and a listing it has
// not got is not a listing Google has not got. So the lookup no longer stops
// there: it searches Maps, and then follows the link the firm put on its own
// site, because nobody links to a profile that does not exist.
process.env.DATAFORSEO_LOGIN='u'; process.env.DATAFORSEO_PASSWORD='p';
process.env.ANTHROPIC_KEY='t'; process.env.PORT='3982'; delete process.env.AUDIT_KEY;

let failures=0;
const check=(l,c,d)=>{console.log((c?'  PASS  ':'  FAIL  ')+l+(d?'   → '+d:'')); if(!c) failures++;};

const EMPTY = { status_code:20000, tasks:[{ status_code:40102, status_message:'No Search Results.' }] };
const MAPS_ITEM = { title:'Archstone Financial', address:'324 Grove St, Worcester, MA',
  phone:'+15084539800', category:'Financial planner', url:'https://archstonefinancial.net/',
  rating:{ value:4.0, votes_count:4 }, total_photos:12, cid:'10278320914561532079' };

let mode = 'maps', homepage = '<html><body>nothing here</body></html>', seen = [];
const realFetch = global.fetch;
global.fetch = async (u,o) => {
  const s = String(u);
  if (s.includes('archstonefinancial.net'))
    return new Response(homepage, {status:200, headers:{'content-type':'text/html'}});
  if (!s.includes('dataforseo.com')) return realFetch(u,o);
  const body = JSON.parse(o.body)[0];
  seen.push(s.split('/v3')[1] + ' :: ' + (body.keyword || ''));
  if (s.includes('/serp/google/maps/')) {
    if (mode === 'maps') return new Response(JSON.stringify({ status_code:20000,
      tasks:[{ status_code:20000, result:[{ items:[MAPS_ITEM] }] }]}), {status:200});
    return new Response(JSON.stringify(EMPTY), {status:200});
  }
  // my_business_info: empty by name, but answers when asked by cid.
  if (/^cid:/.test(body.keyword || ''))
    return new Response(JSON.stringify({ status_code:20000, tasks:[{ status_code:20000,
      result:[{ items:[{ title:'Archstone Financial', url:'https://archstonefinancial.net/',
        is_claimed:true, rating:{value:4.0,votes_count:4}, description:'Financial planning firm.',
        logo:'https://lh3.googleusercontent.com/logo', main_image:'https://x/img',
        category:'Financial planner' }] }] }]}), {status:200});
  return new Response(JSON.stringify(EMPTY), {status:200});
};
require('../server.js');
const get = async () => { seen = [];
  return (await realFetch('http://127.0.0.1:3982/gbp/info?name=' +
    encodeURIComponent('Archstone Financial') + '&location=' + encodeURIComponent('Worcester, MA') +
    '&url=' + encodeURIComponent('https://archstonefinancial.net'))).json(); };

setTimeout(async () => {
  console.log('\nA. Business Data is empty — Maps finds it');
  mode = 'maps';
  let d = await get();
  check('found', d.found === true, JSON.stringify(d.note || d.found));
  check('matched to this firm by its domain', d.verified === true, d.matchedOn);
  check('credited to Maps', d.source === 'maps', d.source);
  check('carries the review count', d.reviewCount === 4, String(d.reviewCount));
  check('and the rating', d.rating === 4, String(d.rating));
  check('claim status stays unmeasured — Maps does not report it',
        d.claimed === null, JSON.stringify(d.claimed));
  check('the route is reported', Array.isArray(d.route) && d.route.length >= 2,
        JSON.stringify(d.route));

  console.log('\nB. Maps empty too — the link on the firm\'s own site finds it');
  mode = 'nomaps';
  homepage = '<html><body><a href="https://maps.google.com/?cid=10278320914561532079">' +
             'Review us on Google</a></body></html>';
  d = await get();
  check('found', d.found === true, JSON.stringify(d.note || d.found));
  check('looked the cid up directly', seen.some(x => /cid:10278320914561532079/.test(x)),
        JSON.stringify(seen));
  check('and got the full record', d.claimed === true && d.hasLogo === true,
        JSON.stringify({ claimed: d.claimed, logo: d.hasLogo }));
  check('credited to the website link', d.foundVia === 'website link', d.foundVia);

  console.log('\nC. a bare link with no id still proves the listing exists');
  homepage = '<html><body><iframe src="https://www.google.com/maps/embed?pb=!1m18"></iframe></body></html>';
  d = await get();
  check('reported as existing', d.listingExists === true, JSON.stringify(d.listingExists));
  check('but never scored automatically', d.verified === false, String(d.verified));
  check('and says what to do', /tick the boxes by hand/.test(d.note||''), d.note);

  console.log('\nD. nothing anywhere — still honest about it');
  homepage = '<html><body>no listing link</body></html>';
  d = await get();
  check('not found', d.found === false, String(d.found));
  check('every route is listed', (d.route||[]).length >= 3, JSON.stringify(d.route));

  console.log(failures?`\n${failures} FAILURE(S)`:'\nall checks passed');
  process.exit(failures?1:0);
}, 700);
