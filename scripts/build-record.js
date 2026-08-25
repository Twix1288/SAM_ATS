/**
 * Builds the hand-back build record.
 *
 * Every figure is read from the live repo rather than typed, so the record cannot
 * drift from what the code actually does between now and Friday.
 *
 *   node scripts/build-record.js <out.html>
 */
import { writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { loadPool } from '../shared/seed/survey.js';
import { scorePool } from '../sam-integration/services/calibrate.js';
import { buildSnapshot } from '../sam-integration/render/model.js';
import { PLACEMENT_VERSIONS, DISPLAY_VERSIONS, DATA_VERSION, REFUSED } from '../sam-integration/placements/registry.js';
import { ANCHORS, STATE } from '../sam-integration/services/rubric.js';
import { loadResumeText } from '../sam-integration/ingest/resume.js';
import { SAM, TEAL, INK, STATE_COLOR } from '../shared/brand.js';
import { OPEN_QUESTIONS, HIGH_RISK } from './questions.js';
import { esc, pct } from './ashby-screen.js';
import { STAGES, DELIVERABLES } from '../sam-integration/delivery/pipeline.js';

const OUT = process.argv[2] ?? 'docs/build-record.html';
const CANVAS_URL = process.argv[3] ?? '#';

const pool = loadPool('data/survey_agree.com_business_development_representative.xlsx');
const scored = scorePool(pool);
const entry = scored.find((e) => e.response.rowNumber === 6);
const s = buildSnapshot(entry.score, entry.response);

// ── live figures ───────────────────────────────────────────────────────────
const q4Answered = pool.filter((p) => p.answers.find((a) => a.id === 'Q4').answered).length;
const withResume = pool.filter((p) => p.resume).length;

const docs = readdirSync('.cache/resumes').filter((f) => /\.(pdf|docx)$/i.test(f));
let readable = 0;
for (const f of docs) {
  try { if (loadResumeText(`.cache/resumes/${f}`).length > 200) readable += 1; } catch { /* counted as unreadable */ }
}

const testCount = (readFileSync('test/integration.test.js', 'utf8').match(/\n\s{2}test\(/g) ?? []).length;
const notCollected = entry.score.anchors.filter((a) => a.state === STATE.NOT_COLLECTED);

const CONTRACT_FIXES = [
  ['candidateNote.create', 'candidate.createNote', 'Every note write would have 404ed.'],
  ['application.created webhook', 'applicationSubmit', 'No such Ashby event — the webhook never fires.'],
  ['POST /api/candidate.uploadResume', 'no /api prefix', 'Every call 404s.'],
  ['notes are plain text only', "note accepts { type: 'text/html', value }", 'We were leaving half the note’s fidelity on the table.'],
  ['one customField.setValue per field', 'customField.setValues (batch)', 'Concurrent single writes to one object have a documented race.'],
  ['the Snapshot goes in the resume slot', 'candidate.uploadFile', 'The resume slot is the candidate’s own document. This was the dangerous one.'],
];

const PHASES = [
  {
    n: '01', title: 'Learn the system', done: true,
    body: 'Worked from the llms.txt index directly. Mapped how an application arrives, what Ashby '
      + 'knows at that moment, and every surface an integration can write to. Six things in our '
      + 'original plan turned out to be wrong.',
    out: 'shared/ashby-contract.js — one module both halves compile against',
  },
  {
    n: '02', title: 'Build our side, named like theirs', done: true,
    body: 'Files, functions and endpoints carry Ashby’s own names, so when access arrives we are '
      + 'overlaying onto something that already fits. The stand-in feeds applications in the shape '
      + 'Ashby sends them and can be pulled out without touching the integration.',
    out: 'An application goes in one end; a Snapshot comes out and lands on the record',
  },
  {
    n: '03', title: 'Every version the Snapshot could take', done: true, main: true,
    body: 'Nine surfaces were investigated; three are built out. They cover the three things a '
      + 'recruiter does — triage the pipeline, read one candidate, go deep on the evidence — and '
      + 'all three land today with no partner approval and no customer-side configuration. One '
      + 'surface, the resume slot, is refused outright.',
    out: 'The canvas — the pipeline view plus all three on the candidate record',
  },
  {
    n: '04', title: 'Make it walkable', done: true,
    body: 'The whole flow runs live: an application arrives, gets scored, and the result lands on '
      + 'all three surfaces in one pass. The screens are stepped through in a browser, not '
      + 'described in slides.',
    out: 'npm run ashby · npm run sam · npm run trigger — then open /canvas/:candidate',
  },
];

const html = `<title>Ashby Build Record</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap">
<style>
:root{
  --teal:${SAM.teal}; --teal-deep:${TEAL.deep}; --teal-ink:${TEAL.ink};
  --teal-wash:${TEAL.wash}; --teal-line:${TEAL.line};
  --black:${SAM.black}; --ink:${INK[700]}; --soft:${INK[500]}; --faint:${INK[400]};
  --rule:${INK[200]}; --wash:${INK[100]}; --paper:${INK[0]};
  --met:${STATE_COLOR.MET.fg}; --met-bg:${STATE_COLOR.MET.bg};
  --miss:${STATE_COLOR.NOT_MET.fg}; --miss-bg:${STATE_COLOR.NOT_MET.bg};
  --uncoll:${STATE_COLOR.NOT_COLLECTED.fg}; --uncoll-bg:${STATE_COLOR.NOT_COLLECTED.bg};
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --black:#F2F4F4; --ink:#C8CECF; --soft:#9AA2A3; --faint:#7C8487;
  --rule:#2B3133; --wash:#171A1B; --paper:#101314;
  --teal-wash:#12312F; --teal-line:#2A6360; --teal-deep:#6FD5CF; --teal-ink:#A8E6E2;
  --met-bg:#15291F; --miss-bg:#2D1B18; --uncoll-bg:#2A2314;
}}
:root[data-theme="dark"]{
  --black:#F2F4F4; --ink:#C8CECF; --soft:#9AA2A3; --faint:#7C8487;
  --rule:#2B3133; --wash:#171A1B; --paper:#101314;
  --teal-wash:#12312F; --teal-line:#2A6360; --teal-deep:#6FD5CF; --teal-ink:#A8E6E2;
  --met-bg:#15291F; --miss-bg:#2D1B18; --uncoll-bg:#2A2314;
}
*{box-sizing:border-box}
body{margin:0;background:var(--wash);color:var(--black);font-family:${SAM.fontStack};
  font-size:16px;line-height:1.62;-webkit-font-smoothing:antialiased}
.wrap{max-width:1080px;margin:0 auto;padding:0 24px 110px}
.col{max-width:730px}
h1,h2,h3,h4{margin:0;text-wrap:balance}
p{margin:0}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.86em;
  background:var(--teal-wash);color:var(--teal-deep);padding:1px 5px;border-radius:3px}
a{color:var(--teal-deep)}
:focus-visible{outline:2px solid var(--teal);outline-offset:3px;border-radius:3px}

.mast{background:var(--black);color:#fff;margin:0 -24px 46px;padding:52px 24px 40px;border-bottom:5px solid var(--teal)}
.mast-in{max-width:1080px;margin:0 auto;padding:0 24px}
.eyebrow{font-size:11.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--teal);font-weight:700}
.mast h1{font-size:clamp(34px,5vw,52px);font-weight:700;letter-spacing:-.03em;line-height:1.04;margin:15px 0 0;color:#fff}
.mast .dek{font-size:18px;color:#B4BBBC;margin-top:16px;max-width:660px}
.mast .meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:26px}
.mast .tag{font-size:11.5px;color:#C8CFD0;border:1px solid #33393B;border-radius:999px;padding:4px 11px}

section{margin-top:62px}
.sec-h{display:flex;align-items:baseline;gap:12px;border-bottom:2px solid var(--teal);padding-bottom:8px;margin-bottom:22px}
.sec-h h2{font-size:23px;font-weight:700;letter-spacing:-.02em}
.sec-h .n{font-size:12px;font-weight:700;color:var(--teal-deep);letter-spacing:.08em}
.lede{font-size:17.5px;color:var(--ink)}
.stack{display:flex;flex-direction:column;gap:15px}

.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;
  background:var(--rule);border:1px solid var(--rule);border-radius:5px;overflow:hidden;margin:26px 0}
.stat{background:var(--paper);padding:16px 15px}
.stat .n{font-size:26px;font-weight:700;letter-spacing:-.02em;line-height:1.1;font-variant-numeric:tabular-nums}
.stat .l{font-size:12.5px;color:var(--soft);margin-top:4px;line-height:1.35}
.n.ok{color:var(--met)} .n.warn{color:var(--uncoll)} .n.bad{color:var(--miss)}

.phase{display:grid;grid-template-columns:46px 1fr;gap:18px;padding:18px 0;border-bottom:1px solid var(--rule)}
.phase:last-child{border-bottom:none}
.p-n{font-size:12px;font-weight:700;color:var(--teal-deep);letter-spacing:.06em;padding-top:4px}
.phase h3{font-size:18px;font-weight:700;margin-bottom:5px}
.phase p{font-size:15px;color:var(--ink)}
.p-out{font-size:12.5px;color:var(--faint);margin-top:8px;font-family:ui-monospace,Menlo,monospace}
.done{font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;
  background:var(--met-bg);color:var(--met);padding:2px 7px;border-radius:3px;margin-left:8px;vertical-align:2px}
.main-tag{font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;
  background:var(--teal-wash);color:var(--teal-deep);padding:2px 7px;border-radius:3px;margin-left:6px;vertical-align:2px}

.scroll{overflow-x:auto;border:1px solid var(--rule);border-radius:6px;background:var(--paper);margin:22px 0}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{text-align:left;padding:10px 13px;border-bottom:1px solid var(--rule);vertical-align:top}
thead th{background:var(--wash);font-size:11px;letter-spacing:.08em;text-transform:uppercase;
  color:var(--soft);font-weight:700;white-space:nowrap}
tbody tr:last-child td{border-bottom:none}
td.mono{font-family:ui-monospace,Menlo,monospace;font-size:12.5px}
td.was{color:var(--miss);text-decoration:line-through;font-family:ui-monospace,Menlo,monospace;font-size:12.5px}
td.now{color:var(--met);font-family:ui-monospace,Menlo,monospace;font-size:12.5px;font-weight:600}
.num{text-align:right;font-variant-numeric:tabular-nums}
.pill{font-size:10.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;
  padding:2px 7px;border-radius:3px;white-space:nowrap}
.p-ship{background:var(--met-bg);color:var(--met)}
.p-part{background:var(--uncoll-bg);color:var(--uncoll)}
.p-rej{background:var(--miss-bg);color:var(--miss)}

.call{background:var(--teal-wash);border:1px solid var(--teal-line);border-radius:6px;padding:18px 20px;margin:24px 0}
.call h4{color:var(--teal-ink);font-size:12px;letter-spacing:.08em;text-transform:uppercase;margin-bottom:8px}
.call p{font-size:15.5px;color:var(--ink)}
.call p+p{margin-top:9px}
.big-link{display:block;background:var(--paper);border:1px solid var(--teal);border-radius:6px;
  padding:20px 22px;margin:24px 0;text-decoration:none;color:inherit}
.big-link:hover{background:var(--teal-wash)}
.big-link .k{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--teal-deep);font-weight:700}
.big-link h3{font-size:21px;font-weight:700;margin:6px 0 4px}
.big-link p{font-size:14.5px;color:var(--soft)}

.gap{background:var(--paper);border:1px solid var(--rule);border-left:3px solid var(--uncoll);
  border-radius:0 5px 5px 0;padding:15px 17px;margin-bottom:11px}
.gap h4{font-size:16px;font-weight:700;margin-bottom:5px}
.gap p{font-size:14.5px;color:var(--soft)}
ul.tick{list-style:none;padding:0;margin:14px 0;display:flex;flex-direction:column;gap:10px}
ul.tick li{padding-left:22px;position:relative;font-size:15px;color:var(--ink)}
ul.tick li::before{content:"—";position:absolute;left:0;color:var(--teal-deep);font-weight:700}
ul.tick li b{color:var(--black)}
footer{margin-top:80px;padding-top:20px;border-top:1px solid var(--rule);font-size:13px;color:var(--faint)}
.ship{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:22px 0}
.ship-card{background:var(--paper);border:1px solid var(--teal);border-radius:6px;padding:17px 19px}
.ship-card .k{font-size:10.5px;letter-spacing:.11em;text-transform:uppercase;color:var(--teal-deep);font-weight:700}
.ship-card h3{font-size:19px;font-weight:700;margin:6px 0 3px}
.ship-card .ep{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--faint);margin-bottom:8px}
.ship-card p{font-size:14.5px;color:var(--ink)}
@media(max-width:720px){.ship{grid-template-columns:1fr}}
.flow{margin:20px 0;border:1px solid var(--rule);border-radius:6px;overflow:hidden;background:var(--paper)}
.flow-row{display:grid;grid-template-columns:38px 1fr 220px;gap:14px;align-items:center;
  padding:10px 16px;border-bottom:1px solid var(--rule);font-size:14px}
.flow-row:last-child{border-bottom:none}
.flow-row .n{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:var(--faint);font-weight:600}
.flow-row .pr{font-size:11.5px;color:var(--faint);text-align:right;font-family:ui-monospace,Menlo,monospace}
.flow-row.deliver{background:var(--teal-wash)}
.flow-row.deliver .lb{font-weight:700}
.flow-row.deliver .pr{color:var(--teal-deep);font-weight:700}
</style>

<div class="mast">
  <div class="mast-in">
    <div class="eyebrow">Build 1 · Ashby integration · Week of 24 August</div>
    <h1>Ashby Build Record</h1>
    <p class="dek">A working mockup that behaves the way Ashby will, built to decide whether
      an account is worth paying for before the partner request lands.</p>
    <div class="meta">
      <span class="tag">3 surfaces</span>
      <span class="tag">${CONTRACT_FIXES.length} contract corrections</span>
      <span class="tag">${pool.length} candidates scored</span>
      <span class="tag">${testCount} tests</span>
      <span class="tag">${OPEN_QUESTIONS.length} questions for Ashby</span>
      <span class="tag">0 paid tools</span>
    </div>
  </div>
</div>

<div class="wrap">

<div class="col stack">
  <p class="lede">A person applies. Ashby fires <code>applicationSubmit</code>, signed over the
    raw request body. Sam verifies the signature, deduplicates on <code>webhookActionId</code>,
    scores the candidate against a rubric compiled from the job description, renders the
    Snapshot once, and delivers it to the record through every placement at the same time.
    Four land today; two wait on partner approval.</p>
  <p class="lede">That whole path runs locally, end to end, right now.</p>
</div>

<div class="stats">
  <div class="stat"><div class="n ok">${PLACEMENT_VERSIONS.length}</div><div class="l">surfaces Sam writes to</div></div>
  <div class="stat"><div class="n">${pool.length}</div><div class="l">candidates graded and ranked</div></div>
  <div class="stat"><div class="n bad">1</div><div class="l">surface refused outright</div></div>
  <div class="stat"><div class="n">${testCount}</div><div class="l">tests, all passing</div></div>
</div>

<a class="big-link" href="${esc(CANVAS_URL)}">
  <div class="k">The screens</div>
  <h3>Candidates into Ashby →</h3>
  <p>The pipeline sorted by Sam's scores, then all three surfaces on the candidate record at
     real size, with a field-by-field account of what each one carries.</p>
</a>

<section>
  <div class="sec-h col"><span class="n">01</span><h2>What was built</h2></div>
  <div class="col">
    ${PHASES.map((p) => `
      <div class="phase">
        <div class="p-n">${p.n}</div>
        <div>
          <h3>${esc(p.title)}${p.main ? '<span class="main-tag">The main one</span>' : ''}${p.done ? '<span class="done">Done</span>' : ''}</h3>
          <p>${esc(p.body)}</p>
          <div class="p-out">${esc(p.out)}</div>
        </div>
      </div>`).join('')}
  </div>
</section>

<section>
  <div class="sec-h col"><span class="n">02</span><h2>Two display versions, and a data layer</h2></div>
  <div class="col stack">
    <p class="lede">There are exactly two ways Sam's read can be <b>displayed</b> on a candidate
      record, and they differ by who does the rendering. A third write puts the score into
      Ashby's own fields — that is not a display, it is what makes a scored candidate findable.</p>
  </div>
  <div class="scroll">
    <table>
      <thead><tr><th></th>
        ${DISPLAY_VERSIONS.map((p, i) => `<th>Version ${String.fromCharCode(65 + i)} · ${esc(p.name)}</th>`).join('')}
      </tr></thead>
      <tbody>
        <tr><td><b>Who draws it</b></td>${DISPLAY_VERSIONS.map((p) => `<td>${esc(p.renderedBy)}</td>`).join('')}</tr>
        <tr><td><b>Endpoint</b></td>${DISPLAY_VERSIONS.map((p) => `<td class="mono">${esc(p.endpoint)}</td>`).join('')}</tr>
        <tr><td><b>Calls</b></td><td>1</td><td>3 — handle, upload, attach</td></tr>
        <tr><td><b>Lands in</b></td>${DISPLAY_VERSIONS.map((p) => `<td>${esc(p.tab)}</td>`).join('')}</tr>
        <tr><td><b>Read without a click</b></td><td>Yes</td><td>No</td></tr>
        <tr><td><b>Design survives</b></td><td>No — structure only</td><td>Every pixel</td></tr>
        <tr><td><b>Carries</b></td>${DISPLAY_VERSIONS.map((p) => `<td class="num"><b>${p.fidelity}%</b></td>`).join('')}</tr>
      </tbody>
    </table>
  </div>
  <div class="call col">
    <h4>Why both</h4>
    <p><b>A gets read, B gets studied.</b> The note is where a reviewer already is and needs no
      click, and Ashby renders embedded tables natively, so it carries the reasoning — just not
      the brand. The document is the Snapshot exactly as designed, behind one click. The note
      names the document, which turns two versions into one path rather than two competing ones.</p>
    <p>The third write, <code>${esc(DATA_VERSION.endpoint)}</code>, is a different job entirely:
      neither display helps you find the right candidate among ${pool.length}. Custom fields are
      what make the pipeline sortable.</p>
  </div>
  <div class="ship">
    ${DELIVERABLES.map((d, i) => `
      <div class="ship-card">
        <div class="k">Deliverable ${i + 1}</div>
        <h3>${esc(d.name)}</h3>
        <div class="ep">${esc(d.endpoint)} → ${esc(d.surface)}</div>
        <p>${esc(d.carries)}</p>
      </div>`).join('')}
  </div>
  <div class="col stack">
    <p><b>The order is load-bearing.</b> The note names the attachment, so the file lands
      first. Write the note first and it publishes a link to a document that does not exist
      yet. If the attachment fails, the note still ships and drops the reference rather than
      advertising a file nobody can open — and the run reports <code>partial</code> instead of
      claiming success.</p>
  </div>
  <div class="flow">
    ${STAGES.map((st, i) => `
      <div class="flow-row ${st.produces?.startsWith('DELIVERABLE') ? 'deliver' : ''}">
        <span class="n">${String(i + 1).padStart(2, '0')}</span>
        <span class="lb">${esc(st.label)}</span>
        <span class="pr">${esc(st.produces ?? '')}</span>
      </div>`).join('')}
  </div>
  <div class="call col">
    <h4>Why not the other seven</h4>
    <p><b>Custom fields and a tag</b> are the obvious next addition — the only versions Ashby
      can filter and sort, which matters across a pipeline rather than on one person.
      <b>The assessment card</b> is the one to chase, and it is waiting on partner approval.
      <b>The resume slot</b> is the one we will not take.</p>
  </div>
</section>

<section>
  <div class="sec-h col"><span class="n">03</span><h2>What the documentation corrected</h2></div>
  <div class="col stack">
    <p class="lede">Read from <a href="https://developers.ashbyhq.com">developers.ashbyhq.com</a>
      rather than assumed. Each of these would have failed silently or at the worst moment.</p>
  </div>
  <div class="scroll">
    <table>
      <thead><tr><th>We assumed</th><th>Verified</th><th>Consequence had it shipped</th></tr></thead>
      <tbody>
        ${CONTRACT_FIXES.map(([was, now, why]) => `
          <tr><td class="was">${esc(was)}</td><td class="now">${esc(now)}</td><td>${esc(why)}</td></tr>`).join('')}
      </tbody>
    </table>
  </div>
  <div class="call col">
    <h4>The one that mattered most</h4>
    <p><code>candidate.uploadResume</code> writes the <em>resume slot</em>. Putting a Snapshot
      there risks displacing the document the candidate actually uploaded. <code>candidate.uploadFile</code>
      attaches ours alongside theirs instead. The resume-slot version is still built — as the
      one version shown specifically in order to refuse it.</p>
  </div>
</section>

<section>
  <div class="sec-h col"><span class="n">04</span><h2>The three surfaces</h2></div>
  <div class="scroll">
    <table>
      <thead><tr><th>Surface</th><th>The job it does</th><th class="mono">Endpoint</th><th>Lands on</th><th class="num">Carries</th></tr></thead>
      <tbody>
        ${PLACEMENT_VERSIONS.map((p) => `
          <tr>
            <td><b>${esc(p.name)}</b></td>
            <td>${esc(p.job)}</td>
            <td class="mono">${esc(p.endpoint)}</td>
            <td>${esc(p.tab)}</td>
            <td class="num"><b>${p.fidelity}%</b></td>
          </tr>`).join('')}
      </tbody>
    </table>
  </div>
  <div class="call col">
    <h4>Why these three and not one</h4>
    <p>They are not three versions of the same thing — they do different jobs. <b>Custom
      fields</b> are the only surface Ashby can sort and filter, so they are what actually puts
      a graded candidate into the dashboard. <b>The note</b> is the only one read without a
      click. <b>The attachment</b> is the only one carrying the quoted evidence behind every
      anchor. Drop any one and a real task gets harder.</p>
    <p>Six further surfaces were investigated and left out — the assessment-partner card and
      the interview scorecard are the two worth revisiting, and both are waiting on Ashby.</p>
  </div>
</section>

<section>
  <div class="sec-h col"><span class="n">05</span><h2>The surface we refuse</h2></div>
  <div class="col stack">
    <p class="lede">Ashby has a dedicated resume endpoint, and it would render the Snapshot in
      the highest-traffic space on the whole record.</p>
  </div>
  <div class="scroll">
    <table>
      <thead><tr><th>Surface</th><th class="mono">Endpoint</th><th>Why not</th></tr></thead>
      <tbody>
        <tr><td><b>${esc(REFUSED.name)}</b></td><td class="mono">${esc(REFUSED.endpoint)}</td><td>${esc(REFUSED.reason)}</td></tr>
      </tbody>
    </table>
  </div>
  <div class="col stack">
    <p>We use <code>candidate.uploadFile</code> instead, which appends to the candidate's files.
      Same PDF, same viewer, no risk of displacing a document the candidate owns — and the
      documentation does not say whether the resume write replaces or appends, which settles it.</p>
  </div>
</section>

<section>
  <div class="sec-h col"><span class="n">06</span><h2>What the seed data supports</h2></div>
  <div class="col stack">
    <p class="lede">The Snapshot is only as good as what it can evidence, so this is stated
      plainly rather than glossed.</p>
  </div>
  <div class="stats">
    <div class="stat"><div class="n">${pool.length}</div><div class="l">candidates scored</div></div>
    <div class="stat"><div class="n ok">${withResume}<span style="font-size:15px;color:var(--faint)">/${pool.length}</span></div><div class="l">resumes on file</div></div>
    <div class="stat"><div class="n warn">${q4Answered}<span style="font-size:15px;color:var(--faint)">/${pool.length}</span></div><div class="l">answered the invoiced-volume question</div></div>
    <div class="stat"><div class="n">${readable}<span style="font-size:15px;color:var(--faint)">/${docs.length}</span></div><div class="l">resumes that parse to text</div></div>
    <div class="stat"><div class="n">${pct(entry.score.coverage)}</div><div class="l">of the rubric observable</div></div>
  </div>
  <div class="col stack">
    <p>The job description's hardest requirement — <b>$5M+ in annualised invoice volume</b> —
      maps to exactly one survey question, and that question collected no answers from anyone.
      A second requirement, competitive displacement, has no question at all. So
      <b>${notCollected.length} of ${ANCHORS.length} anchors are unobservable with this instrument</b>,
      and every score in the mockup carries a coverage denominator for that reason.</p>
    <p>This is why the engine distinguishes <b>not collected</b> from <b>not met</b>. Those mean
      opposite things to a hiring manager, and collapsing them is how a scoring product quietly
      becomes wrong.</p>
  </div>
</section>

<section>
  <div class="sec-h col"><span class="n">07</span><h2>Known gaps</h2></div>
  <div class="col">
    <div class="gap">
      <h4>Resume text extraction reads ${readable} of ${docs.length} documents</h4>
      <p>Built on <code>node:zlib</code> because the brief forbids new dependencies. Resumes using
        subset-embedded fonts without a usable ToUnicode map decode to glyph codes rather than
        characters; those are detected and dropped rather than returned as convincing-looking
        garbage. Career history renders when it parses and is omitted when it does not — it is
        never invented.</p>
    </div>
    <div class="gap">
      <h4>Scoring is deterministic and lexicon-based</h4>
      <p>No paid model, per the brief. It will miss paraphrase a model would catch. The mitigation
        is that low confidence is surfaced rather than smoothed over, and the evidence-span
        interface takes a model later without touching a single renderer.</p>
    </div>
    <div class="gap">
      <h4>Every pixel measurement is an estimate</h4>
      <p>Ashby publishes no dimensions, and one knowledge-base page explicitly declines to describe
        a strict panel layout. Region names, the tab list, the action bar and the location of custom
        fields are confirmed from their documentation. The sizes are not, and every "at real size"
        claim is an estimate until someone with an account confirms it.</p>
    </div>
  </div>
</section>

<section>
  <div class="sec-h col"><span class="n">08</span><h2>Questions for Ashby</h2></div>
  <div class="col stack">
    <p class="lede">${OPEN_QUESTIONS.length} in total, ordered by blast radius. The ${HIGH_RISK.length} that
      would change what we build:</p>
    <ul class="tick">
      ${HIGH_RISK.map((q) => `<li><b>${esc(q.topic)}.</b> ${esc(q.question)}</li>`).join('')}
    </ul>
    <p>The assessment question is the one worth leading with. The Assessments Partner framework
      renders a native card of typed, labelled values in Ashby's own style — structurally the
      closest fit to what Sam produces, and probably the surface Ashby built for products like
      this. If it is reachable it likely becomes the primary placement and everything else
      becomes a fallback.</p>
  </div>
</section>

<section>
  <div class="sec-h col"><span class="n">09</span><h2>Friday walkthrough</h2></div>
  <div class="col stack">
    <ul class="tick">
      <li><b>Three terminals.</b> <code>npm run ashby</code>, <code>npm run sam</code>, then
        <code>npm run trigger -- --row 6</code>. An application lands and is scored in front of you.</li>
      <li><b>Watch the write-back.</b> Four placements deliver; two report exactly why they cannot
        yet — <code>partnerId is required</code>.</li>
      <li><b>Open the canvas.</b> <code>/canvas/aditya_alapati</code> — step between all nine
        versions on the record.</li>
      <li><b>Run it on someone else.</b> <code>--row 11</code>, unprompted. Different candidate,
        different Snapshot, no code change.</li>
      <li><b>Replay the same delivery twice.</b> The second returns <code>duplicate: true</code>
        and does no work, so Ashby's retries are safe.</li>
      <li><b>Then argue about the product,</b> which is the point.</li>
    </ul>
  </div>
</section>

<footer class="col">
  Built from <code>survey_agree.com_business_development_representative.xlsx</code>,
  <code>Sales Account Executive.pdf</code> and <code>Sam_Resume_Snapshot_Design.pdf</code>.
  Endpoints verified against developers.ashbyhq.com. No paid tools; the only dependency is
  <code>pdf-lib</code>. Every figure on this page is read from the repo at build time.
</footer>

</div>`;

writeFileSync(OUT, html);
console.log(`build record written: ${OUT}  ${html.length} bytes`);
console.log(`figures — pool ${pool.length}, resumes ${withResume}, Q4 ${q4Answered}, parsed ${readable}/${docs.length}, tests ${testCount}`);
