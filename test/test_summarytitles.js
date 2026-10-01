// The cover summary and page 2 should name the same fixes in the same words.
// The summary is given the exact Action Titles page 2 will print, and told to
// quote them verbatim: a paraphrase of approved copy is unapproved copy, and it
// would also leave the two pages describing one fix in two vocabularies.
process.env.ANTHROPIC_KEY='t'; process.env.PORT='3985'; delete process.env.AUDIT_KEY;

let failures=0;
const check=(l,c,d)=>{console.log((c?'  PASS  ':'  FAIL  ')+l+(d?'   → '+d:'')); if(!c) failures++;};

let prompt=null;
const enc=new TextEncoder();
const sse=t=>new ReadableStream({start(c){
  for(const e of [{type:'content_block_start',index:0,content_block:{type:'text',text:''}},
                  {type:'content_block_delta',index:0,delta:{type:'text_delta',text:t}},
                  {type:'content_block_stop',index:0},
                  {type:'message_delta',delta:{stop_reason:'end_turn'}}])
    c.enqueue(enc.encode('data: '+JSON.stringify(e)+'\n\n'));
  c.close();
}});
const realFetch=global.fetch;
global.fetch=async(u,o)=>{
  if(!String(u).includes('anthropic.com')) return realFetch(u,o);
  prompt=JSON.parse(o.body).messages[0].content;
  return { ok:true, body: sse('A short summary.') };
};
require('../server.js');
const post=async b=>(await realFetch('http://127.0.0.1:3985/ai/summary',{method:'POST',
  headers:{'Content-Type':'application/json'},body:JSON.stringify(b)})).json();

const TITLES=['Claim a LinkedIn Page for the Firm Itself',
              'Reduce the Weight of Your Homepage',
              'Describe Your Business in Your Own Words'];

setTimeout(async()=>{
  console.log('\nA. the exact headlines reach the model');
  const d=await post({ firm:'Totus', scores:{overall:89,v:92,w:81,s:95},
    failed:[{label:'Has LinkedIn',pts:20,cat:'Social Media'}],
    metrics:{'Domain authority':13}, actionTitles:TITLES });
  check('a summary came back', !!d.summary, JSON.stringify(d).slice(0,60));
  check('every headline is in the prompt', TITLES.every(t=>prompt.includes(t)),
        TITLES.filter(t=>!prompt.includes(t)).join(' | ')||'all present');
  check('they are labelled as page 2 wording', /as page 2 prints them/.test(prompt));
  check('the rule says use them exactly', /EXACTLY as written/.test(prompt));
  check('and forbids rewording', /Do not\s+reword, shorten, expand or paraphrase/.test(prompt));
  check('and says what to do instead', /write a different\s+sentence rather than altering the headline/.test(prompt));

  console.log('\nB. the existing guardrails are untouched');
  check('still capped', /UNDER 440 CHARACTERS/.test(prompt));
  check('still facts-only', /Use ONLY the facts above/.test(prompt));
  check('still no projections or guarantees', /no guarantees/.test(prompt));

  console.log('\nC. no headlines: the prompt says nothing about them');
  await post({ firm:'Totus', scores:{overall:89}, failed:[], metrics:{} });
  check('the section is omitted entirely', !/Recommendation headlines/.test(prompt));
  check('no dangling instruction to quote nothing', !/EXACTLY as written/.test(prompt));

  console.log(failures?`\n${failures} FAILURE(S)`:'\nall checks passed');
  process.exit(failures?1:0);
},400);
