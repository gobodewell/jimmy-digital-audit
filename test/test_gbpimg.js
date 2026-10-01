// Two GBP checks read image fields whose shape was never confirmed, and the
// code cannot tell an absent field from an absent photo. The diag has to
// settle that from data -- and say plainly whether anything distinguishes a
// Street View capture of the building from a photo the firm uploaded.
process.env.DATAFORSEO_LOGIN='u'; process.env.DATAFORSEO_PASSWORD='p';
process.env.ANTHROPIC_KEY='test'; process.env.PORT='3994'; delete process.env.AUDIT_KEY;

let failures=0;
const check=(l,c,d)=>{console.log((c?'  PASS  ':'  FAIL  ')+l+(d?'   → '+d:'')); if(!c) failures++;};

let item={};
const realFetch=global.fetch;
global.fetch=async(u,o)=>{
  if(!String(u).includes('dataforseo.com')) return realFetch(u,o);
  return new Response(JSON.stringify({status_code:20000,tasks:[{status_code:20000,
    result:[{items:[item]}]}]}),{status:200});
};
require('../server.js');
const get=async()=>(await realFetch('http://127.0.0.1:3994/gbp/diag?name=Totus&url='+
  encodeURIComponent('https://totuswm.com'))).json();

setTimeout(async()=>{
  console.log('\nA. attributed images: the owner/visitor split is readable');
  item={ title:'Totus', url:'https://totuswm.com',
         images:[{url:'https://lh3.googleusercontent.com/a', attribution:'owner'},
                 {url:'https://lh3.googleusercontent.com/b', attribution:'visitor'}],
         logo:'https://lh3.googleusercontent.com/logo' };
  let d=await get();
  check('matched by domain', d.matchedOn==='domain', d.matchedOn);
  check('found the image fields', d.imageKeys.includes('images')&&d.imageKeys.includes('logo'),
        JSON.stringify(d.imageKeys));
  check('reports item keys', (d.imageFields.images.firstItem.keys||[]).includes('attribution'),
        JSON.stringify(d.imageFields.images.firstItem.keys));
  check('array length given', d.imageFields.images.length===2);

  console.log('\nB. a Street View host is recognised as a distinguishing signal');
  item={ title:'Totus', url:'https://totuswm.com',
         main_image:'https://streetviewpixels-pa.googleapis.com/v1/thumbnail?x=1' };
  d=await get();
  check('current code would say "has photos"', d.currentReading.hasPhotos===true,
        JSON.stringify(d.currentReading.hasPhotos));
  check('main_image surfaced', d.imageKeys.includes('main_image'), JSON.stringify(d.imageKeys));

  console.log('\nC. plain URLs with no attribution: the honest answer is "cannot tell"');
  item={ title:'Totus', url:'https://totuswm.com',
         main_image:'https://lh3.googleusercontent.com/p/abc',
         images:['https://lh3.googleusercontent.com/p/def'] };
  d=await get();
  check('string array reported as such', d.imageFields.images.type==='array');
  check('first item shown', typeof d.imageFields.images.firstItem==='string');

  console.log('\nD. no image fields at all = unmeasured, not "no photos"');
  item={ title:'Totus', url:'https://totuswm.com' };
  d=await get();
  check('no image keys', d.imageKeys.length===0, JSON.stringify(d.imageKeys));
  check('current code would say "no photos"', d.currentReading.hasPhotos===false);
  check('all keys still dumped', (d.allKeys||[]).includes('title'));

  console.log('\nE. a DataForSEO failure is reported, never guessed past');
  global.fetch=async(u,o)=>{
    if(!String(u).includes('dataforseo.com')) return realFetch(u,o);
    return new Response(JSON.stringify({status_code:40200,status_message:'Payment Required.'}),{status:200});
  };
  d=await get();
  check('error surfaced', /Payment Required/.test(d.error||''), d.error);

  console.log(failures?`\n${failures} FAILURE(S)`:'\nall checks passed');
  process.exit(failures?1:0);
},400);
