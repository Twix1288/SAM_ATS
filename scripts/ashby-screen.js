/**
 * A rebuild of Ashby's candidate record, used as the canvas for the Snapshot.
 *
 * The brief requires each version to be shown "at real size, in the space it would
 * actually occupy, next to whatever else is already on that screen". So this renders
 * the full 1440px screen: Ashby's chrome deliberately neutral, ours in Sam teal, so
 * the only coloured thing on the page is the part we are arguing about.
 *
 * Layout follows the researched anatomy — global nav, a candidate header spanning the
 * detail rail and the feed, the Summary rail, and the feed column. There is no right
 * rail, because no Ashby documentation evidences one.
 */
import { SAM, TEAL } from '../shared/brand.js';
import {
  CHROME, VIEWPORT, GLOBAL_NAV, ACTION_BAR, TABS, NATIVE_SUMMARY,
} from '../ashby-simulator/ui-spec.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const pct = (n) => `${Math.round(n * 100)}%`;

/** Ashby's own chrome. Intentionally plain — the Sam surface should be the only accent. */
export const ASHBY_CSS = `
.ashby{width:${VIEWPORT.width}px;height:${VIEWPORT.height}px;background:#F6F7F8;color:#1C1E20;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;
  display:flex;overflow:hidden;border:1px solid #DCE0E3;border-radius:6px;line-height:1.45}

/* global product navigation */
.ab-gnav{width:${CHROME.globalNavWidth}px;flex:none;background:#16191B;color:#fff;
  padding:14px 12px;display:flex;flex-direction:column;gap:2px}
.ab-org{display:flex;align-items:center;gap:9px;padding:6px 8px 14px}
.ab-org .mark{width:22px;height:22px;border-radius:5px;background:#fff;color:#16191B;
  display:grid;place-items:center;font-weight:700;font-size:11px}
.ab-org .nm{font-weight:600;font-size:13px}
.ab-gnav a{display:block;padding:6px 9px;border-radius:5px;color:#A3ABB0;font-size:12.5px;text-decoration:none}
.ab-gnav a.on{background:#24282B;color:#fff;font-weight:500}
.ab-gsearch{margin-top:auto;background:#24282B;border-radius:5px;padding:6px 9px;color:#7E868B;font-size:12px}

/* right of the nav: header on top, then two columns */
.ab-main{flex:1;min-width:0;display:flex;flex-direction:column;background:#F6F7F8}
.ab-header{background:#fff;border-bottom:1px solid #E1E5E8;padding:14px 22px 0;flex:none}
.ab-idrow{display:flex;align-items:flex-start;gap:13px}
.ab-av{width:44px;height:44px;border-radius:50%;background:#E8ECEF;color:#4C5459;
  display:grid;place-items:center;font-weight:600;font-size:15px;flex:none}
.ab-idrow h1{margin:0;font-size:19px;font-weight:600;letter-spacing:-.01em}
.ab-idsub{font-size:12.5px;color:#6E767B;margin-top:1px}
.ab-idsub .co{color:#1C1E20}
.ab-contact{font-size:12px;color:#6E767B;margin-top:3px}
.ab-tags{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px}
.ab-tag{background:#EEF1F3;color:#4C5459;border-radius:4px;padding:2px 8px;font-size:11.5px}
.ab-tag.sam{background:${TEAL.wash};color:${TEAL.ink};border:1px solid ${TEAL.line};font-weight:600}
.ab-acts{display:flex;gap:7px;margin-left:auto;flex-wrap:wrap}
.ab-btn{border:1px solid #D2D7DB;background:#fff;border-radius:5px;padding:5px 11px;font-size:12.5px;color:#35393D}
.ab-btn.primary{background:#16191B;color:#fff;border-color:#16191B}
.ab-btn.danger{color:#B23A2C;border-color:#E7C8C3}
.ab-btn.ghost{border-color:transparent;color:#6E767B}
.ab-tabs{display:flex;gap:1px;margin-top:12px;height:${CHROME.tabBarHeight}px;align-items:flex-end}
.ab-tab{padding:8px 12px;font-size:12.5px;color:#6E767B;border-bottom:2px solid transparent}
.ab-tab.on{color:#16191B;font-weight:600;border-bottom-color:#16191B}

.ab-cols{flex:1;display:flex;min-height:0}
.ab-summary{width:${CHROME.detailRailWidth}px;flex:none;background:#fff;
  border-right:1px solid #E1E5E8;padding:18px;overflow:hidden}
.ab-feed{flex:1;min-width:0;padding:18px 22px;overflow:hidden}

.ab-sec{font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:#868E93;
  font-weight:600;margin:16px 0 8px;padding-bottom:5px;border-bottom:1px solid #EDF0F2}
.ab-sec:first-child{margin-top:0}
.ab-row{display:flex;justify-content:space-between;gap:12px;padding:4px 0;font-size:12.5px}
.ab-row .k{color:#6E767B;flex:none}
.ab-row .v{text-align:right;color:#1C1E20;min-width:0;overflow-wrap:anywhere}
.ab-row .v.link{color:#2B6CBF}

.ab-card{background:#fff;border:1px solid #E1E5E8;border-radius:6px;padding:13px 15px;margin-bottom:11px}
.ab-composer{background:#fff;border:1px solid #E1E5E8;border-radius:6px;padding:10px 13px;
  color:#8A9297;font-size:12.5px;margin-bottom:13px}
.ab-item{display:flex;gap:10px}
.ab-iav{width:26px;height:26px;border-radius:50%;background:#E8ECEF;color:#4C5459;
  display:grid;place-items:center;font-size:10px;font-weight:700;flex:none}
.ab-iav.sam{background:${SAM.teal};color:${SAM.black}}
.ab-ibody{flex:1;min-width:0}
.ab-ihead{font-size:12px;color:#6E767B;margin-bottom:5px}
.ab-ihead b{color:#1C1E20;font-weight:600}
.ab-file{display:flex;align-items:center;gap:10px;border:1px solid #E1E5E8;background:#fff;
  border-radius:5px;padding:9px 12px;font-size:12.5px;margin-bottom:8px}
.ab-file .ic{width:22px;height:26px;border:1px solid #C7CED3;border-radius:2px;flex:none;
  display:grid;place-items:center;font-size:7.5px;color:#6E767B;font-weight:700}
.ab-file .meta{margin-left:auto;color:#8A9297;font-size:11.5px}
.ab-file.sam{border-color:${TEAL.line};background:${TEAL.wash}}
.ab-empty{text-align:center;color:#8A9297;font-size:12px;margin-top:34px;line-height:1.7}
`;

const initialsOf = (name) => name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

function globalNav() {
  return `
  <nav class="ab-gnav">
    <div class="ab-org"><span class="mark">A</span><span class="nm">Agree</span></div>
    ${GLOBAL_NAV.map((i) => `<a href="#" class="${i === 'Candidates' ? 'on' : ''}">${esc(i)}</a>`).join('')}
    <div class="ab-gsearch">Search…</div>
  </nav>`;
}

function header({ candidate, activeTab, tags = [] }) {
  return `
  <div class="ab-header">
    <div class="ab-idrow">
      <div class="ab-av">${esc(initialsOf(candidate.name))}</div>
      <div>
        <h1>${esc(candidate.name)}</h1>
        <div class="ab-idsub">Considered for <span class="co">Sales Account Executive</span> · Application Review</div>
        <div class="ab-contact">${esc(candidate.email ?? '')}${candidate.location ? ` · ${esc(candidate.location)}` : ''}</div>
        <div class="ab-tags">
          <span class="ab-tag">Inbound</span>
          <span class="ab-tag">2026 Q1</span>
          ${tags.map((t) => `<span class="ab-tag sam">${esc(t)}</span>`).join('')}
        </div>
      </div>
      <div class="ab-acts">
        ${ACTION_BAR.map((b) => `<button class="ab-btn ${b.kind}">${esc(b.label)}</button>`).join('')}
      </div>
    </div>
    <div class="ab-tabs">
      ${TABS.map((t) => `<div class="ab-tab${t === activeTab ? ' on' : ''}">${esc(t)}</div>`).join('')}
    </div>
  </div>`;
}

/** The Summary rail: Ashby's native attributes, then anything the integration wrote. */
function summaryRail(candidate, extra = '') {
  return `
  <aside class="ab-summary">
    <div class="ab-sec">Details</div>
    ${NATIVE_SUMMARY.map((f) => `<div class="ab-row"><span class="k">${esc(f.label)}</span><span class="v${f.link ? ' link' : ''}">${esc(f.value(candidate))}</span></div>`).join('')}
    ${extra}
    <div class="ab-sec">Other files</div>
    <div class="ab-file"><span class="ic">PDF</span><span>${esc(candidate.resume?.name ?? 'resume.pdf')}</span></div>
  </aside>`;
}

/**
 * Renders the whole candidate record with one placement dropped into it.
 *
 * @param {object}  opts
 * @param {object}  opts.candidate
 * @param {string}  opts.activeTab      which centre tab is selected
 * @param {string}  opts.feed           HTML for the feed column
 * @param {string} [opts.summaryExtra]  HTML appended to the Summary rail
 * @param {string[]} [opts.tags]        Sam-written tag chips on the header
 */
export function ashbyScreen({ candidate, activeTab, feed, summaryExtra = '', tags = [] }) {
  return `
  <div class="ashby">
    ${globalNav()}
    <div class="ab-main">
      ${header({ candidate, activeTab, tags })}
      <div class="ab-cols">
        ${summaryRail(candidate, summaryExtra)}
        <div class="ab-feed">${feed}</div>
      </div>
    </div>
  </div>`;
}

/* ── the pipeline list ───────────────────────────────────────────────────────
 * Ashby's candidate list for one job. This is where a recruiter triages, and the
 * UNVERIFIED. Ashby documents custom-field columns for Projects, and the only documented
 * column on Application Review is their own AI criteria percentage. This screen shows what
 * we WANT — a graded pool arriving ranked — and it is drawn here precisely so the question
 * is visible rather than buried.
 */
export const PIPELINE_CSS = `
.ab-ptitle{display:flex;align-items:baseline;gap:12px;padding:16px 22px 0}
.ab-ptitle h1{margin:0;font-size:19px;font-weight:600;letter-spacing:-.01em}
.ab-ptitle .sub{font-size:12.5px;color:#6E767B}
.ab-pstages{display:flex;gap:2px;padding:12px 22px 0}
.ab-pstage{padding:7px 12px;font-size:12.5px;color:#6E767B;border-bottom:2px solid transparent}
.ab-pstage.on{color:#16191B;font-weight:600;border-bottom-color:#16191B}
.ab-pstage .ct{color:#9AA1A6;margin-left:5px}
.ab-ptools{display:flex;align-items:center;gap:8px;padding:12px 22px;border-bottom:1px solid #E1E5E8}
.ab-chip{border:1px solid #D2D7DB;background:#fff;border-radius:5px;padding:5px 10px;font-size:12px;color:#42474B}
.ab-chip.sam{border-color:${TEAL.line};background:${TEAL.wash};color:${TEAL.ink};font-weight:600}
.ab-ptable{width:100%;border-collapse:collapse;font-size:12.5px;background:#fff}
.ab-ptable th{text-align:left;padding:9px 14px;font-size:11px;letter-spacing:.05em;text-transform:uppercase;
  color:#868E93;font-weight:600;border-bottom:1px solid #E1E5E8;background:#FAFBFB;white-space:nowrap}
.ab-ptable th.sam{color:${TEAL.deep};background:${TEAL.wash}}
.ab-ptable th.num,.ab-ptable td.num{text-align:right;font-variant-numeric:tabular-nums}
.ab-ptable td{padding:9px 14px;border-bottom:1px solid #EFF2F3;white-space:nowrap}
.ab-ptable td.sam{background:${TEAL.wash};font-weight:600}
.ab-ptable tr.hi td{background:#F4FBFA}
.ab-ptable tr.hi td.sam{background:${TEAL.line}}
.ab-pname{display:flex;align-items:center;gap:9px}
.ab-pav{width:24px;height:24px;border-radius:50%;background:#E8ECEF;color:#4C5459;
  display:grid;place-items:center;font-size:9.5px;font-weight:700;flex:none}
.ab-band{font-size:10.5px;font-weight:700;letter-spacing:.04em;padding:1px 6px;border-radius:3px;
  background:${TEAL.wash};color:${TEAL.ink}}
.ab-sortmark{color:${TEAL.deep};margin-left:3px}
`;

/**
 * @param {object[]} rows  candidates already ranked by Sam
 * @param {string}   [highlight]  name to emphasise, e.g. the one just scored
 */
export function ashbyPipeline({ rows, highlight = null }) {
  return `
  <div class="ashby">
    ${globalNav()}
    <div class="ab-main">
      <div class="ab-ptitle">
        <h1>Sales Account Executive</h1>
        <span class="sub">${rows.length} candidates</span>
      </div>
      <div class="ab-pstages">
        <div class="ab-pstage">Leads <span class="ct">0</span></div>
        <div class="ab-pstage on">Application Review <span class="ct">${rows.length}</span></div>
        <div class="ab-pstage">Screen <span class="ct">0</span></div>
        <div class="ab-pstage">Interview <span class="ct">0</span></div>
        <div class="ab-pstage">Offer <span class="ct">0</span></div>
      </div>
      <div class="ab-ptools">
        <span class="ab-chip">All candidates</span>
        <span class="ab-chip sam">Sorted by Sam Role Fit ↓</span>
        <span class="ab-chip sam">Sam Evidence Coverage ≥ 60</span>
        <span class="ab-chip">+ Filter</span>
      </div>
      <table class="ab-ptable">
        <thead>
          <tr>
            <th>Candidate</th>
            <th>Stage</th>
            <th>Applied</th>
            <th class="sam num">Sam Role Fit <span class="ab-sortmark">↓</span></th>
            <th class="sam num">Sam Evidence Coverage</th>
            <th class="sam num">Sam Capability</th>
            <th class="sam">Sam Pool Rank</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r) => `
            <tr class="${highlight && r.name === highlight ? 'hi' : ''}">
              <td>
                <span class="ab-pname">
                  <span class="ab-pav">${esc(r.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase())}</span>
                  ${esc(r.name)}
                </span>
              </td>
              <td style="color:#6E767B">Application Review</td>
              <td style="color:#6E767B">Dec 11, 2025</td>
              <td class="sam num">${r.roleFit}</td>
              <td class="sam num">${r.coverage}</td>
              <td class="sam num">${r.capability}</td>
              <td class="sam">${esc(r.rank)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
      <div style="padding:12px 22px;color:#8A9297;font-size:12px">
        Showing ${rows.length} of 41 · the other ${41 - rows.length} scored below this threshold
      </div>
    </div>
  </div>`;
}
