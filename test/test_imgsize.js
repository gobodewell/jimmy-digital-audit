// "Images under 500KB" must mean that. It was passing whenever Lighthouse's
// optimisation lists were EMPTY -- which is a different question, and which
// also made an audit that never ran score as a pass, earning the firm ten
// points for something nobody measured.
process.env.GOOGLE_PSI_KEY='g'; process.env.DATAFORSEO_LOGIN='u';
process.env.DATAFORSEO_PASSWORD='p'; process.env.ANTHROPIC_KEY='t';
process.env.PORT='3996'; delete process.env.AUDIT_KEY;

let failures=0;
const check=(l,c,d)=>{console.log((c?'  PASS  ':'  FAIL  ')+l+(d?'   → '+d:'')); if(!c) failures++;};

const KB = 1024;
let audits = {};
const realFetch=global.fetch;
global.fetch=async(u,o)=>{
  if(!String(u).includes('pagespeedonline')) return realFetch(u,o);
  return new Response(JSON.stringify({ lighthouseResult:{ audits, categories:{} } }),{status:200});
};
require('../server.js');
const get=async()=>(await realFetch(
  'http://127.0.0.1:3996/site/lighthouse?url=https%3A%2F%2Fx.com')).json();

const img = (name, kb) => ({ url:'https://cdn.x.com/'+name, resourceType:'Image', transferSize: kb*KB });

setTimeout(async()=>{
  console.log('\nA. one image over 500KB fails the check');
  audits = { 'network-requests': { details: { items: [
    img('hero.jpg', 900), img('logo.png', 40), { url:'https://x.com/app.js', resourceType:'Script', transferSize: 900*KB }
  ] } } };
  let d = await get();
  check('does NOT pass', d.imagesOk === false, JSON.stringify(d.imagesOk));
  check('counts only the oversized image', d.imgOverCount === 1, JSON.stringify(d.imgOverCount));
  check('names it', (d.imgOver||[])[0]?.name === 'hero.jpg', JSON.stringify((d.imgOver||[])[0]));
  check('reports its size', (d.imgOver||[])[0]?.kb === 900, JSON.stringify((d.imgOver||[])[0]?.kb));
  check('ignores the oversized SCRIPT', !(d.imgOver||[]).some(x=>x.name==='app.js'));
  check('states the limit used', d.imgLimitKb === 500, JSON.stringify(d.imgLimitKb));

  console.log('\nB. several over the limit all count');
  audits = { 'network-requests': { details: { items: [
    img('a.jpg', 600), img('b.jpg', 1200), img('c.jpg', 501), img('d.jpg', 499)
  ] } } };
  d = await get();
  check('fails', d.imagesOk === false);
  check('three over, not four', d.imgOverCount === 3, JSON.stringify(d.imgOverCount));
  check('499KB is under the line', !(d.imgOver||[]).some(x=>x.name==='d.jpg'));

  console.log('\nC. all under 500KB passes');
  audits = { 'network-requests': { details: { items: [ img('a.jpg', 120), img('b.png', 300) ] } } };
  d = await get();
  check('passes', d.imagesOk === true, JSON.stringify(d.imagesOk));
  check('nothing flagged', d.imgOverCount === 0);

  console.log('\nD. exactly 500KB is not over');
  audits = { 'network-requests': { details: { items: [ img('edge.jpg', 500) ] } } };
  d = await get();
  check('500KB passes', d.imagesOk === true, JSON.stringify(d.imagesOk));

  console.log('\nE. a page with no images at all passes, because it was measured');
  audits = { 'network-requests': { details: { items: [
    { url:'https://x.com/app.js', resourceType:'Script', transferSize: 10*KB } ] } } };
  d = await get();
  check('passes', d.imagesOk === true, JSON.stringify(d.imagesOk));

  console.log('\nF. THE BUG: no per-image data must NOT pass');
  audits = { 'first-contentful-paint': { numericValue: 1000 } };
  d = await get();
  check('unmeasured, not a pass', d.imagesOk === null, JSON.stringify(d.imagesOk));

  console.log('\nG. the old optimisation list can prove a failure, never a pass');
  audits = { 'uses-optimized-images': { details: { items: [
    { url:'https://cdn.x.com/big.jpg', totalBytes: 800*KB } ] } } };
  d = await get();
  check('oversized entry fails it', d.imagesOk === false, JSON.stringify(d.imagesOk));
  audits = { 'uses-optimized-images': { details: { items: [
    { url:'https://cdn.x.com/small.jpg', totalBytes: 20*KB } ] } } };
  d = await get();
  check('small entries cannot prove a pass', d.imagesOk === null, JSON.stringify(d.imagesOk));

  console.log(failures?`\n${failures} FAILURE(S)`:'\nall checks passed');
  process.exit(failures?1:0);
},400);
