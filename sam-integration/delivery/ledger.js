/**
 * Who has already been scored, and what we wrote on them.
 *
 * Two jobs, and they are the same record.
 *
 * 1. **One Snapshot per person per job.** The sweep re-reads Ashby every few hours and will
 *    see the same people again. This is what stops a candidate collecting a new Snapshot on
 *    every pass. The key is `(candidateId, jobId)` and not `candidateId` — one person can
 *    apply to two roles, and they should get a Snapshot for each, scored against each job's
 *    own rubric. Keying on the person alone would give whichever job swept second nothing.
 *
 * 2. **Surviving a merge.** When a coordinator merges two duplicate profiles the losing id
 *    stops resolving, and everything Sam wrote was keyed on it. Given the losing id this
 *    returns what to re-assert against the survivor.
 *
 * In memory here because the mockup is single process. In production this is a table with a
 * unique index on (candidate_id, job_id) — it is the one piece of state Sam cannot be
 * stateless about, and the unique index is what makes a double-delivery impossible rather
 * than merely unlikely under a concurrent sweep.
 */

/** `${candidateId}:${jobId}` -> delivery record */
const byCandidateJob = new Map();

const keyOf = (candidateId, jobId) => `${candidateId}:${jobId}`;

/**
 * @param {object} entry
 * @param {string} entry.candidateId
 * @param {string} entry.jobId          which job this Snapshot was scored against
 * @param {string} entry.applicationId
 * @param {object} entry.snapshot       everything needed to re-render the writes
 * @param {string} entry.dossierUrl
 * @param {string} [entry.filename]     the attached Snapshot, if one landed
 * @param {string} [entry.scoreId]      the engine's id for the score we published
 */
export function record(entry) {
  const saved = { ...entry, recordedAt: new Date(0).toISOString() };
  byCandidateJob.set(keyOf(entry.candidateId, entry.jobId), saved);
  return saved;
}

/** Has this person already been scored for this job? */
export const wasDelivered = (candidateId, jobId) => byCandidateJob.has(keyOf(candidateId, jobId));

/** The delivery for one person on one job. */
export const lookup = (candidateId, jobId) => byCandidateJob.get(keyOf(candidateId, jobId)) ?? null;

/** Every delivery for one person, across all the jobs they applied to. */
export const lookupAll = (candidateId) => [...byCandidateJob.values()]
  .filter((e) => e.candidateId === candidateId);

export const forget = (candidateId, jobId) => byCandidateJob.delete(keyOf(candidateId, jobId));
export const size = () => byCandidateJob.size;
export const reset = () => byCandidateJob.clear();

/**
 * Re-points every delivery from a merged-away candidate to the surviving one.
 *
 * A merge is about the person, not one of their applications, so this moves all of them —
 * someone who applied to three roles keeps all three Snapshots on the surviving record.
 *
 * @returns {object[]} the moved records, empty if Sam never wrote to the losing id
 */
export function repoint(sourceCandidateId, destinationCandidateId) {
  const moved = [];
  for (const entry of lookupAll(sourceCandidateId)) {
    byCandidateJob.delete(keyOf(sourceCandidateId, entry.jobId));
    const next = { ...entry, candidateId: destinationCandidateId, mergedFrom: sourceCandidateId };
    byCandidateJob.set(keyOf(destinationCandidateId, entry.jobId), next);
    moved.push(next);
  }
  return moved;
}
