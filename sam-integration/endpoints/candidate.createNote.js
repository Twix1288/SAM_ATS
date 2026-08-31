/**
 * Ashby candidate.createNote — DELIVERABLE 2, the rich note.
 *
 * Note the endpoint name: `candidate.createNote`. The original plan called this
 * `candidateNote.create`, which does not exist.
 *
 * `note` accepts either a bare string or { type, value } where type is 'text/plain' or
 * 'text/html'. Rich formatting and embedded TABLES render natively in the activity feed,
 * so the anchors, the quoted evidence and the coverage gaps all ship as real tables —
 * this is the version a reviewer actually reads, so it carries structure, not prose.
 *
 * Still no CSS and no images: no styling contract is published, and a note that depended
 * on one would degrade invisibly.
 */
import { ENDPOINTS } from '../../shared/ashby-contract.js';
import { post } from './client.js';

const pct = (n) => `${Math.round(n * 100)}%`;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Anchor states carry meaning, so each gets a mark that survives plain text. */
const MARK = { MET: '✓', PARTIAL: '~', NOT_MET: '✕', NOT_COLLECTED: '–' };

const STATE_WORD = {
  MET: 'met',
  PARTIAL: 'partial',
  NOT_MET: 'not met',
  NOT_COLLECTED: 'never asked',
};

/**
 * The one-line headline. Role Fit is never written without its coverage — a bare
 * percentage implies the whole rubric was observable, and here it was not.
 *
 * Below the coverage floor it is not written at all. The note is the surface a reviewer
 * reads without clicking, so it is the last place to put a number the document itself
 * refuses to print.
 */
const headline = (s) => {
  const rank = s.pool ? ` · rank ${s.pool.roleFitRank} of ${s.pool.size}` : '';
  if (s.scoreIsPublishable === false) {
    return `Not scored — only ${pct(s.coverage)} of the rubric was observable from the `
      + `inputs available · Capability ${s.capability}/10${rank}`;
  }
  return `Role Fit ${pct(s.roleFit)} at ${pct(s.coverage)} evidence coverage · `
    + `Capability ${s.capability}/10${rank}`;
};

/** Plain-text note. The floor: what survives if HTML is rejected entirely. */
/**
 * What the note is allowed to claim about the attachment.
 *
 * The pipeline only passes page counts when the resume actually bound in, so a note can
 * never advertise evidence the document does not carry. If the stitch fell back, the
 * sentence falls back with it.
 */
function attachmentSuffix(attachment) {
  if (!attachment?.resumePages) return ', attached to this candidate';
  const how = attachment.mode === 'typeset' ? ' as text' : '';
  const extras = attachment.extras
    ? `, and ${attachment.extras} they also submitted but Sam did not score`
    : '';
  return `, ${attachment.pages} pages with their own resume bound in behind it${how}${extras}`;
}

export function composeNote(snapshot, dossierUrl, attachment = null) {
  const s = snapshot;
  const lines = [
    `Sam Snapshot — ${s.candidate.name}`,
    `Matched to ${s.role.title} · ${s.role.company}`,
    '',
    headline(s),
    `Band: ${s.band}`,
    '',
    `Recommended next step: ${s.recommendedNextStep}`,
    '',
    `Role anchors (${s.anchorSummary.met} met of ${s.anchorSummary.observable} observable):`,
    ...s.roleAnchors.map((a) => `  ${MARK[a.state]} ${a.label} — ${STATE_WORD[a.state]}`),
    '',
    s.netRead,
    '',
    'Gaps to investigate:',
    ...s.gapsToInvestigate.map((g) => `  - ${g.label} — ${g.reason}`),
  ];

  if (s.caveats?.length) lines.push('', 'Caveats:', ...s.caveats.map((c) => `  - ${c}`));

  lines.push('');
  if (attachment) lines.push(`Full Snapshot attached to this candidate: ${attachment.filename}${attachmentSuffix(attachment)}`);
  lines.push(`Evidence, interview audio and the original resume: ${dossierUrl}`);
  return lines.join('\n');
}

/**
 * Rich-text note — the version a reviewer actually reads, because the feed is the default
 * tab and nothing needs opening. Tables let it carry the reasoning, not just the score.
 */
export function composeNoteHtml(snapshot, dossierUrl, attachment = null) {
  const s = snapshot;

  // Tables render natively in the activity feed, so the anchor list ships as a real
  // table rather than a bulleted approximation of one. Each row keeps its state and the
  // reason behind it, which is the part a reviewer needs in order to disagree with us.
  const anchorRows = s.roleAnchors.map((a) => `<tr>`
    + `<td>${MARK[a.state]} ${esc(a.label)}</td>`
    + `<td><b>${esc(STATE_WORD[a.state])}</b></td>`
    + `<td>${esc(a.reason)}</td></tr>`).join('');

  const evidenceRows = (s.evidenceQuotes ?? []).map((q) => `<tr>`
    + `<td>${esc(q.anchor)}</td>`
    + `<td><i>“${esc(q.quote)}”</i><br><code>column ${esc(q.column)}</code></td></tr>`).join('');

  const gapRows = (s.coverageGaps ?? []).map((g) => `<tr>`
    + `<td>${esc(g.label)}</td><td>${esc(g.status)}</td></tr>`).join('');

  const routes = [
    attachment ? `<li><b>${esc(attachment.filename)}</b> — the full Snapshot${esc(attachmentSuffix(attachment))}</li>` : '',
    `<li><a href="${esc(dossierUrl)}">Open the evidence</a> — every quoted span, the interview recordings, and the original resume</li>`,
  ].filter(Boolean).join('');

  return [
    `<p><b>Sam Snapshot — ${esc(s.candidate.name)}</b><br>`,
    `Matched to ${esc(s.role.title)} · ${esc(s.role.company)}</p>`,

    `<p><b>${esc(headline(s))}</b><br>Band: ${esc(s.band)}</p>`,

    `<p><b>Recommended next step.</b> ${esc(s.recommendedNextStep)}</p>`,

    `<h4>Role anchors — ${s.anchorSummary.met} met of ${s.anchorSummary.observable} observable`,
    s.anchorSummary.notCollected ? `, ${s.anchorSummary.notCollected} never asked</h4>` : '</h4>',
    `<table><thead><tr><th>Anchor</th><th>State</th><th>Why</th></tr></thead>`,
    `<tbody>${anchorRows}</tbody></table>`,

    evidenceRows
      ? `<h4>Evidence</h4><table><thead><tr><th>Anchor</th><th>Quoted from their responses</th></tr></thead>`
        + `<tbody>${evidenceRows}</tbody></table>`
      : '',

    gapRows
      ? `<h4>Coverage gaps</h4><table><thead><tr><th>Requirement</th><th>Status</th></tr></thead>`
        + `<tbody>${gapRows}</tbody></table>`
      : '',

    (s.capabilitySignals?.met?.length
      ? `<h4>How they work — ${s.capability}/10</h4><p>${esc(s.capabilitySignals.met.join(' · '))}.`
        + (s.capabilitySignals.missing?.length
          ? `<br><i>Not evidenced: ${esc(s.capabilitySignals.missing.join(' · '))}.</i></p>` : '</p>')
      : ''),

    `<h4>Net read</h4><p>${esc(s.netRead)}</p>`,

    `<h4>Gaps to investigate</h4><ul>`,
    s.gapsToInvestigate.map((g) => `<li><b>${esc(g.label)}</b> — ${esc(g.reason)}</li>`).join(''),
    `</ul>`,
    s.caveats?.length ? `<ul>${s.caveats.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : '',

    `<h4>Where to look next</h4><ul>${routes}</ul>`,
  ].join('');
}

/**
 * Writes the note. Prefers HTML; if Ashby rejects the typed form, retries once as plain
 * text so a sanitisation surprise degrades the note rather than dropping it.
 *
 * `attachment` is passed in by the delivery pipeline only after the file has actually
 * landed, so the note can never advertise a document that is not there.
 */
export async function createSnapshotNote({
  candidateId, snapshot, dossierUrl, deliveryId, attachment = null, format = 'html',
}) {
  const html = composeNoteHtml(snapshot, dossierUrl, attachment);
  const plain = composeNote(snapshot, dossierUrl, attachment);

  // The headline carries this run's Role Fit, coverage, capability and rank, which makes
  // it a good enough fingerprint to recognise our own note without polluting it with a
  // visible marker. Used only to avoid double-posting on retry.
  const alreadyPosted = () => noteAlreadyExists(candidateId, headline(snapshot));

  if (format === 'html') {
    try {
      await post(ENDPOINTS.createNote, {
        candidateId,
        note: { type: 'text/html', value: html },
        sendNotifications: false,
      }, { idempotencyKey: `${deliveryId}:note`, verify: alreadyPosted });
      return { format: 'text/html', body: html, plain, referencesAttachment: Boolean(attachment) };
    } catch (err) {
      if (!(err?.status >= 400 && err.status < 500)) throw err;
    }
  }

  await post(ENDPOINTS.createNote, {
    candidateId,
    note: { type: 'text/plain', value: plain },
    sendNotifications: false,
  }, { idempotencyKey: `${deliveryId}:note`, verify: alreadyPosted });
  return { format: 'text/plain', body: plain, plain, referencesAttachment: Boolean(attachment) };
}

/**
 * Asks Ashby whether this exact note is already on the candidate.
 *
 * candidate.createNote appends rather than upserts, so this is what stands between a
 * retried delivery and two identical tables in the activity feed.
 */
export async function noteAlreadyExists(candidateId, fingerprint) {
  const notes = await post(ENDPOINTS.listNotes, { candidateId });
  const hit = (notes ?? []).find((n) => String(n?.content?.value ?? '').includes(fingerprint));
  return hit ? { id: hit.id, createdAt: hit.createdAt, deduplicated: true } : null;
}
