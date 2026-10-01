// Nothing was reaching Supabase: the table had 0 rows and the bucket 0 objects,
// while the PDF downloaded fine every time.
//
// The proxy sent the key on the apikey header ALONE for the new sb_secret_
// format, on the strength of a docs line saying a secret key cannot go in
// Authorization: Bearer. Checked against supabase-js, that is backwards -- it
// sets Bearer SPECIFICALLY for a new-format key, and for a legacy JWT it falls
// back to the key itself, so both formats get both headers. Storage
// authenticates on Authorization, so sending apikey alone uploaded nothing,
// and because a save stores the PDF before inserting the row, the table stayed
// empty too and it looked like the audit had never run.
process.env.ANTHROPIC_KEY='t'; process.env.PORT='3985'; delete process.env.AUDIT_KEY;
process.env.SUPABASE_URL='https://proj.supabase.co';
process.env.SUPABASE_SERVICE_KEY='sb_secret_abcd1234';

let failures=0;
const check=(l,c,d)=>{console.log((c?'  PASS  ':'  FAIL  ')+l+(d?'   → '+d:'')); if(!c) failures++;};

// A Supabase that behaves like the real one: Storage demands Authorization.
let seen = [], storageWants = 'bearer';
const realFetch = global.fetch;
global.fetch = async (u,o) => {
  const s = String(u);
  if (!s.includes('proj.supabase.co')) return realFetch(u,o);
  const h = o.headers || {};
  const hasBearer = !!(h.Authorization || h.authorization);
  const hasKey    = !!(h.apikey);
  seen.push({ path: s.replace('https://proj.supabase.co',''), hasBearer, hasKey });
  const needsBearer = s.includes('/storage/') && storageWants === 'bearer';
  if (!hasKey || (needsBearer && !hasBearer))
    return new Response('{"message":"Invalid API key"}', {status:401});
  if (s.includes('/storage/v1/object/list/'))
    return new Response('[]',{status:200,headers:{'content-type':'application/json'}});
  if (s.includes('/rest/v1/audits'))
    return new Response('[]',{status:200,headers:{
      'content-type':'application/json','content-range':'0-0/7'}});
  return new Response('[]',{status:200,headers:{'content-type':'application/json'}});
};
require('../server.js');
const diag = async () => { seen=[];
  return (await realFetch('http://127.0.0.1:3985/history/diag')).json(); };

setTimeout(async () => {
  console.log('\nA. a new-format secret key reaches BOTH stores');
  let d = await diag();
  check('the table answers', d.table === 'ok', d.table);
  check('storage answers too', d.storage === 'ok', d.storage);
  check('reported as working', d.ok === true, JSON.stringify(d.ok));
  check('and counts what is filed', d.rows === '7', JSON.stringify(d.rows));
  check('every call carried the apikey header', seen.every(c => c.hasKey), JSON.stringify(seen));
  check('and the bearer header storage needs',
        seen.filter(c => c.path.includes('/storage/')).every(c => c.hasBearer),
        JSON.stringify(seen.filter(c => c.path.includes('/storage/'))));

  console.log('\nB. the key format is identified, never echoed');
  check('named as a new secret key', /sb_secret_/.test(d.keyKind), d.keyKind);
  check('only the last four characters', d.keyTail === '…1234', d.keyTail);
  const body = JSON.stringify(d);
  check('the key itself is never in the response', !body.includes('sb_secret_abcd1234'));

  console.log('\nC. a platform that wants apikey ALONE also works');
  // The opposite of the original bug. Having been wrong in both directions,
  // the proxy tries the other combination on a 401 instead of giving up.
  storageWants = 'apikey-only';
  global.fetch = (orig => async (u,o) => {
    const s = String(u);
    if (s.includes('/storage/') && (o.headers||{}).Authorization)
      return new Response('{"message":"bearer not accepted"}',{status:401});
    return orig(u,o);
  })(global.fetch);
  d = await diag();
  check('storage still answered', d.storage === 'ok', d.storage);
  check('by retrying without the bearer',
        seen.some(c => c.path.includes('/storage/') && !c.hasBearer), JSON.stringify(seen));

  console.log(failures?`\n${failures} FAILURE(S)`:'\nall checks passed');
  process.exit(failures?1:0);
}, 700);
