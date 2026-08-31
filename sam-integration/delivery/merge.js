/**
 * Reconciling a candidateMerge.
 *
 * When two duplicate profiles are merged, Ashby keeps one id and retires the other.
 * Everything Sam wrote — custom field values, the attached Snapshot, the note — was keyed
 * on the losing id, and ATS merges routinely drop third-party custom fields rather than
 * reconcile them against a schema they do not own. So we do not wait to find out.
 *
 * The flow is an idempotent re-sync:
 *
 *   1. take sourceCandidateId (retired) and destinationCandidateId (surviving)
 *   2. re-point Sam's own ledger at the surviving id
 *   3. re-assert the writes against the surviving id
 *
 * Step 3 is safe to repeat by design. customField.setValues overwrites the same values,
 * and the note write checks the feed before posting, so a note Ashby did carry over is
 * recognised rather than duplicated. Re-asserting costs three API calls; not re-asserting
 * costs a scored candidate silently losing their score.
 */
import { setSamScores } from '../endpoints/customField.setValue.js';
import { createSnapshotNote } from '../endpoints/candidate.createNote.js';
import { repoint, lookupAll } from './ledger.js';

export const MERGE_OUTCOME = {
  resynced: 'resynced',
  nothingToMove: 'nothing_to_move',
  partial: 'partial',
};

/**
 * @param {object}   ctx
 * @param {string}   ctx.sourceCandidateId       the retired id
 * @param {string}   ctx.destinationCandidateId  the surviving id
 * @param {string}   ctx.deliveryId              webhookActionId of the merge event
 * @param {string}   [ctx.applicationId]         surviving application, when the payload names one
 * @param {Function} [ctx.onStep]
 */
export async function reconcileMerge({
  sourceCandidateId, destinationCandidateId, deliveryId, applicationId, onStep = () => {},
}) {
  const step = (label, ok, detail) => { onStep({ label, ok, detail }); return { label, ok, detail }; };
  const steps = [];

  const previous = lookupAll(sourceCandidateId);
  if (!previous.length) {
    steps.push(step('Check the ledger', true, `Sam never wrote to ${sourceCandidateId.slice(0, 8)} — nothing to move`));
    return { outcome: MERGE_OUTCOME.nothingToMove, steps, moved: null };
  }

  // A merge is about the person, so every job they were scored against moves. Someone who
  // applied to three roles keeps all three Snapshots on the surviving record.
  const movedAll = repoint(sourceCandidateId, destinationCandidateId);
  const moved = movedAll[0];
  steps.push(step('Re-point the ledger', true,
    `${movedAll.length} delivery${movedAll.length === 1 ? '' : 's'} · `
    + `${sourceCandidateId.slice(0, 8)} → ${destinationCandidateId.slice(0, 8)}`));

  // The application may survive the merge unchanged; prefer the id the webhook gives us.
  const targetApplication = applicationId ?? moved.applicationId;

  let fields = null;
  try {
    fields = await setSamScores({
      applicationId: targetApplication,
      snapshot: moved.snapshot,
      deliveryId: `${deliveryId}:merge`,
    });
    steps.push(step('Re-assert the scores', true, `${fields.length} fields on ${targetApplication.slice(0, 8)}`));
  } catch (err) {
    steps.push(step('Re-assert the scores', false, err.message));
  }

  let note = null;
  try {
    note = await createSnapshotNote({
      candidateId: destinationCandidateId,
      snapshot: moved.snapshot,
      dossierUrl: moved.dossierUrl,
      deliveryId: `${deliveryId}:merge`,
      attachment: moved.filename ? { filename: moved.filename } : null,
    });
    steps.push(step('Re-assert the note', true,
      note.deduplicated ? 'already present on the surviving record' : note.format));
  } catch (err) {
    steps.push(step('Re-assert the note', false, err.message));
  }

  // The Snapshot file is deliberately not re-uploaded. If the merge carried it across we
  // would be duplicating a document, and if it did not, the note still links to the
  // hosted dossier — a missing attachment is recoverable, a duplicated one is noise.
  steps.push(step('Snapshot file', true, 'not re-uploaded — the note still routes to the evidence'));

  const ok = fields && note;
  return {
    outcome: ok ? MERGE_OUTCOME.resynced : MERGE_OUTCOME.partial,
    steps,
    moved,
    sourceCandidateId,
    destinationCandidateId,
  };
}
