/**
 * The hosted dossier page — the only Snapshot version that keeps everything.
 *
 * This is what the deep link in the Ashby note resolves to. It carries the two
 * things no in-Ashby surface can: the interview audio itself, and interactivity.
 * Everything else on the page matches the PDF field for field, so the two versions
 * can be held side by side without contradicting each other.
 */
import { SAM, TEAL, INK, STATE_COLOR } from '../../shared/brand.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const pct = (n) => `${Math.round(n * 100)}%`;

const STATE_LABEL = {
  MET: 'Met',
  PARTIAL: 'Partial',
  NOT_MET: 'Not met',
  NOT_COLLECTED: 'Not collected',
};

function anchorRow(a) {
  const c = STATE_COLOR[a.state];
  return `
    <li class="anchor">
      <span class="pip" style="background:${c.fg}"></span>
      <div class="anchor-body">
        <div class="anchor-head">
          <h4>${esc(a.label)}</h4>
          <span class="state" style="color:${c.fg};background:${c.bg}">${STATE_LABEL[a.state]}</span>
        </div>
        <p class="reason">${esc(a.reason)}</p>
        ${a.spans?.length ? `<blockquote>${esc(a.spans[0].quote)}<cite>column ${esc(a.spans[0].column)}</cite></blockquote>` : ''}
      </div>
    </li>`;
}

function audioRow(a, label) {
  return `
    <li class="audio-row">
      <div class="audio-meta"><span class="qid">${esc(a.id)}</span><span class="qlabel">${esc(label)}</span></div>
      <audio controls preload="none" src="${esc(a.url)}"></audio>
    </li>`;
}

const QUESTION_LABEL = {
  Q1: 'Startups and payments background',
  Q2: 'Selling to an Ops or Finance leader',
  Q3: 'Outbound and relationship pipeline',
  Q4: 'Invoiced volume',
  Q5: 'Outbound structure',
  Q6: 'Objection handling',
};

/** Renders the complete hosted dossier for one scored candidate. */
export function renderDossier(s) {
  const c = s.candidate;
  const initials = c.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(c.name)} — Sam Snapshot</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap">
<style>
  :root{
    --teal:${SAM.teal}; --teal-deep:${TEAL.deep}; --teal-wash:${TEAL.wash}; --teal-line:${TEAL.line};
    --black:${SAM.black}; --ink:${INK[700]}; --soft:${INK[500]}; --faint:${INK[400]};
    --rule:${INK[200]}; --wash:${INK[100]}; --paper:${INK[0]};
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--wash);color:var(--black);
    font-family:${SAM.fontStack};font-size:15px;line-height:1.6;-webkit-font-smoothing:antialiased}
  .sheet{max-width:920px;margin:0 auto;background:var(--paper);min-height:100vh;
    box-shadow:0 0 0 1px var(--rule)}
  header{background:var(--black);color:#fff;padding:26px 34px 22px;border-bottom:4px solid var(--teal)}
  .id-row{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
  .avatar{width:44px;height:44px;border-radius:50%;background:var(--teal);color:var(--black);
    display:grid;place-items:center;font-weight:700;font-size:15px;flex:none}
  h1{margin:0;font-size:25px;font-weight:700;letter-spacing:-.02em}
  .matched{color:#B9C0C1;font-size:14px;margin-top:2px}
  .matched b{color:#fff;font-weight:500}
  .pool{display:inline-block;margin-top:9px;background:rgba(78,200,194,.16);color:var(--teal);
    border:1px solid rgba(78,200,194,.4);border-radius:999px;padding:3px 11px;font-size:12px;font-weight:500}
  .scores{margin-left:auto;text-align:right}
  .big{font-size:38px;font-weight:700;line-height:1;letter-spacing:-.03em}
  .big-l{font-size:10px;letter-spacing:.13em;color:#9AA2A3;text-transform:uppercase;margin-top:3px}
  .cov{font-size:11px;color:var(--teal);font-weight:500;margin-top:5px}
  .band{font-size:12px;font-weight:700;color:var(--teal);margin-top:2px}
  main{padding:0 34px 44px}
  .next{background:var(--teal-wash);border:1px solid var(--teal-line);border-left:3px solid var(--teal);
    border-radius:0 4px 4px 0;padding:15px 18px;margin:24px 0}
  .next h3{margin:0 0 5px;font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--teal-deep)}
  .next p{margin:0;font-size:15.5px}
  section{margin-top:34px}
  section>h2{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--teal-deep);
    margin:0 0 12px;padding-bottom:7px;border-bottom:2px solid var(--teal)}
  .metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;
    background:var(--rule);border:1px solid var(--rule);border-radius:4px;overflow:hidden}
  .metric{background:var(--paper);padding:14px 16px}
  .metric .n{font-size:24px;font-weight:700;letter-spacing:-.02em}
  .metric .l{font-size:12px;color:var(--soft);margin-top:2px}
  ul{list-style:none;padding:0;margin:0}
  .anchor{display:flex;gap:12px;padding:14px 0;border-bottom:1px solid var(--rule)}
  .anchor:last-child{border-bottom:none}
  .pip{width:4px;border-radius:2px;flex:none}
  .anchor-body{flex:1;min-width:0}
  .anchor-head{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
  .anchor-head h4{margin:0;font-size:15.5px;font-weight:700}
  .state{margin-left:auto;font-size:10.5px;font-weight:700;letter-spacing:.06em;
    text-transform:uppercase;padding:2px 8px;border-radius:3px;white-space:nowrap}
  .reason{margin:4px 0 0;font-size:13.5px;color:var(--soft)}
  blockquote{margin:9px 0 0;padding:9px 13px;background:var(--wash);border-left:2px solid var(--teal);
    border-radius:0 3px 3px 0;font-size:13.5px;color:var(--ink);font-style:italic}
  blockquote cite{display:block;font-style:normal;font-size:11px;color:var(--faint);margin-top:5px}
  .chips{display:flex;flex-wrap:wrap;gap:7px}
  .chip{background:var(--teal-wash);color:var(--teal-deep);border:1px solid var(--teal-line);
    border-radius:999px;padding:4px 11px;font-size:12.5px;font-weight:500}
  .traits{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px}
  .trait{background:var(--wash);border-radius:4px;padding:11px 13px;font-size:13.5px}
  .trait.miss{color:var(--faint);text-decoration:line-through}
  .gap{padding:11px 0;border-bottom:1px solid var(--rule)}
  .gap:last-child{border-bottom:none}
  .gap b{font-size:14.5px}
  .gap p{margin:2px 0 0;font-size:13.5px;color:var(--soft)}
  .netread{font-size:15.5px;line-height:1.65}
  .audio-row{display:flex;align-items:center;gap:14px;padding:10px 0;border-bottom:1px solid var(--rule);flex-wrap:wrap}
  .audio-row:last-child{border-bottom:none}
  .audio-meta{min-width:230px}
  .qid{font-weight:700;font-size:12px;color:var(--teal-deep);margin-right:7px}
  .qlabel{font-size:13.5px;color:var(--soft)}
  audio{height:34px;flex:1;min-width:230px}
  .docs{display:flex;flex-wrap:wrap;gap:9px}
  .doc{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--rule);border-radius:4px;
    padding:9px 13px;text-decoration:none;color:var(--black);font-size:13.5px;background:var(--paper)}
  .doc:hover{border-color:var(--teal);background:var(--teal-wash)}
  .doc svg{flex:none}
  footer{border-top:1px solid var(--rule);padding:18px 34px 30px;display:flex;
    justify-content:space-between;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--faint)}
  footer b{color:var(--black)}
  a{color:var(--teal-deep)}
  :focus-visible{outline:2px solid var(--teal);outline-offset:2px;border-radius:3px}
  @media (max-width:640px){header,main,footer{padding-left:20px;padding-right:20px}.scores{margin-left:0;text-align:left}}
</style>
</head>
<body>
<div class="sheet">

<header>
  <div class="id-row">
    <div class="avatar">${esc(initials)}</div>
    <div>
      <h1>${esc(c.name)}</h1>
      <div class="matched">Matched to <b>${esc(s.role.title)}</b> · ${esc(s.role.company)}</div>
      <div class="pool">Top ${s.pool.topPercent}% of pool · ${s.pool.size} applicants</div>
    </div>
    <div class="scores">
      <div class="big">${pct(s.roleFit)}</div>
      <div class="big-l">Role fit</div>
      <div class="cov">${pct(s.coverage)} evidence coverage</div>
      <div class="band">${esc(s.band)}</div>
    </div>
  </div>
</header>

<main>
  <div class="next">
    <h3>Recommended next step</h3>
    <p>${esc(s.recommendedNextStep)}</p>
  </div>

  <section>
    <h2>Scores</h2>
    <div class="metrics">
      <div class="metric"><div class="n">${pct(s.roleFit)}</div><div class="l">Role fit, over observable anchors</div></div>
      <div class="metric"><div class="n">${pct(s.coverage)}</div><div class="l">Rubric actually observable</div></div>
      <div class="metric"><div class="n">${s.capability}/10</div><div class="l">Capability, role-independent</div></div>
      <div class="metric"><div class="n">${s.pool.roleFitRank}<span style="font-size:15px;color:var(--faint)"> of ${s.pool.size}</span></div><div class="l">Rank in this pool</div></div>
    </div>
  </section>

  <section>
    <h2>Role anchors · ${s.anchorSummary.met} met of ${s.anchorSummary.observable} observable</h2>
    <ul>${s.roleAnchors.map(anchorRow).join('')}</ul>
  </section>

  <section>
    <h2>How they work</h2>
    <div class="traits">
      ${s.capabilitySignals.met.map((t) => `<div class="trait">${esc(t)}</div>`).join('')}
      ${s.capabilitySignals.missing.map((t) => `<div class="trait miss">${esc(t)}</div>`).join('')}
    </div>
  </section>

  ${s.additionalSkills?.length ? `
  <section>
    <h2>Skills named in their responses</h2>
    <div class="chips">${s.additionalSkills.map((k) => `<span class="chip">${esc(k)}</span>`).join('')}</div>
  </section>` : ''}

  <section>
    <h2>Net read</h2>
    <p class="netread">${esc(s.netRead)}</p>
  </section>

  <section>
    <h2>Gaps to investigate</h2>
    <ul>${s.gapsToInvestigate.map((g) => `<li class="gap"><b>${esc(g.label)}</b><p>${esc(g.reason)}</p></li>`).join('')}</ul>
    ${s.caveats?.length ? `<ul style="margin-top:12px">${s.caveats.map((x) => `<li class="gap"><p>${esc(x)}</p></li>`).join('')}</ul>` : ''}
  </section>

  ${s.audioUrls?.length ? `
  <section>
    <h2>Listen to the interview</h2>
    <ul>${s.audioUrls.map((a) => audioRow(a, QUESTION_LABEL[a.id] ?? a.id)).join('')}</ul>
  </section>` : ''}

  ${c.resume ? `
  <section>
    <h2>Documents</h2>
    <div class="docs">
      <a class="doc" href="${esc(c.resume.url)}" target="_blank" rel="noopener">
        <svg width="13" height="15" viewBox="0 0 13 15" fill="none" aria-hidden="true"><path d="M1 1h7l4 4v9H1z" stroke="${TEAL.deep}" stroke-width="1.4" fill="none"/><path d="M8 1v4h4" stroke="${TEAL.deep}" stroke-width="1.4" fill="none"/></svg>
        ${esc(c.resume.name)}
      </a>
      ${(c.attachments ?? []).map((d) => `<a class="doc" href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.name)}</a>`).join('')}
    </div>
  </section>` : ''}
</main>

<footer>
  <div>Powered by <b>Sam</b> for ${esc(s.role.company)}</div>
  <div>Role fit ${pct(s.roleFit)} at ${pct(s.coverage)} coverage · every figure traces to a quoted span</div>
</footer>

</div>
</body>
</html>`;
}
