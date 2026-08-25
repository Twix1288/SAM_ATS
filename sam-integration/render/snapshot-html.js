/**
 * The Snapshot rendered as HTML, at page proportions.
 *
 * Shared by the static canvas and the interactive Ashby mockup so the two cannot drift.
 * Mirrors the pdf-lib render in `snapshot.js` field for field — if one changes, the other
 * has to change with it, which is why they read from the same brand tokens and the same
 * view model.
 */
import { SAM, TEAL, INK, STATE_COLOR } from '../../shared/brand.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const pct = (n) => `${Math.round(n * 100)}%`;

const STATE_LABEL = {
  MET: 'Met', PARTIAL: 'Partial', NOT_MET: 'Not met', NOT_COLLECTED: 'Not collected',
};

/** Page styling. Emitted once per document rather than inlined on every element. */
export const SNAPSHOT_CSS = `
.page{background:#fff;width:600px;margin:0 auto;font-family:${SAM.fontStack};
  box-shadow:0 3px 14px rgba(0,0,0,.32);overflow:hidden}
.pg-head{background:${SAM.black};color:#fff;padding:15px 19px 13px;
  border-bottom:3px solid ${SAM.teal};display:flex;gap:12px}
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
.pg-quote{margin:5px 0 0;padding:5px 8px;background:${INK[100]};border-left:2px solid ${SAM.teal};
  font-size:8px;font-style:italic;color:${INK[700]}}
.pg-quote cite{display:block;font-style:normal;font-size:7px;color:${INK[400]};margin-top:3px}
.pg-cols{display:grid;grid-template-columns:1fr 1fr;gap:13px}
.pg-chip{display:inline-block;background:${TEAL.wash};color:${TEAL.deep};border:1px solid ${TEAL.line};
  border-radius:9px;padding:1px 6px;font-size:7.5px;margin:0 3px 3px 0}
.pg-foot{border-top:1px solid ${INK[200]};margin-top:11px;padding-top:6px;display:flex;
  justify-content:space-between;font-size:7px;color:${INK[400]}}
`;

const stateChip = (st) => {
  const c = STATE_COLOR[st];
  return `<span class="st" style="color:${c.fg};background:${c.bg}">${STATE_LABEL[st]}</span>`;
};

/** @param {object} s the Snapshot view model from render/model.js */
export function snapshotPageHtml(s) {
  return `
  <div class="page">
    <div class="pg-head">
      <div>
        <div class="nm">${esc(s.candidate.name)}</div>
        <div class="sub">Matched to <b>${esc(s.role.title)}</b> · ${esc(s.role.company)}</div>
        <div class="pool">Top ${s.pool.topPercent}% of pool · ${s.pool.size} applicants · scored from ${esc(s.provenance)}</div>
      </div>
      <div class="sc">
        <div class="n">${pct(s.roleFit)}</div>
        <div class="l">Role fit</div>
        <div class="c">${pct(s.coverage)} coverage</div>
      </div>
    </div>
    <div class="pg-body">
      <div class="pg-next">
        <div class="h">Recommended next step</div>
        <p>${esc(s.recommendedNextStep)}</p>
      </div>

      <div class="pg-h">Role anchors · ${s.anchorSummary.met} met of ${s.anchorSummary.observable} observable</div>
      ${s.roleAnchors.map((a) => `
        <div class="pg-a">
          <div class="bar" style="background:${STATE_COLOR[a.state].fg}"></div>
          <div class="t">
            <b>${esc(a.label)}</b><p>${esc(a.reason)}</p>
            ${a.spans?.length ? `<div class="pg-quote">"${esc(a.spans[0].quote)}"<cite>column ${esc(a.spans[0].column)}</cite></div>` : ''}
          </div>
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
      ${s.gapsToInvestigate.map((g) => `<div style="padding:1.5px 0"><b>${esc(g.label)}</b> — <span style="color:${INK[500]}">${esc(g.reason)}</span></div>`).join('')}
      ${(s.caveats ?? []).map((c) => `<div style="padding:1.5px 0;color:${STATE_COLOR.NOT_MET.fg}">${esc(c)}</div>`).join('')}

      <div class="pg-foot">
        <span>Powered by <b>Sam</b> for ${esc(s.role.company)}</span>
        <span>Role fit ${pct(s.roleFit)} at ${pct(s.coverage)} coverage · evidence-bound</span>
      </div>
    </div>
  </div>`;
}
