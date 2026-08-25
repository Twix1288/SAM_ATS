/**
 * What Sam has written, and where.
 *
 * Everything Sam writes is keyed on Ashby's candidateId and applicationId. When a
 * coordinator merges two duplicate profiles, the losing id stops resolving — so without
 * a record of what we put there, a merge is silent data loss on a record the hiring team
 * still trusts.
 *
 * This ledger is what makes the merge recoverable: given the losing id, it returns
 * everything needed to re-assert the same values against the surviving one.
 *
 * In-memory here because the mockup is single-process. In production this is a row per
 * delivery, and it is the one piece of state Sam genuinely cannot be stateless about.
 */

/** candidateId -> delivery record */
const byCandidate = new Map();

/**
 * @param {object} entry
 * @param {string} entry.candidateId
 * @param {string} entry.applicationId
 * @param {object} entry.snapshot     everything needed to re-render the writes
 * @param {string} entry.dossierUrl
 * @param {string} [entry.filename]   the attached Snapshot, if one landed
 */
export function record(entry) {
  byCandidate.set(entry.candidateId, { ...entry, recordedAt: new Date(0).toISOString() });
  return entry;
}

export const lookup = (candidateId) => byCandidate.get(candidateId) ?? null;
export const forget = (candidateId) => byCandidate.delete(candidateId);
export const size = () => byCandidate.size;

/**
 * Re-points a delivery from a merged-away candidate to the surviving one.
 * Returns the moved record, or null if Sam never wrote to the losing id.
 */
export function repoint(sourceCandidateId, destinationCandidateId) {
  const entry = byCandidate.get(sourceCandidateId);
  if (!entry) return null;
  const moved = { ...entry, candidateId: destinationCandidateId, mergedFrom: sourceCandidateId };
  byCandidate.set(destinationCandidateId, moved);
  byCandidate.delete(sourceCandidateId);
  return moved;
}
