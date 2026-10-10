/**
 * Ashby customField.setValues — writes Sam's scores onto the application.
 *
 * Uses the BATCH endpoint. Ashby documents a race condition when several single
 * setValue calls are fired concurrently at the same object, which is exactly the
 * shape of writing four fields at once.
 */
import { ENDPOINTS, SAM_CUSTOM_FIELDS, CUSTOM_FIELD_OBJECT } from '../../shared/ashby-contract.js';
import { raiseAlert, ALERT, SEVERITY } from '../delivery/alerts.js';
import { post, resolveCustomFieldIds } from './client.js';

/**
 * Role Fit is never written without Coverage. A bare score in an ATS recreates the
 * exact problem this engine exists to prevent, one system downstream.
 */
/**
 * What we send to empty a field we are no longer willing to assert.
 *
 * Ashby does not document how to clear a custom field value — the per-type table covers
 * what to send to SET one and says nothing about unsetting. `null` is the reading that
 * matches every other JSON API, and it is isolated here so a correction is one line. It is
 * on the questions list.
 *
 * If Ashby rejects null the batch fails loudly, which is the right failure: a visible error
 * beats a stale score sitting in a filterable column with nothing marking it as old.
 */
export const CLEAR = null;

/**
 * The values Sam writes into Ashby's own fields.
 *
 * Separated from the call so what we are willing to assert about a candidate is testable
 * without a network in reach — these four numbers are the ones a reviewer sorts and filters
 * on, and getting them wrong is the most consequential thing this integration can do.
 *
 * @param {object} snapshot
 * @returns {{field: object, value: number|string}[]}
 */
export function samFieldValues(snapshot) {
  // EVERY field is written on EVERY delivery, and a value we will not assert is sent as an
  // explicit clear rather than omitted.
  //
  // This is the whole point of the function. customField.setValues merges — it touches only
  // the fields named in the call — so skipping a field leaves whatever was there before.
  // The candidate re-scored from 72% coverage down to 40% would keep last sweep's Role Fit
  // sitting in Ashby's filterable column, now attached to a read that no longer supports it.
  // A stale number is worse than the misleading number we refused to write, because nothing
  // on the record marks it as old.
  return [
    // Role Fit is what a reviewer sorts and filters on, so it must never overstate. Below
    // the coverage floor it is cleared: an empty cell reads as "not scored", where a 100
    // from one observable anchor reads as the best candidate in the pipeline.
    {
      field: SAM_CUSTOM_FIELDS.roleFit,
      value: snapshot.scoreIsPublishable === false ? CLEAR : Math.round(snapshot.roleFit * 100),
    },
    // The denominator, from whichever the payload actually carries.
    //
    // Sam sends no coverage figure, so `Math.round(null * 100)` wrote a literal 0 into a
    // filterable column — a candidate scored 94 appearing to have zero evidence behind it.
    // Cleared rather than faked when absent, and the anchor count carries the denominator
    // instead.
    {
      field: SAM_CUSTOM_FIELDS.coverage,
      value: Number.isFinite(snapshot.coverage) ? Math.round(snapshot.coverage * 100) : CLEAR,
    },
    {
      field: SAM_CUSTOM_FIELDS.anchorsMet,
      value: snapshot.anchorSummary?.total
        ? `${(snapshot.anchorSummary.met ?? 0) + (snapshot.anchorSummary.metEquivalent ?? 0)} of ${snapshot.anchorSummary.total}`
        : CLEAR,
    },
    { field: SAM_CUSTOM_FIELDS.capability, value: snapshot.capability },
    // A scheduled sweep scores one person and has no cohort. Rank is cleared rather than
    // invented — and cleared rather than skipped, so a candidate who had a rank from a
    // batch run does not keep it through a sweep that could not compute one.
    {
      field: SAM_CUSTOM_FIELDS.poolRank,
      value: snapshot.pool
        ? `${snapshot.pool.roleFitRank} of ${snapshot.pool.size} (top ${snapshot.pool.topPercent}%)`
        : CLEAR,
    },

    // The three that make the Summary tab answer "what do I do with this person" rather
    // than only "what did they score". Each is cleared rather than omitted when there is
    // nothing to assert — setValues MERGES, so skipping a field leaves last pass's text.
    { field: SAM_CUSTOM_FIELDS.band, value: bandWithProvenance(snapshot) },
    { field: SAM_CUSTOM_FIELDS.nextStep, value: directive(snapshot.recommendedNextStep) },
    // Provenance, verbatim from what the engine says it read. The most important field on
    // a thin read: "résumé" next to a 40% coverage explains the number at a glance.
    { field: SAM_CUSTOM_FIELDS.readFrom, value: snapshot.provenance || CLEAR },
  ];
}

/**
 * The DIRECTIVE out of a recommended next step, not the first hundred characters of one.
 *
 * Sam writes these as a verdict followed by its qualifications: "Strong enough to interview.
 * Confirm health-services context and formal P&L ownership when you do." Cutting at a
 * character count produced "Strong enough to interview. Confirm health-services context and
 * formal…" — a sentence severed mid-thought, in a narrow rail, while the complete version
 * sat in the note a few inches away.
 *
 * Taking the first sentence gives the rail the part that is actually an instruction and
 * leaves the qualifications to the note, which has room for them. If that sentence is itself
 * too long for one line, it is then — and only then — trimmed at a word boundary.
 */
const SUMMARY_FIELD_MAX = 110;
function directive(text) {
  const s = String(text ?? '').trim();
  if (!s) return CLEAR;

  // First sentence: a full stop followed by a space and a capital. Avoids splitting on
  // "$3M." or "Inc." mid-clause, which a bare /\./ would.
  const first = /^(.+?[.!?])(\s+[A-Z]|$)/.exec(s);
  const head = (first ? first[1] : s).trim();

  if (head.length <= SUMMARY_FIELD_MAX) return head;
  const cut = head.slice(0, SUMMARY_FIELD_MAX);
  return `${cut.slice(0, cut.lastIndexOf(' ')) || cut}…`;
}

/**
 * The verdict, carrying how it was reached.
 *
 * "Strong" on its own invites the reader to weigh it as if the whole role had been assessed.
 * "Strong · résumé only" is the same verdict with the one qualification that changes how much
 * weight it deserves — and it is the single most useful thing the rail can say, because it
 * travels with the number a recruiter sorts on.
 */
const bandWithProvenance = (snapshot) => {
  const band = String(snapshot.band ?? '').trim();
  if (!band) return CLEAR;
  const read = String(snapshot.provenance ?? '').trim();
  return read ? `${band} · ${read} only` : band;
};

export async function setSamScores({ applicationId, snapshot, deliveryId }) {
  const values = samFieldValues(snapshot);

  // Only the fields this call actually WRITES, not every field the contract declares.
  //
  // `resolveCustomFieldIds` throws when a title is missing, which is right for a field we
  // are about to write and wrong for one we are not. Resolving the whole of
  // SAM_CUSTOM_FIELDS meant that adding a declaration — `Sam Confirmed`, written by the
  // conversation and never by this function — made EVERY score write fail in any org that
  // had not provisioned it yet. Caught by preflight against the simulator; in a client org
  // it would have been every candidate's fields silently not landing after an upgrade.
  const ids = await resolveCustomFieldIds(values.map((v) => v.field.name));

  const wire = (list) => list.map(({ field, value }) => ({ fieldId: ids.get(field.name), fieldValue: value }));
  const cleared = values.filter((v) => v.value === CLEAR);

  try {
    await post(ENDPOINTS.setCustomFields, {
      objectId: applicationId,
      objectType: CUSTOM_FIELD_OBJECT.application,
      values: wire(values),
    }, { idempotencyKey: `${deliveryId}:customFields` });
  } catch (err) {
    // Clearing rests on an undocumented assumption: that null unsets a value. If Ashby
    // rejects it the whole batch is refused — and then we would lose the coverage and
    // capability writes too, which are the numbers that explain a withheld score. So the
    // real values go in on their own and the failure is reported rather than swallowed.
    if (!cleared.length) throw err;

    const names = cleared.map((v) => v.field.name);
    let kept = 0;
    try {
      const rest = values.filter((v) => v.value !== CLEAR);
      await post(ENDPOINTS.setCustomFields, {
        objectId: applicationId,
        objectType: CUSTOM_FIELD_OBJECT.application,
        values: wire(rest),
      }, { idempotencyKey: `${deliveryId}:customFields:noclear` });
      kept = rest.length;
    } catch { /* reported below — the alert matters more than this second failure */ }

    // This is the one failure where doing nothing leaves wrong data in front of a user, so
    // it does not rely on anyone reading the response. A scheduled sweep has no reader.
    raiseAlert({
      code: ALERT.staleScoreVisible,
      severity: SEVERITY.critical,
      message: `Could not clear ${names.join(', ')} on application ${applicationId}. `
        + 'A previously published score is still visible in Ashby and is no longer supported '
        + 'by the current evidence. Clear it by hand, or fix the clear mechanism.',
      context: {
        applicationId,
        deliveryId,
        fields: names,
        wroteAnyway: kept,
        ashbyError: err.message,
        // The value we sent is the assumption under test. If this alert ever fires in
        // production, this is the line that tells us null was the wrong guess.
        attemptedClearValue: CLEAR,
      },
    });

    throw new Error(
      `Wrote ${kept} of ${values.length} fields, but could not clear ${names.join(', ')} — `
      + `Ashby rejected the clear (${err.message}). A stale score is still showing on this `
      + 'record; an alert has been raised.',
    );
  }

  return values.map(({ field, value }) => ({ name: field.name, value }));
}
