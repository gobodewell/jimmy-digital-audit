// The Queue section.
//
// A button alone would have been the wrong shape: the work is "stack several,
// run them in phases, come back to a list of what is waiting". A single button
// gives you one audit and nowhere for it to land.
//
// The thing this page has to get right is that a finished RUN is not a
// finished AUDIT. Its resting state is "Needs review", and Review opens the
// run on the audit tabs so a person can fill what the server could not reach --
// a Cloudflare-fronted site is invisible to it and needs the extension.
const path=require('path');
const PAGE='file://'+path.resolve(__dirname,'..','index.html');
const { chromium }=require('playwright');
let failures=0;
const check=(l,c,d)=>{console.log((c?'  PASS  ':'  FAIL  ')+l+(d?'   -> '+d:'')); if(!c) failures++;};

const JOBS = [
  { id:'j1', client_name:'Archstone Financial', client_url:'https://archstonefinancial.net',
    client_city:'Worcester, MA', status:'needs_review', audit_id:'aud-1', measured:26,
    created_at:'2026-10-05T10:00:00Z', finished_at:'2026-10-05T10:04:00Z' },
  { id:'j2', client_name:'Totus Wealth', client_url:'https://totuswm.com',
    status:'queued', created_at:'2026-10-05T10:05:00Z' },
  { id:'j3', client_name:'Dead Site', client_url:'https://dead.example',
    status:'failed', measured:1, created_at:'2026-10-05T09:00:00Z',
    error:'the audit reached too little to score: 34 checks would have counted against this firm with nothing checked.' }
];

(async()=>{
  const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
  const page=await b.newPage();
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  await page.goto(PAGE);

  // Stub the proxy. Records what the page asks for so the calls can be checked.
  await page.evaluate(jobs => {
    window.__calls = [];
    window.pf = async (p, o) => {
      window.__calls.push({ path:p, body: o && o.body ? JSON.parse(o.body) : null });
      if (p === '/queue') return { ok:true, status:200, json: async()=>({
        jobs, running:false,
        counts:{ queued:1, running:0, needsReview:1, failed:1, approved:0 } }) };
      if (p === '/queue/add') return { ok:true, status:200, json: async()=>({ ok:true, added:1 }) };
      if (p === '/queue/run') return { ok:true, status:202, json: async()=>({
        ok:true, started:true, note:'running in the background' }) };
      if (p === '/queue/stop') return { ok:true, status:200, json: async()=>({ ok:true }) };
      if (p === '/queue/status') return { ok:true, status:200, json: async()=>({ ok:true }) };
      return { ok:true, status:200, json: async()=>({}) };
    };
  }, JOBS);

  console.log('\nA. the queue is its own place, not a button');
  const nav = await page.evaluate(()=>({
    inNav: !!document.querySelector('.nb[data-page="queue"]'),
    page: !!document.getElementById('page-queue'),
    order: [...document.querySelectorAll('.nb')].map(x=>x.dataset.page||'action')
  }));
  check('it has a nav entry', nav.inNav);
  check('and a page of its own', nav.page);
  check('sitting between the audit and history', nav.order.join('>')==='action>audit>queue>history>settings',
        nav.order.join(' > '));

  console.log('\nB. it shows what is waiting, running and failed');
  await page.evaluate(()=>showPage('queue'));
  await page.waitForTimeout(150);
  const view = await page.evaluate(()=>({
    counts: document.getElementById('q-counts').textContent.replace(/\s+/g,' ').trim(),
    rows: document.querySelectorAll('#q-list > div').length,
    text: document.getElementById('q-list').textContent.replace(/\s+/g,' '),
    nav: document.getElementById('nav-queue').textContent,
    active: [...document.querySelectorAll('.nb')].filter(x=>x.classList.contains('active'))
              .map(x=>x.dataset.page)
  }));
  check('every job is listed', view.rows===3, String(view.rows));
  check('the counts are shown', /1 Waiting/.test(view.counts) && /1 Needs review/.test(view.counts),
        view.counts);
  check('the nav says what needs a person', /1 waiting for review/.test(view.nav), view.nav);
  check('only the queue nav item is lit', view.active.join(',')==='queue', view.active.join(','));
  check('a firm shows its city, so GBP gaps make sense', /Worcester, MA/.test(view.text));
  // How much the run rested on measurement: a reviewer wants to know which
  // ones need the most filling in before opening them.
  check('and how much was actually measured', /26 measured/.test(view.text));

  console.log('\nC. a failed run shows WHY, and can be retried');
  check('the reason is on screen, not hidden',
        /reached too little to score/.test(view.text), 'the failure reason');
  const btns = await page.evaluate(()=>[...document.querySelectorAll('#q-list button')]
    .map(x=>x.textContent.trim()));
  check('a failed job can be requeued', btns.includes('Try again'), btns.join(', '));
  check('a finished run offers Review, not Download',
        btns.includes('Review') && !btns.includes('Download'), btns.join(', '));
  // The whole design: the queue never produces a document. A run is not an
  // audit until a person has filled the gaps.
  check('nothing offers to deliver anything', !/Deliver|Send|Email/i.test(view.text));

  console.log('\nD. adding and running go to the right places');
  const add = await page.evaluate(async()=>{
    window.__calls=[];
    document.getElementById('q-name').value='New Firm';
    document.getElementById('q-url').value='https://newfirm.com';
    document.getElementById('q-city').value='Austin, TX';
    await queueAdd();
    return { calls: window.__calls.map(c=>c.path),
             sent: (window.__calls.find(c=>c.path==='/queue/add')||{}).body,
             cleared: ['q-name','q-url','q-city'].every(id=>!getVal(id)),
             msg: document.getElementById('q-add-msg').textContent };
  });
  check('it posts to /queue/add', add.calls.includes('/queue/add'), add.calls.join(', '));
  check('with all three fields', add.sent && add.sent.clientName==='New Firm' &&
        /newfirm/.test(add.sent.clientUrl) && add.sent.clientCity==='Austin, TX');
  check('the form clears afterwards', add.cleared);
  check('and it reloads the list', add.calls.filter(c=>c==='/queue').length>0);

  const noUrl = await page.evaluate(async()=>{
    window.__calls=[]; await queueAdd();
    return { calls: window.__calls.length, msg: document.getElementById('q-add-msg').textContent };
  });
  check('an empty URL never reaches the proxy', noUrl.calls===0 && /URL/.test(noUrl.msg), noUrl.msg);

  console.log('\nE. starting the queue returns at once and then watches');
  // The first version held the request open for the whole phase. A phase is
  // six audits at two at a time, so it sent nothing for ten minutes and the
  // platform cut it as dead -- the real attempt died before a single job was
  // even claimed. The proxy answers immediately now and the page polls.
  const run = await page.evaluate(async()=>{
    window.__calls=[]; await queueRun();
    return { calls: window.__calls.map(c=>c.path),
             msg: document.getElementById('q-run-msg').textContent,
             polling: queueWatching() };
  });
  check('it posts to /queue/run', run.calls.includes('/queue/run'));
  check('and reads the queue straight after', run.calls.includes('/queue'));
  check('it says it is running, not that it finished', /Running/.test(run.msg), run.msg);
  check('and it starts watching', run.polling);

  console.log('\nF. the button follows the server, not this tab');
  // A drain started in another tab, or before a refresh, is still a drain.
  const live = await page.evaluate(async()=>{
    const jobs=[{id:'x',client_name:'Running Firm',client_url:'https://x.com',
                 status:'running',created_at:'2026-10-05T10:00:00Z'}];
    window.pf = async (p,o) => p==='/queue'
      ? { ok:true, status:200, json: async()=>({ jobs, running:true,
          counts:{queued:0,running:1,needsReview:0,failed:0,approved:0} }) }
      : { ok:true, status:200, json: async()=>({ ok:true }) };
    await queueLoad();
    const b=document.getElementById('q-run-btn');
    return { label: b.textContent.trim(), isStop: b.onclick === window.queueStop };
  });
  check('it offers to stop while a phase is running', /stop after these/i.test(live.label),
        live.label);
  // Not a kill: a half-written audit is worse than a slow one.
  check('and stopping is what it does', live.isStop);

  const idle = await page.evaluate(async()=>{
    window.pf = async (p) => p==='/queue'
      ? { ok:true, status:200, json: async()=>({ jobs:[], running:false,
          lastDrain:{ran:4,needsReview:3,failed:1},
          counts:{queued:0,running:0,needsReview:0,failed:0,approved:0} }) }
      : { ok:true, status:200, json: async()=>({}) };
    document.getElementById('q-run-msg').textContent='';
    const keep = await queueLoad();
    return { label: document.getElementById('q-run-btn').textContent.trim(),
             msg: document.getElementById('q-run-msg').textContent, keep };
  });
  check('it goes back to Run when nothing is moving', idle.label==='Run the next phase', idle.label);
  // A page opened after the fact should still say what happened, rather than
  // looking like nothing ever ran.
  check('and reports the last phase', /4 ran/.test(idle.msg) && /1 failed/.test(idle.msg), idle.msg);
  check('polling stops when the queue goes quiet', idle.keep===false);

  console.log('\nG. the page explains the pacing, because it looks slow on purpose');
  const copy = await page.evaluate(()=>document.getElementById('page-queue').textContent.replace(/\s+/g,' '));
  check('it says two at a time', /two at a time/i.test(copy));
  check('it says why', /browsers, not web requests/i.test(copy));
  // Was /two to four minutes/. That figure was wrong and this test was holding
  // it in place: the only unattended run ever measured took 421 seconds, and
  // the same wrong number in runner.js set a 420s deadline that killed a real
  // audit. Copy that understates how long a run takes is not a cosmetic error.
  check('and warns honestly how long a phase takes',
        /seven minutes/i.test(copy) && /fifteen/i.test(copy), copy.slice(0, 200));
  check('and that nothing is delivered at the end', /waits below for a person/i.test(copy));
  // A \u2014 in MARKUP is printed literally: HTML does not interpret the escape,
  // only JavaScript string literals do. One of these shipped on the Export tab
  // for two days before a screenshot caught it.
  check('no unicode escape is showing as text', !/\\u[0-9a-f]{4}/i.test(copy),
        (copy.match(/\\u[0-9a-f]{4}/i)||['none'])[0]);
  const whole = await page.evaluate(()=>document.body.innerText);
  check('and none anywhere else on the page either', !/\\u[0-9a-f]{4}/i.test(whole),
        (whole.match(/.{0,25}\\u[0-9a-f]{4}.{0,25}/i)||['none'])[0]);

  console.log('\nH. page health');
  check('zero page errors', errs.length===0, errs.join(' | ')||'none');

  await b.close();
  console.log(failures?`\n${failures} FAILURE(S)`:'\nall checks passed');
  process.exit(failures?1:0);
})();
