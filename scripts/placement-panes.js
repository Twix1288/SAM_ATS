/**
 * What an Ashby reviewer actually sees, for each version of the Snapshot.
 *
 * Every function here renders the placement in the space it really occupies, so the
 * nine versions can be compared by looking rather than by description. Content comes
 * from the same Snapshot model in every case — only the carrier changes.
 */
import { SAM, TEAL, INK, STATE_COLOR } from '../shared/brand.js';
import { esc, pct } from './ashby-screen.js';
import { composeNoteHtml } from '../sam-integration/endpoints/candidate.createNote.js';
import { SAM_CUSTOM_FIELDS } from '../shared/ashby-contract.js';

export const PANE_CSS = `
/* ── the Snapshot as a document, inside Ashby's viewer ── */
.viewer{background:#43484C;border-radius:6px;padding:14px;height:100%;overflow:hidden;display:flex;flex-direction:column}
.viewer-bar{display:flex;align-items:center;gap:10px;color:#D3D8DB;font-size:11.5px;margin-bottom:11px;flex:none}
.viewer-bar .nm{font-weight:600;color:#fff}
.viewer-bar .tools{margin-left:auto;display:flex;gap:9px;color:#A9B0B4}
/* What the one attachment is actually made of. Stated, not implied — a reviewer who
   scrolls past the Snapshot should already know what they are about to find. */
.bound{display:flex;align-items:center;gap:6px;margin-top:9px;flex-wrap:wrap;font-size:10.5px}
.bound .seg{padding:3px 8px;border-radius:3px;font-weight:600;letter-spacing:.01em}
.bound .seg.sam{background:${TEAL.wash};color:${TEAL.deep}}
.bound .seg.div{background:#EFF2F3;color:#5A6367}
.bound .seg.res{background:#F4F6F7;color:#5A6367;border:1px solid #E2E7E9}
.bound .seg.extra{background:transparent;color:#7A8388;border:1px dashed #D6DBDD;font-weight:500}
.bound .how{color:#7A8388;font-style:italic}
.page{background:#fff;width:600px;margin:0 auto;font-family:${SAM.fontStack};
  box-shadow:0 3px 14px rgba(0,0,0,.32);overflow:hidden}
.pg-head{background:${SAM.black};color:#fff;padding:15px 19px 13px;border-bottom:3px solid ${SAM.teal};display:flex;gap:12px}
.pg-head .nm{font-size:16px;font-weight:700;letter-spacing:-.02em}
.pg-head .sub{font-size:10px;color:#AEB4B5;margin-top:2px}
.pg-head .pool{font-size:9px;color:${SAM.teal};margin-top:4px}
.pg-head .sc{margin-left:auto;text-align:right}
.pg-head .sc .n{font-size:25px;font-weight:700;line-height:1}
.pg-head .sc .l{font-size:7px;letter-spacing:.12em;color:#98A0A1;text-transform:uppercase}
.pg-head .sc .c{font-size:8.5px;color:${SAM.teal};font-weight:600;margin-top:3px}
.pg-body{padding:13px 19px 16px;font-size:9.5px;color:${INK[700]};line-height:1.5}
.pg-next{background:${TEAL.wash};border-left:2px solid ${SAM.teal};padding:8px 10px;margin-bottom:11px}
.pg-next .h{font-size:7px;letter-spacing:.11em;text-transform:uppercase;color:${TEAL.deep};font-weight:700}
.pg-next p{margin:3px 0 0;font-size:9.5px;color:${SAM.black}}
.pg-h{font-size:7px;letter-spacing:.11em;text-transform:uppercase;color:${TEAL.deep};font-weight:700;
  border-bottom:1px solid ${SAM.teal};padding-bottom:3px;margin:12px 0 6px}
.pg-a{display:flex;gap:6px;padding:3.5px 0;border-bottom:1px solid ${INK[100]}}
.pg-a:last-child{border-bottom:none}
.pg-a .bar{width:3px;border-radius:2px;flex:none}
.pg-a .t{flex:1;min-width:0}
.pg-a .t b{font-size:9.5px}
.pg-a .t p{margin:1px 0 0;font-size:8px;color:${INK[500]}}
.pg-a .st{font-size:6.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;
  padding:1px 5px;border-radius:2px;white-space:nowrap;height:fit-content}
.pg-cols{display:grid;grid-template-columns:1fr 1fr;gap:13px}
.pg-chip{display:inline-block;background:${TEAL.wash};color:${TEAL.deep};border:1px solid ${TEAL.line};
  border-radius:9px;padding:1px 6px;font-size:7.5px;margin:0 3px 3px 0}
.pg-foot{border-top:1px solid ${INK[200]};margin-top:11px;padding-top:6px;display:flex;
  justify-content:space-between;font-size:7px;color:${INK[400]}}

/* ── notes ── */
.note-html{font-size:12.5px;color:#2A2E31;line-height:1.55}
.note-html p{margin:0 0 7px}
.note-html ul{margin:0 0 7px;padding-left:18px}
.note-html li{margin-bottom:2px}
.note-html a{color:#2B6CBF}
.note-plain{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.55;
  white-space:pre-wrap;color:#33383C}
.fade{position:relative;max-height:300px;overflow:hidden}
.fade::after{content:'';position:absolute;left:0;right:0;bottom:0;height:56px;
  background:linear-gradient(to bottom,rgba(255,255,255,0),#fff)}

/* ── custom field rows written into the Summary rail ── */
.cf{display:flex;justify-content:space-between;gap:10px;padding:4px 7px;font-size:12.5px;
  background:${TEAL.wash};border-radius:3px;margin:0 -7px 2px}
.cf .k{color:${TEAL.deep};font-weight:500}
.cf .v{font-weight:700;color:${SAM.black};text-align:right}

`;

const stateChip = (st) => {
  const c = STATE_COLOR[st];
  const label = { MET: 'Met', PARTIAL: 'Partial', NOT_MET: 'Not met', NOT_COLLECTED: 'Not collected' }[st];
  return `<span class="st" style="color:${c.fg};background:${c.bg}">${label}</span>`;
};

/** The Snapshot document itself, at page size. Shared by the document and resume-slot versions. */
function snapshotPage(s) {
  return `
    <div class="page">
      <div class="pg-head">
        <div>
          <div class="nm">${esc(s.candidate.name)}</div>
          <div class="sub">Matched to <b>${esc(s.role.title)}</b> · ${esc(s.role.company)}</div>
          <div class="pool">Top ${s.pool.topPercent}% of pool · ${s.pool.size} applicants</div>
        </div>
        <div class="sc">
          <div class="n">${pct(s.roleFit)}</div>
          <div class="l">Role fit</div>
          <div class="c">${pct(s.coverage)} coverage</div>
        </div>
      </div>
      <div class="pg-body">
        <div class="pg-next"><div class="h">Recommended next step</div><p>${esc(s.recommendedNextStep)}</p></div>
        <div class="pg-h">Role anchors · ${s.anchorSummary.met} met of ${s.anchorSummary.observable} observable</div>
        ${s.roleAnchors.map((a) => `
          <div class="pg-a">
            <div class="bar" style="background:${STATE_COLOR[a.state].fg}"></div>
            <div class="t"><b>${esc(a.label)}</b><p>${esc(a.reason)}</p></div>
            ${stateChip(a.state)}
          </div>`).join('')}
        <div class="pg-cols">
          <div>
            <div class="pg-h">How they work · ${s.capability}/10</div>
            ${s.capabilitySignals.met.map((t) => `<div style="padding:1.5px 0">✓ ${esc(t)}</div>`).join('')}
            ${s.capabilitySignals.missing.map((t) => `<div style="padding:1.5px 0;color:${INK[400]}">— ${esc(t)}</div>`).join('')}
          </div>
          <div>
            <div class="pg-h">Skills named</div>
            ${(s.additionalSkills ?? []).slice(0, 8).map((k) => `<span class="pg-chip">${esc(k)}</span>`).join('')}
          </div>
        </div>
        <div class="pg-h">Net read</div>
        <p style="margin:0">${esc(s.netRead)}</p>
        <div class="pg-h">Gaps to investigate</div>
        ${s.gapsToInvestigate.slice(0, 4).map((g) => `<div style="padding:1.5px 0"><b>${esc(g.label)}</b> — <span style="color:${INK[500]}">${esc(g.reason)}</span></div>`).join('')}
        <div class="pg-foot"><span>Powered by <b>Sam</b> for ${esc(s.role.company)}</span><span>Role fit ${pct(s.roleFit)} at ${pct(s.coverage)} coverage</span></div>
      </div>
    </div>`;
}

const feedItem = (body, who = 'Sam', when = 'just now') => `
  <div class="ab-card">
    <div class="ab-item">
      <div class="ab-iav sam">${who === 'Sam' ? 'S' : who[0]}</div>
      <div class="ab-ibody">
        <div class="ab-ihead"><b>${esc(who)}</b> added a note · ${esc(when)}</div>
        ${body}
      </div>
    </div>
  </div>`;

const composer = '<div class="ab-composer">Write a note…</div>';

/** VERSION — the Snapshot as a file on the candidate. */
/** One divider + one document per bound source, numbered as the reader will meet them. */
function segments(bound) {
  let at = bound.snapshotPages;
  return bound.bound.map((b) => {
    const divider = at + 1;
    const from = at + 2;
    at = at + 1 + b.pages;
    return `<span class="seg div">${divider} · divider</span>`
      + `<span class="seg ${b.read ? 'res' : 'extra'}">${span(from, at)} · `
      + `${esc(b.read ? 'their resume' : b.label)}${b.read ? '' : ' · unscored'}</span>`;
  }).join('');
}

/** "1–3" for a range, plain "4" for one page. */
const span = (from, to) => (from === to ? `${from}` : `${from}–${to}`);

/**
 * @param {object}  s
 * @param {object} [bound]  the real stitch result, so the viewer states the true page
 *                          count and the true composition rather than a rounded guess
 */
export function documentPane(s, bound = null) {
  const file = `sam_snapshot_${s.candidate.name.toLowerCase().replace(/\W+/g, '_')}.pdf`;
  const pages = bound?.pages ?? 2;
  const how = bound?.mode === 'typeset'
    ? 'typeset from their Word document — original layout not preserved'
    : 'their own PDF, reproduced page for page';
  return `
  <div class="ab-file sam"><span class="ic">PDF</span><span>${esc(file)}</span><span class="meta">added by Sam · just now</span></div>
  <div class="ab-file"><span class="ic">PDF</span><span>${esc(s.candidate.resume?.name ?? 'resume.pdf')}</span><span class="meta">uploaded by candidate</span></div>
  <div class="viewer" style="height:560px;margin-top:11px">
    <div class="viewer-bar"><span class="nm">${esc(file)}</span><span>${pages} page${pages === 1 ? '' : 's'}</span>
      <span class="tools"><span>−</span><span>100%</span><span>+</span><span>⤓</span></span></div>
    ${snapshotPage(s)}
  </div>
  ${bound?.bound?.length ? `
  <div class="bound">
    <span class="seg sam">${span(1, bound.snapshotPages)} · Snapshot</span>
    ${segments(bound)}
    <span class="how">${esc(how)}</span>
  </div>` : ''}`;
}

/** VERSION — a rich note, shown as it looks after Ashby's sanitiser. */
export function notePane(s, url) {
  const html = composeNoteHtml(s, url);
  return composer + feedItem(`<div class="note-html fade">${html}</div>`);
}

/** VERSION — custom field rows in the Summary rail. */
export function fieldsSummaryExtra(s) {
  const rows = [
    [SAM_CUSTOM_FIELDS.roleFit.name, `${Math.round(s.roleFit * 100)}`],
    [SAM_CUSTOM_FIELDS.coverage.name, `${Math.round(s.coverage * 100)}`],
    [SAM_CUSTOM_FIELDS.capability.name, `${s.capability}`],
    [SAM_CUSTOM_FIELDS.poolRank.name, `${s.pool.roleFitRank} of ${s.pool.size}`],
  ];
  return `
    <div class="ab-sec" style="color:${TEAL.deep}">Sam</div>
    ${rows.map(([k, v]) => `<div class="cf"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join('')}`;
}

/** The feed a reviewer sees when the only placement is fields or a tag. */
export function quietFeedPane(message) {
  return `${composer}
  <div class="ab-card" style="opacity:.6">
    <div class="ab-item"><div class="ab-iav">SY</div><div class="ab-ibody">
      <div class="ab-ihead"><b>Sasha Yee</b> moved to Application Review · 2 days ago</div>
    </div></div>
  </div>
  <div class="ab-empty">${message}</div>`;
}

export { snapshotPage };
