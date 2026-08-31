/**
 * The scheduled sweep.
 *
 * How this runs in production, per Ash:
 *
 *   a company connects Ashby and picks which jobs Sam should grade
 *   → we pull each job description once when it is added, and store it
 *   → Sam checks those jobs every few hours
 *   → anyone new since the last check gets pulled, resume only, since we already have the job
 *   → that goes to the engine and comes back scored
 *   → the Snapshot goes onto that person's record in Ashby
 *
 * Two things this has to guarantee, and they are the reason it exists rather than a
 * `setInterval` around the existing delivery:
 *
 *   **Nobody is scored twice.** The ledger is keyed on `(candidateId, jobId)`, so a person
 *   who appears in two consecutive sweeps is skipped the second time, and a person who
 *   applied to two jobs is scored once for each. This is checked before the engine is
 *   called, not after — scoring is the expensive half.
 *
 *   **Nobody is missed.** The cursor advances to the newest application actually *seen*,
 *   not to "now". If a sweep starts at 10:00 and an application is created at 10:00:30 while
 *   the sweep is still running, advancing to wall-clock time would step over it forever.
 *   Overlapping slightly and relying on the ledger to dedupe is cheap; a missed candidate is
 *   invisible.
 *
 * The engine is injected, and so is the Ashby read. This file knows how to walk a job and
 * what has already been delivered; it has no opinion about scoring, which lives on Sam's
 * side, and no opinion about transport, which makes the two guarantees above testable
 * without a network in reach.
 */
import { post } from '../endpoints/client.js';
import { ENDPOINTS } from '../../shared/ashby-contract.js';
import { wasDelivered } from './ledger.js';
import { raiseAlert, ALERT, SEVERITY } from './alerts.js';

/** Per-job high-water mark: jobId -> ISO timestamp of the newest application seen. */
const cursors = new Map();

export const cursorFor = (jobId) => cursors.get(jobId) ?? null;
export const setCursor = (jobId, iso) => cursors.set(jobId, iso);
export const resetCursors = () => cursors.clear();

export const SWEEP_OUTCOME = {
  delivered: 'delivered',
  alreadyScored: 'already_scored',
  failed: 'failed',
};

/**
 * One pass over one job.
 *
 * @param {object}   args
 * @param {string}   args.jobId
 * @param {Function} args.scoreAndDeliver  async ({application, jobId}) => delivery result
 * @param {number}   [args.limit]          page size for application.list
 * @param {Function} [args.listApplications] async (body) => Ashby's application.list envelope
 * @param {Function} [args.onCandidate]    progress callback
 * @returns {Promise<{jobId, seen, skipped, delivered, failed, cursorFrom, cursorTo, results}>}
 */
const defaultLister = (body) => post(ENDPOINTS.listApplications, body);

export async function sweepJob({
  jobId, scoreAndDeliver, limit = 100, listApplications = defaultLister, onCandidate = () => {},
}) {
  const cursorFrom = cursorFor(jobId);

  // Ask Ashby only for what changed. createdAfter is the cheap filter; without a cursor
  // this is the first sweep for the job and everything is new.
  const body = { jobId, limit, ...(cursorFrom ? { createdAfter: cursorFrom } : {}) };
  const page = await listApplications(body);
  const applications = page?.results ?? [];

  const results = [];

  for (const application of applications) {
    const candidateId = application.candidateId ?? application.candidate?.id;

    if (!candidateId) {
      results.push({
        applicationId: application.id,
        createdAt: application.createdAt,
        outcome: SWEEP_OUTCOME.failed,
        detail: 'no candidate id on the application',
      });
      continue;
    }

    // The dedupe, before the engine is called rather than after.
    if (wasDelivered(candidateId, jobId)) {
      const skipped = {
        candidateId, applicationId: application.id, createdAt: application.createdAt,
        outcome: SWEEP_OUTCOME.alreadyScored,
      };
      results.push(skipped);
      onCandidate(skipped);
      continue;
    }

    try {
      const delivery = await scoreAndDeliver({ application, jobId });
      const done = {
        candidateId, applicationId: application.id, createdAt: application.createdAt,
        outcome: SWEEP_OUTCOME.delivered, delivery,
      };
      results.push(done);
      onCandidate(done);
    } catch (err) {
      // One candidate failing must not end the sweep — the next person in the list is
      // unrelated, and a sweep that stops on the first error silently stops scoring
      // everyone behind them.
      const failed = {
        candidateId, applicationId: application.id, createdAt: application.createdAt,
        outcome: SWEEP_OUTCOME.failed, detail: err.message,
      };
      results.push(failed);
      onCandidate(failed);
    }
  }

  const failed = results.filter((r) => r.outcome === SWEEP_OUTCOME.failed);
  if (failed.length) {
    raiseAlert({
      code: ALERT.deliveryIncomplete,
      severity: SEVERITY.warning,
      message: `${failed.length} of ${applications.length} candidates failed to score in the `
        + `sweep for job ${jobId}. They keep no ledger entry, so the next sweep retries them.`,
      context: { jobId, failed: failed.map((f) => ({ candidateId: f.candidateId, detail: f.detail })) },
    });
  }

  // Advance only after the pass, only to something we actually saw, and NEVER past a
  // candidate we failed to score. Moving the cursor past a failure would step over that
  // person permanently: they keep no ledger entry, so the next sweep would be their retry —
  // except the cursor has already excluded them from the query. They would simply never be
  // scored, and nothing anywhere would say so.
  const oldestFailure = failed
    .map((f) => f.createdAt)
    .filter(Boolean)
    .sort()[0] ?? null;

  const next = results
    .filter((r) => r.outcome !== SWEEP_OUTCOME.failed && r.createdAt)
    .map((r) => r.createdAt)
    .filter((at) => !oldestFailure || at < oldestFailure)
    .reduce((max, at) => (!max || at > max ? at : max), cursorFrom);

  if (next && next !== cursorFrom) setCursor(jobId, next);

  return {
    jobId,
    seen: applications.length,
    skipped: results.filter((r) => r.outcome === SWEEP_OUTCOME.alreadyScored).length,
    delivered: results.filter((r) => r.outcome === SWEEP_OUTCOME.delivered).length,
    failed: failed.length,
    cursorFrom,
    cursorTo: cursorFor(jobId),
    results,
  };
}

/**
 * One pass over every job the company asked Sam to grade.
 * Jobs are swept in sequence: a burst of parallel writes is the fastest way to meet a rate
 * limit we have not been told the shape of.
 */
export async function sweepAll({
  jobIds, scoreAndDeliver, listApplications, onCandidate, onJob = () => {},
}) {
  const passes = [];
  for (const jobId of jobIds) {
    const pass = await sweepJob({ jobId, scoreAndDeliver, listApplications, onCandidate });
    passes.push(pass);
    onJob(pass);
  }
  return {
    jobs: passes.length,
    delivered: passes.reduce((n, p) => n + p.delivered, 0),
    skipped: passes.reduce((n, p) => n + p.skipped, 0),
    failed: passes.reduce((n, p) => n + p.failed, 0),
    passes,
  };
}
