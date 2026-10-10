/**
 * What goes back onto the record once somebody answers.
 *
 * Two surfaces, for two different readers:
 *
 *   THE NOTE — the conversation, in the feed, where the question was asked. Says who
 *     answered, what they said, and what is still open.
 *   THE `Sam Confirmed` FIELD — the summary, beside the score, for the next person who
 *     opens this record and will not scroll the feed.
 *
 * THE HONEST PART, and the reason this file has a paragraph about it: a confirmed
 * requirement DOES NOT MOVE SAM'S SCORE. Sam grades from the documents it was given; a
 * recruiter's answer is not in those documents. Saying "confirmed" beside a Role Fit that
 * still counts the requirement as unmet is a record that disagrees with itself, which is
 * exactly the failure the Snapshot fingerprinting was added to stop. So the note says it
 * plainly rather than leaving the reader to notice.
 *
 * Re-deriving the score here instead would be worse. Grading belongs to Sam — one source of
 * truth — and a second number computed on this side, from a yes/no, would be a number
 * nobody could reproduce or defend.
 */
import { ENDPOINTS, SAM_CUSTOM_FIELDS, CUSTOM_FIELD_OBJECT } from '../../shared/ashby-contract.js';
import { post } from '../endpoints/client.js';
import { conversationFor } from './conversation.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const clamp = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

const nameOf = (by) => [by?.firstName, by?.lastName].filter(Boolean).join(' ').trim() || 'A reviewer';

const shortDate = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB',
    { day: 'numeric', month: 'short', year: 'numeric' });
};

/**
 * The note.
 *
 * @param {object[]} resolved  [{label, confirmed, questionId}] in the order they were asked
 * @param {object}   reply     the parsed reply, for attribution
 * @param {object[]} stillOpen questions with no answer yet
 */
export function composeAcknowledgement({ candidateName, resolved, reply, stillOpen = [] }) {
  if (!resolved?.length) return null;

  const who = nameOf(reply?.by);
  const confirmed = resolved.filter((r) => r.confirmed).length;

  const lines = resolved
    .map((r) => `<li>${r.confirmed ? '✅' : '❌'} <b>${esc(clamp(r.label, 90))}</b>`
      + ` — ${r.confirmed ? 'confirmed' : 'still not evidenced'}</li>`)
    .join('');

  const open = stillOpen.slice(0, 3)
    .map((q) => `<li>${esc(clamp(q.label, 90))}</li>`).join('');

  return [
    `<p><b>Sam · updated from ${esc(who)}</b>`
      + `${reply?.at ? `<br><i>${esc(shortDate(reply.at))}</i>` : ''}</p>`,

    `<ul>${lines}</ul>`,

    `<p>${confirmed} of ${resolved.length} confirmed, recorded against `
      + `${esc(candidateName)}&#39;s grading.</p>`,

    open ? `<p><b>Still open</b></p><ul>${open}</ul>` : '',

    // The disagreement, named before the reader finds it.
    `<p><i>Sam&#39;s score is unchanged — it grades from the documents it was given, and this `
      + 'was not in them. What you confirmed is on the record and goes to Sam with the next '
      + 'grading.</i></p>',
  ].filter(Boolean).join('');
}

/**
 * The `Sam Confirmed` field: the confirmations alone, with who and when.
 *
 * Only the ✅ lines. A ❌ means Sam's reading already stands, and repeating it beside the
 * score would pad the one field a reviewer reads at a glance with information that changes
 * nothing.
 *
 * Built from the WHOLE conversation rather than from this one reply, so the field accumulates
 * across answers instead of being overwritten by the most recent three.
 */
export function confirmedFieldValue(candidateId, jobId, { limit = 480 } = {}) {
  const { asked, answers } = conversationFor(candidateId, jobId);
  const labelOf = new Map(asked.map((q) => [q.id, q.label]));

  const parts = [...answers.values()]
    .filter((a) => a.confirmed)
    .map((a) => {
      const label = labelOf.get(a.questionId) ?? a.questionId;
      const who = nameOf(a.by);
      const when = shortDate(a.at);
      return `${label} (${who}${when ? `, ${when}` : ''})`;
    });

  if (!parts.length) return null;

  // One field, read at a glance. Past the limit it says how many more rather than truncating
  // mid-name, because a half-written person's name reads as a bug.
  let out = '';
  let dropped = 0;
  for (const p of parts) {
    const next = out ? `${out} · ${p}` : p;
    if (next.length > limit) { dropped += 1; continue; }
    out = next;
  }
  return dropped ? `${out} · +${dropped} more` : out;
}

/** Writes the field. Never throws — the note is the record; this is the convenience copy. */
export async function writeConfirmedField({ applicationId, candidateId, jobId }) {
  const value = confirmedFieldValue(candidateId, jobId);
  if (!value) return { ok: false, skipped: true, detail: 'nothing confirmed yet' };
  try {
    const fields = (await post(ENDPOINTS.listCustomFields, {})) ?? [];
    const field = fields.find((f) => f.title === SAM_CUSTOM_FIELDS.confirmed.name && !f.isArchived);
    if (!field) return { ok: false, skipped: true, detail: 'the Sam Confirmed field does not exist yet' };

    await post(ENDPOINTS.setCustomField, {
      objectId: applicationId,
      objectType: CUSTOM_FIELD_OBJECT.application,
      fieldId: field.id,
      fieldValue: value,
    });
    return { ok: true, value };
  } catch (err) {
    return { ok: false, skipped: false, detail: err.message };
  }
}
