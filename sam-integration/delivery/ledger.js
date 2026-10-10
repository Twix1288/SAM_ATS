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

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** `${candidateId}:${jobId}` -> delivery record */
const byCandidateJob = new Map();

/**
 * Keys claimed by a delivery that is in flight right now.
 *
 * Held separately from the durable map because a claim is NOT a delivery: it must never be
 * written to disk, and it must disappear if the process dies. Its only job is to stop two
 * concurrent passes in one process from both deciding a candidate needs grading.
 */
const inFlight = new Set();

const keyOf = (candidateId, jobId) => `${candidateId}:${jobId}`;

/**
 * Where the ledger survives a restart.
 *
 * Append-only JSONL, replayed at boot — the same primitive alerts.js already uses, no new
 * dependency and no schema to migrate. A later row for the same key wins, so a re-delivery
 * that fills in a missing surface simply appends and the replay folds it over the old one.
 *
 * This file is the ONLY thing standing between a restart and a second Snapshot on a real
 * person's record. Until it existed, every run began with an empty Map and re-delivered
 * everyone it could still see.
 */
const LEDGER_FILE = process.env.SAM_LEDGER ?? '.sam/ledger.jsonl';
let loaded = false;

/** The three surfaces a complete delivery puts on the record. */
export const SURFACES = ['fields', 'attachment', 'note'];

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  if (!existsSync(LEDGER_FILE)) return;
  try {
    for (const line of readFileSync(LEDGER_FILE, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry?.candidateId && entry?.jobId) {
          byCandidateJob.set(keyOf(entry.candidateId, entry.jobId), entry);
        }
      } catch { /* one corrupt line must not cost us the whole ledger */ }
    }
  } catch { /* unreadable ledger degrades to in-memory, which the caller will notice */ }
}

/**
 * @param {object} entry
 * @param {string} entry.candidateId
 * @param {string} entry.jobId          which job this Snapshot was scored against
 * @param {string} entry.applicationId
 * @param {object} entry.snapshot       everything needed to re-render the writes
 * @param {string} entry.dossierUrl
 * @param {string} [entry.filename]     the attached Snapshot, if one landed
 * @param {string} [entry.scoreId]      the engine's id for the score we published
 * @param {object} [entry.surfaces]     {fields, attachment, note} — which writes LANDED
 */
export function record(entry) {
  ensureLoaded();
  const saved = {
    ...entry,
    // Default COMPLETE. A caller that records a delivery without saying which surfaces
    // landed means "this is done" — only a caller that knows it was partial says so, and
    // pipeline.js does. Defaulting the other way would make every existing row look
    // undelivered and re-grade the entire pipeline on first run.
    surfaces: { ...surfacesOf(true), ...(entry.surfaces ?? {}) },
    recordedAt: entry.recordedAt ?? new Date(0).toISOString(),
  };
  byCandidateJob.set(keyOf(entry.candidateId, entry.jobId), saved);

  try {
    mkdirSync(dirname(LEDGER_FILE), { recursive: true });
    appendFileSync(LEDGER_FILE, `${JSON.stringify(saved)}\n`);
  } catch {
    // A ledger we cannot persist is a ledger that will re-deliver after a restart. The
    // delivery itself already succeeded, so throwing here would be worse — but the caller
    // is told, because silently degrading to in-memory is how duplicates happen.
    saved.persisted = false;
  }
  return saved;
}

const surfacesOf = (v) => ({ fields: Boolean(v), attachment: Boolean(v), note: Boolean(v) });

/**
 * Has this person already been FULLY delivered for this job?
 *
 * Deliberately not "is there a row": a delivery where the fields landed and the note did not
 * is not done. Treating it as done leaves a score on the record with no note explaining it,
 * permanently, because nothing would ever look at that candidate again.
 *
 * A partial row still suppresses nothing — the next pass re-runs the candidate, and each
 * write endpoint is either idempotent (setValues, uploadFile) or guarded by `verify`
 * (createNote), so finishing the job costs one repeat of what already succeeded.
 */
export function wasDelivered(candidateId, jobId) {
  ensureLoaded();
  const entry = byCandidateJob.get(keyOf(candidateId, jobId));
  if (!entry) return false;

  // A FAILURE ROW IS NOT A DELIVERY. It carries no `surfaces`, and the legacy rule below
  // would read that absence as "complete" — so recording an attempt would have silently
  // stopped the candidate ever being retried, which is the exact opposite of why the row
  // is written. Checked first, before anything else can misread it.
  if (entry.failed) return false;

  // Rows written before surfaces were tracked have no map; treat them as complete rather
  // than re-delivering everyone the first time this ships.
  if (!entry.surfaces) return true;
  return SURFACES.every((s) => entry.surfaces[s]);
}

/**
 * A candidate we tried and could not grade.
 *
 * Recorded so the attempt SURVIVES A RESTART. Without this a candidate whose résumé the
 * engine chokes on is retried on every pass forever — each one costing a full engine call —
 * and nothing anywhere counts how many times it has happened. An in-memory counter would be
 * no counter at all, because every pass is a fresh process.
 *
 * The row carries no `surfaces`, so `wasDelivered` stays false and the next pass still
 * retries — until the cap.
 */
export function recordFailure({ candidateId, jobId, detail }) {
  ensureLoaded();
  const prior = byCandidateJob.get(keyOf(candidateId, jobId));
  const saved = {
    candidateId,
    jobId,
    failed: true,
    attempts: (prior?.attempts ?? 0) + 1,
    lastError: detail,
    recordedAt: new Date(0).toISOString(),
  };
  byCandidateJob.set(keyOf(candidateId, jobId), saved);
  try {
    mkdirSync(dirname(LEDGER_FILE), { recursive: true });
    appendFileSync(LEDGER_FILE, `${JSON.stringify(saved)}\n`);
  } catch { /* the pass already reported it; losing the count is not worth throwing over */ }
  return saved;
}

/**
 * How many times we have failed on this candidate.
 *
 * `MAX_ATTEMPTS` is a cost guard, not a correctness one. Three engine calls is a fair price
 * for a transient fault; the fourth is paying repeatedly for a document that is never going
 * to parse. Past the cap the candidate is reported as needing a human, every pass, rather
 * than silently dropped — an invisible give-up is how someone never gets scored and nobody
 * finds out.
 */
export const MAX_ATTEMPTS = Number(process.env.SAM_MAX_ATTEMPTS ?? 3);
export function attemptsFor(candidateId, jobId) {
  ensureLoaded();
  return byCandidateJob.get(keyOf(candidateId, jobId))?.attempts ?? 0;
}
export const isExhausted = (candidateId, jobId) => attemptsFor(candidateId, jobId) >= MAX_ATTEMPTS;

/**
 * The description version a candidate was actually graded against.
 *
 * A posting edited afterwards means their score answers requirements that no longer exist,
 * and nothing on the Ashby record would say so. Comparing this against the current version
 * is what turns that from invisible into a decision somebody gets to make.
 */
export function gradedAgainstVersion(candidateId, jobId) {
  ensureLoaded();
  return byCandidateJob.get(keyOf(candidateId, jobId))?.descriptionVersion ?? null;
}

/** Which surfaces are still missing for a partially-delivered candidate. */
export function missingSurfaces(candidateId, jobId) {
  ensureLoaded();
  const entry = byCandidateJob.get(keyOf(candidateId, jobId));
  if (!entry || !entry.surfaces) return [];
  return SURFACES.filter((s) => !entry.surfaces[s]);
}

/**
 * Reserves a candidate before any awaiting begins.
 *
 * The check-then-deliver sequence has an await between the check and the write, so two
 * passes over the same list both pass `wasDelivered` and both deliver. Claiming closes that
 * window. Returns false if someone else holds it.
 *
 * ALWAYS release in a finally: a claim that outlives a failed delivery is worse than the
 * duplicate it prevents, because the candidate is then skipped forever.
 */
export function claim(candidateId, jobId) {
  ensureLoaded();
  const key = keyOf(candidateId, jobId);
  if (inFlight.has(key) || wasDelivered(candidateId, jobId)) return false;
  inFlight.add(key);
  return true;
}

export const release = (candidateId, jobId) => inFlight.delete(keyOf(candidateId, jobId));
export const isClaimed = (candidateId, jobId) => inFlight.has(keyOf(candidateId, jobId));

/** The delivery for one person on one job. */
export const lookup = (candidateId, jobId) => { ensureLoaded(); return byCandidateJob.get(keyOf(candidateId, jobId)) ?? null; };

/** Every delivery for one person, across all the jobs they applied to. */
export const lookupAll = (candidateId) => {
  ensureLoaded();
  return [...byCandidateJob.values()].filter((e) => e.candidateId === candidateId);
};

/** Every ledger row for one job — the cohort a rank is computed from. */
export const entriesForJob = (jobId) => {
  ensureLoaded();
  return [...byCandidateJob.values()].filter((e) => e.jobId === jobId);
};

export const forget = (candidateId, jobId) => byCandidateJob.delete(keyOf(candidateId, jobId));
export const size = () => { ensureLoaded(); return byCandidateJob.size; };

/**
 * Only for tests: an empty ledger.
 *
 * Marks the file as already replayed rather than un-replayed, so a following call does NOT
 * re-read it. Clearing and then allowing a replay would hand the next test whatever the
 * previous one persisted, which is the opposite of a reset.
 */
export const reset = () => { byCandidateJob.clear(); inFlight.clear(); loaded = true; };

/** Only for tests: replay from a specific file without touching the real one. */
export function loadFrom(file) {
  reset();
  loaded = true;
  if (!existsSync(file)) return 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.candidateId && entry?.jobId) byCandidateJob.set(keyOf(entry.candidateId, entry.jobId), entry);
    } catch { /* skip */ }
  }
  return byCandidateJob.size;
}

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
