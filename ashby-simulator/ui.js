/**
 * Ashby's product UI, rebuilt.
 *
 * Served from the Ashby side because it is Ashby's screen, and it reads the same store
 * the write endpoints land in — through the same POST endpoints any integration would
 * use. Nothing here imports anything from Sam.
 *
 * The chrome follows a real Ashby screenshot: a dark indigo top nav, a breadcrumb bar,
 * a left section rail, and a right rail of numbered cards. Ashby's own surfaces stay in
 * Ashby's indigo; Sam is the only teal thing on the page, which is what makes it read as
 * an integration rather than a repaint.
 *
 * Sam's presence is deliberately one card in the right rail, shaped like Ashby's own
 * AI summary block — score, a few themed lines, and a link into the detail. Four loud
 * custom-field rows would be more visible and much worse.
 */
import { SAM, TEAL } from '../shared/brand.js';
import { ENDPOINTS } from '../shared/ashby-contract.js';

const API_KEY = process.env.ASHBY_API_KEY ?? 'demo_ashby_key';

export function renderAshbyUI() {
  const cfg = JSON.stringify({
    key: Buffer.from(`${API_KEY}:`).toString('base64'),
    ep: {
      applications: ENDPOINTS.listApplications,
      candidate: ENDPOINTS.candidateInfo,
      notes: ENDPOINTS.listNotes,
      job: ENDPOINTS.jobInfo,
      stages: ENDPOINTS.listInterviewStages,
      customFields: ENDPOINTS.listCustomFields,
    },
  }).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Candidates · Ashby</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap">
<style>
  :root{
    /* Ashby's own chrome */
    --nav:#282344; --nav-2:#35305A; --indigo:#5A51D6; --indigo-soft:#EEEDFB;
    --ink:#1F2124; --soft:#6B7280; --faint:#9CA3AF;
    --rule:#E5E7EB; --hair:#F1F3F5; --paper:#fff; --ground:#F7F8F9;
    --yes:#0F7B4F; --yes-bg:#DCF5E8; --no:#A8342A; --no-bg:#FBE6E3; --mid:#8A6212; --mid-bg:#FBF0D9;
    /* the integration */
    --sam:${SAM.teal}; --sam-deep:${TEAL.deep}; --sam-ink:${TEAL.ink};
    --sam-wash:${TEAL.wash}; --sam-line:${TEAL.line};
  }
  *{box-sizing:border-box}
  html,body{height:100%}
  body{margin:0;background:var(--ground);color:var(--ink);font-size:13.5px;line-height:1.5;
    font-family:'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased}
  button{font:inherit;color:inherit;cursor:pointer;background:none;border:0}
  a{color:var(--indigo)}
  :focus-visible{outline:2px solid var(--indigo);outline-offset:2px;border-radius:4px}

  .shell{display:flex;flex-direction:column;height:100vh;overflow:hidden}

  /* ── top nav ── */
  .topnav{background:var(--nav);color:#fff;display:flex;align-items:center;gap:2px;padding:0 12px;height:46px;flex:none}
  .logo{width:30px;height:30px;border-radius:7px;background:var(--indigo);display:grid;place-items:center;
    font-weight:700;font-size:15px;margin-right:10px;flex:none}
  .topnav button.nav{padding:6px 10px;border-radius:6px;color:#D6D3EA;font-size:13px;white-space:nowrap}
  .topnav button.nav:hover{background:var(--nav-2);color:#fff}
  .topnav button.nav.on{background:var(--nav-2);color:#fff}
  .topnav .caret{opacity:.5;font-size:9px;margin-left:3px}
  .topnav .right{margin-left:auto;display:flex;align-items:center;gap:8px}
  .kbd{background:var(--nav-2);border-radius:6px;padding:5px 10px;color:#B6B1D4;font-size:12.5px;display:flex;gap:7px;align-items:center}
  .kbd .k{border:1px solid #4A447A;border-radius:3px;padding:0 4px;font-size:10.5px}
  .add{background:var(--nav-2);border-radius:6px;padding:5px 11px;color:#fff;font-size:12.5px}
  .me{display:flex;align-items:center;gap:8px;padding-left:6px}
  .me .av{width:26px;height:26px;border-radius:50%;background:#7A72C4;color:#fff;display:grid;place-items:center;
    font-size:10px;font-weight:700}
  .me .nm{font-size:12.5px;line-height:1.15}
  .me .nm small{display:block;color:#A8A3C8;font-size:11px}

  /* ── breadcrumbs ── */
  .crumbs{background:var(--paper);border-bottom:1px solid var(--rule);height:34px;display:flex;align-items:center;
    gap:7px;padding:0 16px;font-size:12.5px;color:var(--soft);flex:none;overflow:hidden}
  .crumbs .c{display:flex;align-items:center;gap:5px;white-space:nowrap}
  .crumbs .sep{color:var(--faint)}
  .crumbs button.c:hover{color:var(--indigo)}
  .crumbs .now{color:var(--ink);font-weight:500}
  .ico{width:13px;height:13px;flex:none;opacity:.6}

  .below{flex:1;display:flex;min-height:0}

  /* ── left section rail ── */
  .rail{width:186px;flex:none;background:var(--paper);border-right:1px solid var(--rule);padding:14px 10px;overflow:auto}
  .rail button{display:block;width:100%;text-align:left;padding:7px 11px;border-radius:6px;font-size:13px;
    color:var(--soft);border-left:2px solid transparent}
  .rail button.on{background:var(--indigo-soft);color:var(--indigo);font-weight:600;border-left-color:var(--indigo)}
  .rail button:hover{color:var(--ink)}
  .rail .lbl{font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--faint);
    font-weight:600;padding:16px 11px 6px}

  main{flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden}
  .scroll{flex:1;overflow:auto;padding:22px 26px}

  h1{margin:0;font-size:27px;font-weight:700;letter-spacing:-.02em}
  .pill{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:4px 11px;font-size:12.5px;
    font-weight:500;background:var(--yes-bg);color:var(--yes);margin-top:10px}
  .sub{color:var(--soft);font-size:13px;margin-top:6px}

  .toolbar{display:flex;align-items:center;gap:9px;margin:18px 0 12px;flex-wrap:wrap}
  .search{border:1px solid var(--rule);border-radius:7px;padding:7px 12px;font-size:13px;width:270px;font-family:inherit}
  .chip{border:1px solid var(--rule);border-radius:7px;padding:6px 11px;font-size:12.5px;color:var(--soft);background:var(--paper)}
  .chip.on{background:var(--nav);color:#fff;border-color:var(--nav)}
  .chip.sam{border-color:var(--sam-line);background:var(--sam-wash);color:var(--sam-ink);font-weight:600}
  .chip.warn{border-color:#E4CE9A;background:var(--mid-bg);color:var(--mid);font-weight:600;cursor:help}
  .chip.ok{border-color:#A8D8BF;background:var(--yes-bg);color:var(--yes);font-weight:600;cursor:help}
  .tcount{margin-left:auto;color:var(--faint);font-size:12.5px}

  table{width:100%;border-collapse:collapse;background:var(--paper);border:1px solid var(--rule);border-radius:9px;overflow:hidden}
  thead th{text-align:left;padding:11px 14px;font-size:12px;color:var(--soft);font-weight:600;
    background:var(--paper);border-bottom:1px solid var(--rule);white-space:nowrap;cursor:pointer;user-select:none}
  thead th .ar{opacity:.3;margin-left:4px;font-size:10px}
  thead th.sorted{color:var(--ink)} thead th.sorted .ar{opacity:1;color:var(--indigo)}
  thead th.sam{color:var(--sam-deep)}
  tbody td{padding:11px 14px;border-bottom:1px solid var(--hair);vertical-align:top}
  tbody tr:last-child td{border-bottom:none}
  tbody tr{cursor:pointer}
  tbody tr:hover td{background:#FAFAFE}
  .nm{font-weight:600}
  .em{color:var(--soft);font-size:12.5px;margin-top:1px}
  .score{display:inline-flex;align-items:center;gap:7px;border-radius:6px;padding:3px 9px;font-size:12.5px;font-weight:600}
  .score .n{opacity:.65;font-variant-numeric:tabular-nums}
  .s-yes{background:var(--yes-bg);color:var(--yes)}
  .s-mid{background:var(--mid-bg);color:var(--mid)}
  .s-no{background:var(--no-bg);color:var(--no)}
  .s-none{background:var(--hair);color:var(--faint);font-weight:500}
  .cov{color:var(--soft);font-size:12.5px;margin-top:3px}

  /* ── candidate record ── */
  .rhead{background:var(--paper);border-bottom:1px solid var(--rule);padding:18px 26px 0;flex:none}
  .rid{display:flex;align-items:flex-start;gap:14px}
  .rid .av{width:46px;height:46px;border-radius:50%;background:var(--indigo-soft);color:var(--indigo);
    display:grid;place-items:center;font-weight:700;font-size:15px;flex:none}
  .rid h1{font-size:22px}
  .rid .meta{color:var(--soft);font-size:13px;margin-top:2px}
  .rid .meta b{color:var(--ink);font-weight:600}
  .acts{margin-left:auto;display:flex;gap:8px;flex-wrap:wrap}
  .btn{border:1px solid var(--rule);border-radius:7px;padding:6px 12px;font-size:13px;background:var(--paper)}
  .btn:hover{border-color:var(--faint)}
  .btn.primary{background:var(--indigo);color:#fff;border-color:var(--indigo)}
  .btn.danger{color:var(--no);border-color:#EBD3CF}
  .tabs{display:flex;gap:4px;margin-top:16px}
  .tabs button{padding:9px 12px;font-size:13px;color:var(--soft);border-bottom:2px solid transparent}
  .tabs button.on{color:var(--ink);font-weight:600;border-bottom-color:var(--nav)}
  .tabs .dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--sam);margin-left:6px;vertical-align:2px}

  .split{flex:1;display:flex;min-height:0}
  .feed{flex:1;min-width:0;overflow:auto;padding:20px 26px}
  .rrail{width:330px;flex:none;border-left:1px solid var(--rule);background:var(--paper);overflow:auto;padding:20px}

  .rsec{display:flex;align-items:center;gap:9px;margin:22px 0 10px}
  .rsec:first-child{margin-top:0}
  .rsec .n{width:20px;height:20px;border-radius:50%;background:var(--indigo);color:#fff;display:grid;
    place-items:center;font-size:11px;font-weight:700;flex:none}
  .rsec h3{margin:0;font-size:15px;font-weight:700}
  .card{border:1px solid var(--rule);border-radius:9px;padding:13px 15px;background:var(--paper)}
  .row{display:flex;justify-content:space-between;gap:12px;padding:5px 0;font-size:13px}
  .row .k{color:var(--soft)}
  .row .v{text-align:right;overflow-wrap:anywhere}

  /* ── the integration: one card, Ashby-shaped ── */
  .samcard{border:1px solid var(--sam-line);border-radius:9px;overflow:hidden;background:var(--paper)}
  .samtop{display:flex;align-items:center;gap:8px;padding:11px 14px;background:var(--sam-wash);
    border-bottom:1px solid var(--sam-line)}
  .samtop .mk{width:19px;height:19px;border-radius:5px;background:var(--sam);color:${SAM.black};
    display:grid;place-items:center;font-size:10px;font-weight:700}
  .samtop .t{font-weight:700;font-size:13.5px;color:var(--sam-ink)}
  .samtop .tag{margin-left:auto;font-size:10px;letter-spacing:.07em;text-transform:uppercase;
    color:var(--sam-deep);font-weight:700}
  .samscore{display:flex;align-items:baseline;gap:9px;padding:14px 14px 3px}
  .samscore .big{font-size:31px;font-weight:700;letter-spacing:-.03em;line-height:1}
  .samscore .lb{font-size:12.5px;color:var(--soft)}
  .samcov{padding:0 14px 11px;font-size:12.5px;color:var(--soft)}
  .samcov b{color:var(--sam-deep)}
  .samstats{display:flex;gap:0;border-top:1px solid var(--hair)}
  .samstats div{flex:1;padding:9px 14px;font-size:12.5px}
  .samstats div+div{border-left:1px solid var(--hair)}
  .samstats .k{color:var(--faint);font-size:11.5px}
  .samstats .v{font-weight:700;margin-top:1px}
  .samthemes{border-top:1px solid var(--hair);padding:11px 14px}
  .samthemes .h{font-size:11.5px;font-weight:700;color:var(--soft);display:flex;align-items:center;gap:6px;margin:9px 0 5px}
  .samthemes .h:first-child{margin-top:0}
  .samthemes li{list-style:none;font-size:12.5px;padding:3px 0 3px 17px;position:relative;color:var(--ink)}
  .samthemes li::before{position:absolute;left:0;font-weight:700}
  .t-met li::before{content:'✓';color:var(--yes)}
  .t-miss li::before{content:'✕';color:var(--no)}
  .t-un li::before{content:'–';color:var(--mid)}
  .samthemes ul{margin:0;padding:0}
  .samfoot{border-top:1px solid var(--hair);padding:10px 14px;display:flex;gap:14px}
  .samfoot button{font-size:12.5px;color:var(--sam-deep);font-weight:600}
  .samfoot button:hover{text-decoration:underline}
  .samnone{padding:14px;font-size:12.5px;color:var(--faint);line-height:1.65}
  .samnone code{background:var(--nav);color:#fff;padding:2px 7px;border-radius:4px;font-size:11.5px}

  .file{display:flex;align-items:center;gap:11px;border:1px solid var(--rule);border-radius:8px;
    padding:10px 13px;font-size:13px;margin-bottom:9px;width:100%;text-align:left;background:var(--paper)}
  .file:hover{border-color:var(--faint)}
  .file.sam{border-color:var(--sam-line);background:var(--sam-wash)}
  .file .ic{width:24px;height:28px;border:1px solid var(--rule);border-radius:3px;flex:none;display:grid;
    place-items:center;font-size:7.5px;color:var(--soft);font-weight:700;background:#fff}
  .file .mt{margin-left:auto;color:var(--faint);font-size:12px}

  .fcard{background:var(--paper);border:1px solid var(--rule);border-radius:9px;padding:14px 16px;margin-bottom:12px}
  .item{display:flex;gap:11px}
  .iav{width:28px;height:28px;border-radius:50%;background:var(--indigo-soft);color:var(--indigo);flex:none;
    display:grid;place-items:center;font-size:10.5px;font-weight:700}
  .iav.sam{background:var(--sam);color:${SAM.black}}
  .ihead{font-size:12.5px;color:var(--soft);margin-bottom:7px}
  .ihead b{color:var(--ink);font-weight:600}
  .note{font-size:13px;line-height:1.6}
  .note p{margin:0 0 8px} .note ul{margin:0 0 8px;padding-left:19px} .note li{margin-bottom:3px}
  .composer{border:1px solid var(--rule);border-radius:9px;padding:11px 14px;color:var(--faint);
    font-size:13px;margin-bottom:14px;background:var(--paper)}

  .empty{text-align:center;color:var(--faint);font-size:13px;padding:44px 20px;line-height:1.75}
  .empty b{color:var(--soft);display:block;margin-bottom:5px}
  .empty code{background:var(--nav);color:#fff;padding:2px 7px;border-radius:4px;font-size:12px}

  .viewer{position:fixed;inset:0;background:rgba(31,33,36,.6);display:grid;place-items:center;z-index:50;padding:30px}
  .vbox{background:#3E4147;border-radius:10px;padding:14px;width:min(940px,100%);height:100%;display:flex;flex-direction:column}
  .vbar{display:flex;align-items:center;gap:10px;color:#D8DBDE;font-size:12.5px;margin-bottom:12px;flex:none}
  .vbar .n{font-weight:600;color:#fff}
  .vbar button{margin-left:auto;border:1px solid #6F747A;color:#D8DBDE;border-radius:6px;padding:4px 10px}
  .vbox iframe{flex:1;border:0;border-radius:5px;background:#fff;width:100%}

  .toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--nav);color:#fff;
    padding:10px 16px;border-radius:8px;font-size:13px;z-index:60;box-shadow:0 8px 26px rgba(0,0,0,.3)}
  .toast b{color:var(--sam)}
  @media (prefers-reduced-motion:no-preference){.toast{animation:rise .22s ease-out}}
  @keyframes rise{from{opacity:0;transform:translate(-50%,10px)}to{opacity:1;transform:translate(-50%,0)}}
</style>
</head>
<body>
<div class="shell">
  <nav class="topnav" id="topnav"></nav>
  <div class="crumbs" id="crumbs"></div>
  <div class="below"><aside class="rail" id="rail"></aside><main id="main"></main></div>
</div>
<script>
const CFG = ${cfg};

/** Every call uses Ashby's POST/Basic contract, exactly like an integration would. */
async function api(endpoint, body = {}) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Basic ' + CFG.key },
    body: JSON.stringify(body),
  });
  const p = await res.json();
  if (!p.success) throw new Error((p.errors || [{message:'Unknown error'}])[0].message);
  return p.results;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ini = (n) => n.split(/\\s+/).map(w=>w[0]).join('').slice(0,2).toUpperCase();
const $ = (s) => document.querySelector(s);
const F = { fit:'Sam Role Fit', cov:'Sam Evidence Coverage', cap:'Sam Capability Score', rank:'Sam Pool Rank' };

const state = {
  view:'pipeline', candidateId:null, tab:'Feed',
  sort:{ key:F.fit, dir:'desc' }, q:'', onlyScored:false, minFit:0,
  applications:[], job:null, stages:[], notes:[], candidate:null,
};

async function loadPipeline() {
  const [apps, job, stages] = await Promise.all([api(CFG.ep.applications), api(CFG.ep.job), api(CFG.ep.stages)]);
  state.applications = apps; state.job = job; state.stages = stages;
}
async function loadCandidate(id) {
  const [candidate, notes] = await Promise.all([api(CFG.ep.candidate,{id}), api(CFG.ep.notes,{candidateId:id})]);
  state.candidate = candidate; state.notes = notes;
}

/* ── chrome ───────────────────────────────────────────────────────────────── */
function topnav() {
  const items = ['Pipeline','Candidates','Jobs','Sourcing','Reports','Dashboards'];
  $('#topnav').innerHTML =
    '<span class="logo">A</span>'
    + '<button class="nav">⌂</button>'
    + items.map(i => '<button class="nav'+(i==='Candidates'?' on':'')+'">'+esc(i)+'<span class="caret">▾</span></button>').join('')
    + '<button class="nav">Admin</button>'
    + '<span class="right">'
    + '<button class="nav">Notifications</button>'
    + '<span class="add">+ Add ▾</span>'
    + '<span class="kbd">Search <span class="k">⌘K</span></span>'
    + '<button class="nav">⇄ Recruiting<span class="caret">▾</span></button>'
    + '<span class="me"><span class="av">EG</span><span class="nm">Elena Gorman<small>Agree</small></span></span>'
    + '</span>';
}

function crumbs() {
  const base = '<button class="c">Pipeline</button><span class="sep">›</span>'
    + '<button class="c" id="crumbJob">'+esc(state.job.title)+'</button>';
  $('#crumbs').innerHTML = state.view === 'pipeline'
    ? base + '<span class="sep">›</span><span class="c now">Application Review</span>'
    : base + '<span class="sep">›</span><button class="c" id="crumbBack">Application Review</button>'
      + '<span class="sep">›</span><span class="c now">'+esc(state.candidate.name)+'</span>';
  const back = $('#crumbBack') || $('#crumbJob');
  if (back) back.addEventListener('click', toPipeline);
}

function rail() {
  const scored = state.applications.filter(a=>a.customFields.length).length;
  const items = state.view === 'pipeline'
    ? [['Application Review',true],['All candidates',false],['Archived',false]]
    : [['Overview',true],['Activity',false],['Interviews',false],['Offers',false]];
  $('#rail').innerHTML = items.map(([t,on]) => '<button'+(on?' class="on"':'')+'>'+esc(t)+'</button>').join('')
    + '<div class="lbl">Integrations</div>'
    + '<button><span style="color:var(--sam-deep);font-weight:600">Sam</span> · '+scored+'/'+state.applications.length+'</button>';
}

/* ── pipeline ─────────────────────────────────────────────────────────────── */
const band = (fit) => fit === undefined ? null
  : fit >= 85 ? ['s-yes','Strong'] : fit >= 60 ? ['s-yes','Good'] : fit >= 35 ? ['s-mid','Mixed'] : ['s-no','Weak'];

function rows() {
  let r = state.applications.slice();
  if (state.q) { const q = state.q.toLowerCase(); r = r.filter(a=>a.candidate.name.toLowerCase().includes(q)); }
  if (state.onlyScored) r = r.filter(a=>a.customFields.length>0);
  // Filtering by a custom field value is the capability Ashby documents. This is the
  // saved-search path a hiring manager would actually build.
  if (state.minFit > 0) r = r.filter(a => (a.customFieldValues[F.fit] ?? -1) >= state.minFit);
  const { key, dir } = state.sort;
  const val = (a) => key==='name' ? a.candidate.name.toLowerCase()
    : (a.customFieldValues[key] === undefined ? null : a.customFieldValues[key]);
  r.sort((a,b) => {
    const av=val(a), bv=val(b);
    if (av===null && bv===null) return a.candidate.name.localeCompare(b.candidate.name);
    if (av===null) return 1; if (bv===null) return -1;          // unscored always sink
    if (av===bv) return a.candidate.name.localeCompare(b.candidate.name);
    return dir==='desc' ? (bv>av?1:-1) : (av>bv?1:-1);
  });
  return r;
}

function renderPipeline() {
  const list = rows();
  const scored = state.applications.filter(a=>a.customFields.length).length;
  const COLS = [['name','Candidate'],['stage','Stage'],[F.fit,'Sam Score'],[F.cap,'Capability'],[F.rank,'Pool Rank']];

  $('#main').innerHTML = '<div class="scroll">'
    + '<h1>'+esc(state.job.title)+'</h1>'
    + '<div class="pill">✓ '+state.applications.length+' in Application Review</div>'
    + '<div class="sub">'+scored+' of '+state.applications.length+' scored by Sam · '+esc(state.job.location.locationSummary)+'</div>'
    + '<div class="toolbar">'
    + '<input class="search" id="q" placeholder="Search for a candidate by name…" value="'+esc(state.q)+'">'
    + '<button class="chip sam'+(state.onlyScored?' on':'')+'" id="only">Scored by Sam</button>'
    + '<label class="chip sam" style="display:inline-flex;gap:7px;align-items:center">Sam Role Fit ≥'
    + '<select id="minFit" style="font:inherit;border:0;background:none;color:inherit;font-weight:700">'
    + [0,50,60,65,70,75].map(v=>'<option value="'+v+'"'+(state.minFit===v?' selected':'')+'>'+(v?v+'%':'any')+'</option>').join('')
    + '</select></label>'
    + '<span class="chip ok" title="Ashby documents filtering by a custom field value in Candidate Search.">'
    + 'filter · documented</span>'
    + '<span class="chip warn" title="Ashby documents custom-field columns for Projects only. '
    + 'The only documented column on Application Review is their own AI criteria percentage.">'
    + 'columns + sort · unverified</span>'
    + '<span class="tcount">'+list.length+' shown</span></div>'
    + '<table><thead><tr>' + COLS.map(([k,l]) => {
        const on = state.sort.key===k, sam = k.startsWith('Sam');
        return '<th data-k="'+esc(k)+'" class="'+(sam?'sam ':'')+(on?'sorted':'')+'">'+esc(l)
          + (k==='stage'?'':'<span class="ar">'+(on&&state.sort.dir==='asc'?'▲':'▼')+'</span>')+'</th>';
      }).join('') + '</tr></thead><tbody>'
    + list.map(a => {
        const v = a.customFieldValues, b = band(v[F.fit]);
        return '<tr data-id="'+esc(a.candidate.id)+'">'
          + '<td><div class="nm">'+esc(a.candidate.name)+'</div><div class="em">'
            + esc(a.candidate.primaryEmailAddress?a.candidate.primaryEmailAddress.value:'')+'</div></td>'
          + '<td style="color:var(--soft)">'+esc(a.currentInterviewStage.title)+'</td>'
          + '<td>' + (b
              ? '<span class="score '+b[0]+'"><span class="n">'+v[F.fit]+'%</span>'+b[1]+'</span>'
                + '<div class="cov">at '+v[F.cov]+'% coverage</div>'
              : '<span class="score s-none">Not scored</span>') + '</td>'
          + '<td>'+(v[F.cap]===undefined?'<span style="color:var(--faint)">—</span>':'<b>'+v[F.cap]+'</b><span style="color:var(--faint)">/10</span>')+'</td>'
          + '<td style="color:var(--soft)">'+(v[F.rank]===undefined?'—':esc(v[F.rank]))+'</td></tr>';
      }).join('')
    + '</tbody></table>'
    + (list.length?'':'<div class="empty"><b>No candidates match.</b>Clear the search or the Sam filter.</div>')
    + '</div>';

  $('#q').addEventListener('input', e => { state.q=e.target.value; renderPipeline(); $('#q').focus(); });
  $('#only').addEventListener('click', () => { state.onlyScored=!state.onlyScored; renderPipeline(); });
  $('#minFit').addEventListener('change', (e) => { state.minFit = Number(e.target.value); renderPipeline(); });
  document.querySelectorAll('thead th[data-k]').forEach(h => h.addEventListener('click', () => {
    const k = h.dataset.k; if (k==='stage') return;
    state.sort = state.sort.key===k ? {key:k,dir:state.sort.dir==='desc'?'asc':'desc'} : {key:k,dir:k==='name'?'asc':'desc'};
    renderPipeline();
  }));
  document.querySelectorAll('tbody tr').forEach(r => r.addEventListener('click', () => openCandidate(r.dataset.id)));
}

/* ── the integration's one card ────────────────────────────────────────────── */
function samCard(app) {
  if (!app || !app.customFields.length) {
    return '<div class="samcard"><div class="samtop"><span class="mk">S</span><span class="t">Sam Snapshot</span>'
      + '<span class="tag">Integration</span></div>'
      + '<div class="samnone">Not scored yet. Run <code>npm run trigger -- --row N</code> — '
      + 'this card fills in from Ashby a moment later.</div></div>';
  }
  const v = app.customFieldValues, b = band(v[F.fit]);
  const note = state.notes[0];
  // The anchor lines come from the note Sam actually wrote, so this card can never
  // claim something the delivered note did not say.
  const themes = { met:[], miss:[], un:[] };
  if (note && note.content.type === 'text/html') {
    const doc = new DOMParser().parseFromString(note.content.value, 'text/html');
    // Anchors ship as table rows, so read the first cell of each row.
    const firstCells = [...doc.querySelectorAll('tr')]
      .map((tr) => tr.querySelector('td'))
      .filter(Boolean);
    for (const td of firstCells) {
      const t = td.textContent.trim();
      const mark = t.charAt(0);
      if (!'\u2713\u2715\u2013~'.includes(mark)) continue;
      const label = t.slice(1).trim();
      if (!label) continue;
      if (mark === '\u2713' && themes.met.length < 3) themes.met.push(label);
      else if (mark === '\u2715' && themes.miss.length < 2) themes.miss.push(label);
      else if (mark === '\u2013' && themes.un.length < 2) themes.un.push(label);
    }
  }
  const group = (cls, head, arr) => arr.length
    ? '<div class="h">'+head+'</div><ul class="'+cls+'">'+arr.map(t=>'<li>'+esc(t)+'</li>').join('')+'</ul>' : '';

  return '<div class="samcard">'
    + '<div class="samtop"><span class="mk">S</span><span class="t">Sam Snapshot</span><span class="tag">Integration</span></div>'
    + '<div class="samscore"><span class="big">'+v[F.fit]+'%</span><span class="lb">Role Fit · '+b[1]+'</span></div>'
    + '<div class="samcov">Scored against <b>'+esc(state.job.title)+'</b> · <b>'+v[F.cov]+'% evidence coverage</b></div>'
    + '<div class="samstats"><div><div class="k">Capability</div><div class="v">'+v[F.cap]+'/10</div></div>'
    + '<div><div class="k">Pool rank</div><div class="v">'+esc(v[F.rank])+'</div></div></div>'
    + (themes.met.length||themes.miss.length||themes.un.length
        ? '<div class="samthemes">'+group('t-met','Evidenced',themes.met)
          + group('t-miss','Not evidenced',themes.miss)
          + group('t-un','Never asked',themes.un)+'</div>' : '')
    + '<div class="samfoot"><button data-goto="Files">Open Snapshot</button>'
    + '<button data-goto="Feed">Read the note</button></div></div>';
}

/* ── candidate record ─────────────────────────────────────────────────────── */
function feedTab() {
  if (!state.notes.length) {
    return '<div class="composer">Write a note…</div>'
      + '<div class="empty"><b>Nothing from Sam yet.</b>Run <code>npm run trigger -- --row N</code> and this fills in.</div>';
  }
  return '<div class="composer">Write a note…</div>' + state.notes.map(n =>
    '<div class="fcard"><div class="item"><div class="iav'+(n.author==='Sam'?' sam':'')+'">'+esc(ini(n.author))+'</div>'
    + '<div style="flex:1;min-width:0"><div class="ihead"><b>'+esc(n.author)+'</b> added a note · just now · '
    + '<span style="color:var(--faint)">'+esc(n.content.type)+'</span></div>'
    + '<div class="note">'+(n.content.type==='text/html'?n.content.value
        :'<pre style="margin:0;white-space:pre-wrap;font:inherit">'+esc(n.content.value)+'</pre>')+'</div>'
    + '</div></div></div>').join('');
}

function filesTab() {
  const c = state.candidate;
  const all = [c.resumeFileHandle, ...(c.fileHandles||[])].filter(Boolean);
  const sam = all.filter(f=>f.source==='Sam');
  return all.map(f =>
    '<button class="file'+(f.source==='Sam'?' sam':'')+'" data-file="'+esc(f.id)+'">'
    + '<span class="ic">'+(f.name.endsWith('.docx')?'DOC':'PDF')+'</span><span>'+esc(f.name)+'</span>'
    + '<span class="mt">'+(f.source==='Sam'?'added by Sam · click to open':'uploaded by the candidate')+'</span></button>').join('')
    + (sam.length?'':'<div class="empty"><b>No Snapshot attached yet.</b>Only the candidate’s own documents are here.</div>');
}

function renderRecord() {
  const c = state.candidate;
  const app = state.applications.find(a=>a.candidate.id===c.id);
  const linked = (c.socialLinks||[]).find(s=>s.type==='LinkedIn');
  const TABS = ['Feed','Files','Emails','Interviews','Offers'];
  const body = state.tab==='Feed' ? feedTab() : state.tab==='Files' ? filesTab()
    : '<div class="empty"><b>'+esc(state.tab)+'</b>Not part of this mockup.</div>';

  $('#main').innerHTML =
    '<div class="rhead"><div class="rid"><div class="av">'+esc(ini(c.name))+'</div><div>'
    + '<h1>'+esc(c.name)+'</h1><div class="meta">Considered for <b>'+esc(state.job.title)+'</b> · '
    + esc(app?app.currentInterviewStage.title:'—')+'</div></div>'
    + '<div class="acts"><button class="btn">Email</button><button class="btn">New interview</button>'
    + '<button class="btn primary">Advance</button><button class="btn danger">Archive</button></div></div>'
    + '<div class="tabs">'+TABS.map(t=>'<button data-tab="'+t+'"'+(t===state.tab?' class="on"':'')+'>'+t
        + ((t==='Feed'&&state.notes.length)||(t==='Files'&&c.fileHandles.some(f=>f.source==='Sam'))?'<span class="dot"></span>':'')
        + '</button>').join('')+'</div></div>'
    + '<div class="split"><div class="feed">'+body+'</div><aside class="rrail">'
    + '<div class="rsec"><span class="n">1</span><h3>Details</h3></div><div class="card">'
    + [['Email', c.primaryEmailAddress?esc(c.primaryEmailAddress.value):'—'],
       ['Location', c.location?esc(c.location.locationSummary):'—'],
       ['LinkedIn', linked?'<a href="'+esc(linked.url)+'" target="_blank" rel="noopener">View profile</a>':'—'],
       ['Source', c.source?esc(c.source.title):'—'],
       ['Applied', new Date(c.createdAt).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})]]
      .map(([k,v])=>'<div class="row"><span class="k">'+k+'</span><span class="v">'+v+'</span></div>').join('')
    + '</div>'
    + '<div class="rsec"><span class="n">2</span><h3>Snapshot</h3></div>' + samCard(app)
    + '</aside></div>';

  document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => { state.tab=b.dataset.tab; renderRecord(); }));
  document.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => { state.tab=b.dataset.goto; renderRecord(); }));
  document.querySelectorAll('[data-file]').forEach(b => b.addEventListener('click', () => viewFile(b.dataset.file, b.textContent.trim())));
}

function viewFile(id, label) {
  const w = document.createElement('div');
  w.className='viewer';
  w.innerHTML = '<div class="vbox"><div class="vbar"><span class="n">'+esc(label)+'</span>'
    + '<button id="x">Close</button></div><iframe src="/files/'+encodeURIComponent(id)+'" title="'+esc(label)+'"></iframe></div>';
  document.body.appendChild(w);
  const close = () => w.remove();
  w.addEventListener('click', e => { if (e.target===w) close(); });
  w.querySelector('#x').addEventListener('click', close);
  document.addEventListener('keydown', function k(e){ if(e.key==='Escape'){close();document.removeEventListener('keydown',k);} });
}

function toast(msg) {
  const t = document.createElement('div'); t.className='toast'; t.innerHTML=msg;
  document.body.appendChild(t); setTimeout(()=>t.remove(), 4200);
}

function toPipeline(){ state.view='pipeline'; state.candidateId=null; render(); }
async function openCandidate(id){ state.view='record'; state.candidateId=id; state.tab='Feed'; await loadCandidate(id); render(); }

function render() {
  topnav(); crumbs(); rail();
  if (state.view==='pipeline') renderPipeline(); else renderRecord();
}

async function refresh() {
  const before = state.applications.filter(a=>a.customFields.length).length;
  await loadPipeline();
  const after = state.applications.filter(a=>a.customFields.length).length;
  if (state.view==='record' && state.candidateId) await loadCandidate(state.candidateId);
  render();
  if (after > before) toast('<b>Sam</b> scored '+(after-before)+' new application'+(after-before>1?'s':''));
}

(async function boot(){
  try {
    await loadPipeline(); render();
    setInterval(() => refresh().catch(()=>{}), 3000);
  } catch (err) {
    document.body.innerHTML = '<div class="empty" style="padding:80px"><b>Could not reach Ashby.</b>'+esc(err.message)+'</div>';
  }
})();
</script>
</body>
</html>`;
}
