/**
 * The deliverable: how a graded candidate gets into Ashby.
 *
 * Three surfaces, shown in the place each one actually lands — starting with the
 * pipeline list, because that is where a recruiter triages and the whole reason to
 * write scores into Ashby's own fields.
 *
 *   node scripts/build-canvas.js <out.html> [row]
 */
import { writeFileSync } from 'node:fs';
import { loadPool } from '../shared/seed/survey.js';
import { scorePool } from '../sam-integration/services/calibrate.js';
import { buildSnapshot } from '../sam-integration/render/model.js';
import { PLACEMENT_VERSIONS, DISPLAY_VERSIONS, DATA_VERSION, REFUSED, singlePointFields } from '../sam-integration/placements/registry.js';
import { SNAPSHOT_FIELDS, FIELD_BY_ID } from '../sam-integration/placements/fields.js';
import { STAGES, DELIVERABLES } from '../sam-integration/delivery/pipeline.js';
import { SAM, TEAL, INK, STATE_COLOR } from '../shared/brand.js';
import { VIEWPORT, PLACEMENT_SLOTS } from '../ashby-simulator/ui-spec.js';
import { ashbyScreen, ashbyPipeline, ASHBY_CSS, PIPELINE_CSS, esc, pct } from './ashby-screen.js';
import {
  PANE_CSS, documentPane, notePane, fieldsSummaryExtra, quietFeedPane,
} from './placement-panes.js';
import { OPEN_QUESTIONS, HIGH_RISK } from './questions.js';
import { renderDossier } from '../sam-integration/render/dossier.js';

const SURVEY = 'data/survey_agree.com_business_development_representative.xlsx';
const OUT = process.argv[2] ?? 'ashby-simulator/output/canvas.html';
const ROW = Number(process.argv[3] ?? 6);
const DOSSIER = 'https://sam.app/dossier/aditya-alapati';

const scored = scorePool(loadPool(SURVEY));
const entry = scored.find((e) => e.response.rowNumber === ROW);
const s = buildSnapshot(entry.score, entry.response);
const c = s.candidate;

/** The pipeline rows, exactly as Ashby would sort them on Sam Role Fit. */
const rows = scored
  .slice()
  .sort((a, b) => a.score.pool.roleFitRank - b.score.pool.roleFitRank)
  .slice(0, 12)
  .map((e) => ({
    name: e.response.name,
    roleFit: Math.round(e.score.roleFit * 100),
    coverage: Math.round(e.score.coverage * 100),
    capability: e.score.capability,
    rank: `${e.score.pool.roleFitRank} of ${e.score.pool.size}`,
  }));

const SCALE = 0.72;
const SCALED_H = Math.round(VIEWPORT.height * SCALE);

function screenFor(id) {
  const base = { candidate: c, tags: [] };
  switch (id) {
    case 'fields': return ashbyScreen({
      ...base,
      activeTab: 'Feed',
      summaryExtra: fieldsSummaryExtra(s),
      feed: quietFeedPane('Nothing from Sam in the feed.<br>The scores are in the Summary rail — and, more importantly, in the pipeline above.'),
    });
    case 'note': return ashbyScreen({ ...base, activeTab: 'Feed', feed: notePane(s, DOSSIER) });
    case 'document': return ashbyScreen({ ...base, activeTab: 'Files', feed: documentPane(s) });
    default: return '';
  }
}

function stage(inner, label, slotLabel, estimated) {
  return `
  <div class="stage">
    <div class="stage-label">
      ${esc(label)}
      <span class="slot">${esc(slotLabel)}</span>
      ${estimated ? '<span class="est">placement estimated</span>' : ''}
    </div>
    <div class="stage-frame" style="height:${SCALED_H}px">
      <div class="stage-inner" style="transform:scale(${SCALE})">${inner}</div>
    </div>
  </div>`;
}

function versionBlock(p, i) {
  const slot = PLACEMENT_SLOTS[p.id] ?? {};
  return `
  <section class="version" id="v-${p.id}">
    <div class="v-head">
      <div class="v-num">${p.kind === 'display' ? String.fromCharCode(65 + i) : 'DATA'}</div>
      <div class="v-title">
        <h2>${esc(p.name)}</h2>
        <p class="v-sub">${p.kind === 'display' ? `rendered by <b>${esc(p.renderedBy)}</b>` : '<b>Not a display — the score as typed data</b>'} · <code>${esc(p.endpoint)}</code> → ${esc(p.appearsOn)}</p>
      </div>
      <div class="v-fid">
        <div class="v-fid-n">${p.fidelity}%</div>
        <div class="v-fid-l">of the Snapshot survives</div>
      </div>
    </div>
    ${stage(screenFor(p.id),
    `Ashby candidate record · ${VIEWPORT.width}×${VIEWPORT.height} at ${Math.round(SCALE * 100)}%`,
    slot.label ?? p.tab, slot.confirmed === false)}
    <div class="v-cols">
      <div class="v-note"><h4>What this is</h4><p>${esc(p.caveat)}</p></div>
      <div class="v-lost">
        <h4>${p.lost.length ? `Not carried here · ${p.lost.length}` : 'Nothing is lost'}</h4>
        ${p.lost.length
    ? `<ul>${p.lost.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`
    : '<p class="ok">Every field in the design survives.</p>'}
      </div>
    </div>
  </section>`;
}

function matrix() {
  const groups = [...new Set(SNAPSHOT_FIELDS.map((f) => f.group))];
  return `
  <div class="scroll">
    <table class="mx">
      <thead>
        <tr><th class="fld">Snapshot field</th>
        ${PLACEMENT_VERSIONS.map((p) => `<th class="col"><span>${esc(p.name)}</span><b>${p.fidelity}%</b></th>`).join('')}</tr>
      </thead>
      <tbody>
        ${groups.map((g) => `
          <tr class="grp"><td colspan="${PLACEMENT_VERSIONS.length + 1}">${esc(g)}</td></tr>
          ${SNAPSHOT_FIELDS.filter((f) => f.group === g).map((f) => `
            <tr><td class="fld">${esc(f.label)}</td>
            ${PLACEMENT_VERSIONS.map((p) => `<td class="cell ${p.survives.includes(f.id) ? 'yes' : 'no'}">${p.survives.includes(f.id) ? '●' : '·'}</td>`).join('')}
            </tr>`).join('')}`).join('')}
      </tbody>
    </table>
  </div>`;
}

const orphans = fieldsNoPlacementCarriesSafe();
function fieldsNoPlacementCarriesSafe() {
  const covered = new Set(PLACEMENT_VERSIONS.flatMap((p) => p.survives));
  return SNAPSHOT_FIELDS.filter((f) => !covered.has(f.id)).map((f) => f.label);
}
const single = singlePointFields().map((id) => FIELD_BY_ID.get(id)?.label ?? id);

const html = `<title>Candidates into Ashby</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap">
<style>
:root{
  --teal:${SAM.teal}; --teal-deep:${TEAL.deep}; --teal-ink:${TEAL.ink};
  --teal-wash:${TEAL.wash}; --teal-line:${TEAL.line};
  --black:${SAM.black}; --ink:${INK[700]}; --soft:${INK[500]}; --faint:${INK[400]};
  --rule:${INK[200]}; --wash:${INK[100]}; --paper:${INK[0]};
  --met:${STATE_COLOR.MET.fg}; --miss:${STATE_COLOR.NOT_MET.fg}; --uncoll:${STATE_COLOR.NOT_COLLECTED.fg};
  --miss-bg:${STATE_COLOR.NOT_MET.bg}; --uncoll-bg:${STATE_COLOR.NOT_COLLECTED.bg};
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --black:#F2F4F4; --ink:#C8CECF; --soft:#9AA2A3; --faint:#7C8487;
  --rule:#2B3133; --wash:#171A1B; --paper:#101314;
  --teal-wash:#12312F; --teal-line:#2A6360; --teal-deep:#6FD5CF; --teal-ink:#A8E6E2;
}}
:root[data-theme="dark"]{
  --black:#F2F4F4; --ink:#C8CECF; --soft:#9AA2A3; --faint:#7C8487;
  --rule:#2B3133; --wash:#171A1B; --paper:#101314;
  --teal-wash:#12312F; --teal-line:#2A6360; --teal-deep:#6FD5CF; --teal-ink:#A8E6E2;
}
*{box-sizing:border-box}
body{margin:0;background:var(--wash);color:var(--black);
  font-family:${SAM.fontStack};font-size:15.5px;line-height:1.6;-webkit-font-smoothing:antialiased}
.wrap{max-width:1140px;margin:0 auto;padding:0 24px 110px}
.col{max-width:760px}
h1,h2,h3,h4{margin:0;text-wrap:balance}
p{margin:0}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.86em;
  background:var(--teal-wash);color:var(--teal-deep);padding:1px 5px;border-radius:3px}
a{color:var(--teal-deep)}
:focus-visible{outline:2px solid var(--teal);outline-offset:3px;border-radius:3px}

.mast{background:var(--black);color:#fff;margin:0 -24px 46px;padding:52px 24px 40px;border-bottom:5px solid var(--teal)}
.mast-in{max-width:1140px;margin:0 auto;padding:0 24px}
.eyebrow{font-size:11.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--teal);font-weight:700}
.mast h1{font-size:clamp(34px,5vw,52px);font-weight:700;letter-spacing:-.03em;line-height:1.04;margin:15px 0 0;color:#fff}
.mast .dek{font-size:18px;color:#B4BBBC;margin-top:16px;max-width:680px}
.mast .meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:26px}
.mast .tag{font-size:11.5px;color:#C8CFD0;border:1px solid #33393B;border-radius:999px;padding:4px 11px}

section.doc{margin-top:66px}
.sec-h{display:flex;align-items:baseline;gap:12px;border-bottom:2px solid var(--teal);padding-bottom:8px;margin-bottom:22px}
.sec-h h2{font-size:23px;font-weight:700;letter-spacing:-.02em}
.sec-h .n{font-size:12px;font-weight:700;color:var(--teal-deep);letter-spacing:.08em}
.lede{font-size:17px;color:var(--ink)}
.stack{display:flex;flex-direction:column;gap:14px}

.ship{display:grid;grid-template-columns:repeat(3,1fr);gap:13px;margin:24px 0}
.ship-card{background:var(--paper);border:1px solid var(--teal);border-radius:6px;padding:16px 18px}
.ship-card .k{font-size:10.5px;letter-spacing:.11em;text-transform:uppercase;color:var(--teal-deep);font-weight:700}
.ship-card h3{font-size:17px;font-weight:700;margin:6px 0 3px}
.ship-card .ep{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:var(--faint);margin-bottom:8px}
.ship-card p{font-size:14px;color:var(--ink)}
@media(max-width:860px){.ship{grid-template-columns:1fr}}

.flow{margin:22px 0;border:1px solid var(--rule);border-radius:6px;overflow:hidden;background:var(--paper)}
.flow-row{display:grid;grid-template-columns:38px 1fr 250px;gap:14px;align-items:center;
  padding:10px 16px;border-bottom:1px solid var(--rule);font-size:14px}
.flow-row:last-child{border-bottom:none}
.flow-row .n{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:var(--faint);font-weight:600}
.flow-row .pr{font-size:11.5px;color:var(--faint);text-align:right;font-family:ui-monospace,Menlo,monospace}
.flow-row.deliver{background:var(--teal-wash)}
.flow-row.deliver .lb{font-weight:700}
.flow-row.deliver .pr{color:var(--teal-deep);font-weight:700}

.version{margin-top:66px;scroll-margin-top:16px}
.v-head{display:flex;align-items:flex-start;gap:16px;margin-bottom:16px}
.v-num{font-size:12px;font-weight:700;color:var(--teal-deep);letter-spacing:.08em;padding-top:7px}
.v-title{flex:1;min-width:0}
.v-title h2{font-size:25px;font-weight:700;letter-spacing:-.022em}
.v-sub{font-size:13.5px;color:var(--soft);margin-top:4px}
.v-fid{text-align:right;flex:none}
.v-fid-n{font-size:31px;font-weight:700;letter-spacing:-.03em;line-height:1;color:var(--teal-deep)}
.v-fid-l{font-size:11px;color:var(--faint);margin-top:2px}

.stage{border:1px solid var(--rule);border-radius:7px;overflow:hidden;background:var(--paper)}
.stage-label{display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:11.5px;color:var(--faint);
  padding:9px 14px;border-bottom:1px solid var(--rule);background:var(--wash)}
.stage-label .slot{margin-left:auto;color:var(--teal-deep);font-weight:600}
.stage-label .est{color:var(--uncoll);font-weight:600}
.stage-frame{overflow:hidden;position:relative}
.stage-inner{transform-origin:top left;width:${VIEWPORT.width}px}

.v-cols{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--rule);
  border:1px solid var(--rule);border-top:none;border-radius:0 0 7px 7px;overflow:hidden}
.v-cols>div{background:var(--paper);padding:15px 17px}
.v-cols h4{font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin-bottom:8px}
.v-note p{font-size:14.5px;color:var(--ink)}
.v-lost h4{color:var(--miss)}
.v-lost ul{margin:0;padding-left:17px;font-size:13.5px;color:var(--soft);columns:2;column-gap:20px}
.v-lost li{margin-bottom:3px;break-inside:avoid}
.v-lost .ok{font-size:14.5px;color:var(--met)}
@media(max-width:820px){.v-cols{grid-template-columns:1fr}.v-lost ul{columns:1}}

.scroll{overflow-x:auto;border:1px solid var(--rule);border-radius:6px;background:var(--paper);margin:22px 0}
table.mx{border-collapse:collapse;width:100%;font-size:13.5px}
table.mx th,table.mx td{padding:8px 12px;border-bottom:1px solid var(--rule);text-align:left}
table.mx thead th{background:var(--wash);font-size:11px;vertical-align:bottom;line-height:1.3}
table.mx thead th.col{text-align:center;width:150px}
table.mx thead th.col span{display:block;color:var(--soft);font-weight:500}
table.mx thead th.col b{display:block;font-size:15px;color:var(--teal-deep);margin-top:3px}
table.mx td.fld{color:var(--ink);white-space:nowrap}
table.mx tr.grp td{background:var(--wash);font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;
  color:var(--faint);font-weight:700}
td.cell{text-align:center;font-size:17px;line-height:1}
td.cell.yes{color:var(--teal)}
td.cell.no{color:var(--rule)}
tbody tr:last-child td{border-bottom:none}

.refused{background:var(--paper);border:1px solid var(--miss);border-left:4px solid var(--miss);
  border-radius:0 6px 6px 0;padding:17px 19px;margin:22px 0}
.refused h4{font-size:17px;font-weight:700;margin-bottom:3px;color:var(--miss)}
.refused .ep{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--faint);margin-bottom:8px}
.refused p{font-size:15px;color:var(--ink)}

.q{background:var(--paper);border:1px solid var(--rule);border-left:3px solid var(--uncoll);
  border-radius:0 5px 5px 0;padding:15px 17px;margin-bottom:11px}
.q .topic{font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--uncoll);font-weight:700}
.q h4{font-size:16px;font-weight:700;margin:5px 0}
.q p{font-size:14px;color:var(--soft)}
.q p+p{margin-top:6px}
.q .ask{color:var(--black);font-weight:500}

.call{background:var(--teal-wash);border:1px solid var(--teal-line);border-radius:6px;padding:18px 20px;margin:24px 0}
.call h4{color:var(--teal-ink);font-size:12px;letter-spacing:.08em;text-transform:uppercase;margin-bottom:8px}
.call p{font-size:15.5px;color:var(--ink)}
.call p+p{margin-top:9px}
footer{margin-top:80px;padding-top:20px;border-top:1px solid var(--rule);font-size:13px;color:var(--faint)}
.ab{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:26px 0}
.ab-card{display:block;background:var(--paper);border:1px solid var(--teal);border-radius:8px;
  padding:20px 22px;text-decoration:none;color:inherit}
.ab-card:hover{background:var(--teal-wash)}
.ab-k{font-size:11px;letter-spacing:.13em;text-transform:uppercase;color:var(--teal-deep);font-weight:700}
.ab-card h3{font-size:22px;font-weight:700;margin:7px 0 3px;letter-spacing:-.02em}
.ab-by{font-size:13.5px;color:var(--soft)}
.ab-by b{color:var(--black)}
.ab-fid{margin:13px 0 4px;font-size:12.5px;color:var(--faint)}
.ab-fid .n{font-size:30px;font-weight:700;color:var(--teal-deep);letter-spacing:-.03em;margin-right:7px;
  font-variant-numeric:tabular-nums}
.ab-ep{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--faint);margin:8px 0 6px}
.ab-card p{font-size:14px;color:var(--ink)}
@media(max-width:800px){.ab{grid-template-columns:1fr}}
td.cmp{font-size:14px;color:var(--ink);vertical-align:top}
.browser{width:${VIEWPORT.width}px;height:${VIEWPORT.height}px;background:#fff;display:flex;
  flex-direction:column;border:1px solid var(--rule);border-radius:8px;overflow:hidden}
.browser-bar{display:flex;align-items:center;gap:7px;padding:9px 13px;background:#E8EAED;flex:none}
.browser-bar .dot{width:11px;height:11px;border-radius:50%}
.browser-bar .dot.r{background:#F05C51}.browser-bar .dot.y{background:#F5BE4F}.browser-bar .dot.g{background:#5FC454}
.browser-bar .url{flex:1;margin-left:9px;background:#fff;border-radius:14px;padding:4px 13px;
  font-size:12px;color:#5F6368;font-family:ui-monospace,Menlo,monospace}
.browser-body{flex:1;overflow:hidden}
td.cmp b{color:var(--black)}

/* ── Ashby's own chrome, rebuilt ── */
${ASHBY_CSS}
${PIPELINE_CSS}
/* ── the Sam surfaces dropped into it ── */
${PANE_CSS}
</style>

<div class="mast">
  <div class="mast-in">
    <div class="eyebrow">Build 1 · Ashby integration · Step 03</div>
    <h1>Two ways Sam appears in Ashby</h1>
    <p class="dek">The same graded read, displayed two ways — and the difference between them
      is not polish. It is who does the rendering.</p>
    <div class="meta">
      <span class="tag">2 display versions</span>
      <span class="tag">1 data layer</span>
      <span class="tag">${scored.length} candidates graded</span>
      <span class="tag">${esc(c.name)} · rank ${s.pool.roleFitRank} of ${s.pool.size}</span>
      <span class="tag">${OPEN_QUESTIONS.length} questions for Ashby</span>
    </div>
  </div>
</div>

<div class="wrap">

<div class="col stack">
  <p class="lede">Sam holds the candidate's interview answers and their resume, grades them
    against the job description, and writes the result through Ashby's own endpoints. There
    are exactly two ways that read can be <b>displayed</b> on a candidate record, and they sit
    at opposite ends of one trade.</p>
</div>

<div class="ab">
  ${DISPLAY_VERSIONS.map((p, i) => `
    <a class="ab-card" href="#v-${p.id}">
      <div class="ab-k">Version ${String.fromCharCode(65 + i)}</div>
      <h3>${esc(p.name)}</h3>
      <div class="ab-by">rendered by <b>${esc(p.renderedBy)}</b></div>
      <div class="ab-fid"><span class="n">${p.fidelity}%</span> of the Snapshot survives</div>
      <div class="ab-ep">${esc(p.endpoint)}</div>
      <p>${esc(p.appearsOn)}</p>
    </a>`).join('')}
</div>

<div class="scroll">
  <table class="mx">
    <thead><tr><th class="fld"></th>
      ${DISPLAY_VERSIONS.map((p, i) => `<th class="col"><span>Version ${String.fromCharCode(65 + i)}</span><b>${esc(p.name.replace(' in the feed', '').replace('Snapshot as a ', ''))}</b></th>`).join('')}
    </tr></thead>
    <tbody>
      <tr><td class="fld">Who draws it</td><td class="cmp">Ashby, in its house style</td><td class="cmp">Sam, exactly as designed</td></tr>
      <tr><td class="fld">What we send</td><td class="cmp">HTML content</td><td class="cmp">A finished PDF</td></tr>
      <tr><td class="fld">API calls</td><td class="cmp">1</td><td class="cmp">3 — handle, upload, attach</td></tr>
      <tr><td class="fld">Where it lands</td><td class="cmp">Activity feed, the default tab</td><td class="cmp">Files list, in the document viewer</td></tr>
      <tr><td class="fld">Effort to read it</td><td class="cmp"><b>None — it is just there</b></td><td class="cmp">One click to open</td></tr>
      <tr><td class="fld">Design survives</td><td class="cmp">No — structure only</td><td class="cmp"><b>Every pixel</b></td></tr>
      <tr><td class="fld">Stays current</td><td class="cmp">Re-scoring writes a new note</td><td class="cmp">Frozen; a re-score is a second file</td></tr>
    </tbody>
  </table>
</div>

<div class="call col">
  <h4>Why both, rather than a winner</h4>
  <p><b>Version A</b> is the one that actually gets read, because the feed is where a reviewer
    already is. Ashby renders embedded tables natively, so the anchors, the quoted evidence and
    the coverage gaps all survive as real tables — it carries the reasoning, just not the brand.</p>
  <p><b>Version B</b> is the Snapshot as designed, and it is the only version where the layout,
    the typography and the Sam brand survive intact. It is also a PDF, and a PDF in a Files tab
    is opened when someone has already decided the candidate is worth the click.</p>
  <p>So A gets read and B gets studied. The note links to the document by name, which is what
    turns two versions into one path rather than two competing ones.</p>
</div>

<section class="doc">
  <div class="sec-h col"><span class="n">01</span><h2>How each one gets there</h2></div>
  <div class="col stack">
    <p class="lede">Same Snapshot, two very different write paths.</p>
  </div>
  <div class="flow">
    <div class="flow-row deliver"><span class="n">A</span><span class="lb">Compose the note as HTML, tables and all</span><span class="pr">in memory</span></div>
    <div class="flow-row deliver"><span class="n">&nbsp;</span><span class="lb"><code>candidate.createNote</code> — one call</span><span class="pr">Ashby renders it</span></div>
    <div class="flow-row"><span class="n">B</span><span class="lb">Render the Snapshot to PDF</span><span class="pr">snapshot.pdf</span></div>
    <div class="flow-row"><span class="n">&nbsp;</span><span class="lb"><code>file.createFileUploadHandle</code> — reserve a slot</span><span class="pr">handle + signed fields</span></div>
    <div class="flow-row"><span class="n">&nbsp;</span><span class="lb">POST the bytes to the presigned URL</span><span class="pr">S3 verifies the signature</span></div>
    <div class="flow-row deliver"><span class="n">&nbsp;</span><span class="lb"><code>candidate.uploadFile</code> — attach the handle</span><span class="pr">Ashby displays the file</span></div>
  </div>
  <div class="col stack">
    <p><b>Order matters between them.</b> The document lands first, because the note names it.
      Write the note first and it points at a file that does not exist yet. If the upload fails,
      the note still ships and simply drops the reference rather than advertising a file nobody
      can open.</p>
  </div>
</section>

<section class="doc">
  <div class="sec-h col"><span class="n">02</span><h2>Both versions, at real size</h2></div>
  <div class="col stack">
    <p class="lede">Each one in the space it actually occupies on a 1440&times;900 Ashby record.
      The third block is the data layer — the score as typed values, not a display of the
      Snapshot.</p>
  </div>
</section>

${[...DISPLAY_VERSIONS, DATA_VERSION].map(versionBlock).join('')}

<section class="doc">
  <div class="sec-h col"><span class="n">03</span><h2>Where the link goes</h2></div>
  <div class="col stack">
    <p class="lede">The brief names three placements, and this is the third: <b>a link out to a
      page we host</b>. It is not a fourth way of displaying the Snapshot inside Ashby — it is
      what Version A's link opens, and the only place the <b>interview recordings</b> exist.</p>
  </div>
  <div class="stage">
    <div class="stage-label">
      Sam-hosted dossier · a full browser window, outside Ashby
      <span class="slot">reached from the note</span>
    </div>
    <div class="stage-frame" style="height:${SCALED_H}px">
      <div class="stage-inner" style="transform:scale(${SCALE});width:${VIEWPORT.width}px">
        <div class="browser">
          <div class="browser-bar"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
            <span class="url">${esc(DOSSIER)}</span></div>
          <div class="browser-body">${renderDossier(s).replace(/<!doctype html>[\s\S]*?<body[^>]*>/i, '').replace(/<\/body>[\s\S]*$/i, '')}</div>
        </div>
      </div>
    </div>
  </div>
  <div class="v-cols">
    <div class="v-note"><h4>What this is</h4><p>Everything the document carries, plus the five
      interview recordings and the original resume, and it stays current instead of freezing.
      One click from the feed.</p></div>
    <div class="v-lost"><h4>What it costs</h4><p style="font-size:14.5px;color:var(--soft)">It
      leaves Ashby. It needs its own access control, it will not appear in any Ashby report or
      filter, and in the feed it is a single blue link — the least visible thing on this page.</p></div>
  </div>
</section>

<section class="doc">
  <div class="sec-h col"><span class="n">04</span><h2>And the score becomes data</h2></div>
  <div class="col stack">
    <p class="lede">Neither display version helps you find the right candidate among
      ${scored.length}. That is what the third write is for: Sam's four values go into Ashby's
      own custom fields, which makes a graded candidate <b>searchable and filterable</b>.</p>
  </div>
  ${stage(ashbyPipeline({ rows, highlight: c.name }),
    `Ashby pipeline · ${VIEWPORT.width}×${VIEWPORT.height} at ${Math.round(SCALE * 100)}%`,
    'Sorted by Sam Role Fit · unverified', true)}
  <div class="refused" style="border-left-color:var(--uncoll);border-color:var(--uncoll)">
    <h4 style="color:var(--uncoll)">This screen is the biggest assumption in the build</h4>
    <div class="ep">custom fields as a sortable pipeline column</div>
    <p><b>Filtering</b> by a custom field is documented. <b>Columns</b> are documented for
      Projects. But the Candidate Pipeline page never mentions columns at all, and the only
      documented <code>add column</code> option on Application Review is Ashby's own
      <b>AI job criteria met percentage</b> — which you can sort by, to move the best-fit
      candidates to the top. That is this screen, already built, by Ashby.</p>
    <p>So the ranked pipeline above is what we want, not what we have confirmed. It is drawn
      here so the question is visible, and it is the first thing to settle with Ashby.</p>
  </div>

  <div class="call col">
    <h4>Why coverage is its own column</h4>
    <p>Role Fit is never written without <b>Evidence Coverage</b> beside it. Every candidate
      here shows 65% coverage because the job description asks for two things this survey
      never collected — so a bare 76% would imply a completeness the data does not have.
      Sorting on a score is only safe when the denominator sorts with it.</p>
  </div>
</section>

<section class="doc">
  <div class="sec-h col"><span class="n">05</span><h2>What each one carries</h2></div>
  <div class="col stack">
    <p class="lede">Every field in <code>Sam_Resume_Snapshot_Design.pdf</code> against the three
      surfaces. The percentages are computed from this table, weighted by how much each field
      matters — they are not asserted.</p>
  </div>
  ${matrix()}
  <div class="call col">
    <h4>Where they overlap and where they do not</h4>
    <p>The score, its coverage and the band appear in all three, so a reviewer sees the same
      number wherever they look. Everything else is deliberately split:
      ${single.length ? `<b>${single.map(esc).join(', ')}</b> live in exactly one surface each.` : ''}</p>
    ${orphans.length ? `<p><b>Not carried anywhere inside Ashby:</b> ${orphans.map(esc).join(', ')}. The
      interview recordings are the richest evidence we hold, and no documented Ashby surface
      can hold them — today they live only on the Sam side.</p>` : ''}
  </div>
</section>

<section class="doc">
  <div class="sec-h col"><span class="n">06</span><h2>The one surface we refuse</h2></div>
  <div class="refused">
    <h4>${esc(REFUSED.name)}</h4>
    <div class="ep">${esc(REFUSED.endpoint)}</div>
    <p>${esc(REFUSED.reason)}</p>
  </div>
  <div class="col stack">
    <p>Ashby has a dedicated resume endpoint and it would render the Snapshot in the highest-traffic
      space on the record. We use <code>candidate.uploadFile</code> instead, which appends to the
      candidate's files rather than writing the resume slot. Same PDF, same viewer, no risk of
      displacing a document the candidate owns — and the documentation does not say whether that
      write replaces or appends, which settles it.</p>
  </div>
</section>

<section class="doc">
  <div class="sec-h col"><span class="n">07</span><h2>Questions for Ashby</h2></div>
  <div class="col stack">
    <p class="lede">${OPEN_QUESTIONS.length} places the documentation did not say and we had to
      assume. The ${HIGH_RISK.length} that would change what we build:</p>
  </div>
  <div style="margin-top:20px">
    ${HIGH_RISK.map((q) => `
      <div class="q">
        <div class="topic">${esc(q.topic)}</div>
        <h4>${esc(q.question)}</h4>
        <p><b>What we assumed:</b> ${esc(q.assumption)}</p>
        <p class="ask"><b>If we are wrong:</b> ${esc(q.consequence)}</p>
      </div>`).join('')}
  </div>
</section>

<footer class="col">
  Built from <code>survey_agree.com_business_development_representative.xlsx</code> (${scored.length} responses),
  <code>Sales Account Executive.pdf</code> and <code>Sam_Resume_Snapshot_Design.pdf</code>.
  Endpoints verified against developers.ashbyhq.com. The screens are a rebuild from Ashby's
  documentation and marketing, not screenshots — measurements marked estimated are listed as
  questions.
</footer>

</div>`;

writeFileSync(OUT, html);
console.log(`canvas written: ${OUT}  ${html.length} bytes`);
console.log(`surfaces: ${PLACEMENT_VERSIONS.map((p) => `${p.id}=${p.fidelity}%`).join('  ')}`);
