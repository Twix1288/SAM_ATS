/**
 * One pass over every application, gating each row before anything is spent.
 *
 * HOW THIS RUNS IN PRODUCTION
 *
 *   an employer names the jobs Sam should grade, by Ashby job id
 *   → each is enrolled and its description pulled once
 *   → this pass runs on a timer
 *   → every application is listed, and each row is gated locally
 *   → whoever clears the gate goes to the engine and comes back scored
 *   → the Snapshot lands on that person's record
 *
 * THERE IS NO CURSOR, AND THAT IS DELIBERATE.
 *
 * An earlier version kept a `createdAt` high-water mark so it could ask Ashby only for what
 * changed. It cost three of the subtlest bugs in the system and bought nothing:
 *
 *   - `createdAfter` wants epoch MILLISECONDS; an ISO string is refused with `invalid_input`
 *     at HTTP 200, so every pass after the first silently returned nothing.
 *   - `createdAfter` is exclusive, and ties on `createdAt` are real — 31 of 34 applications
 *     in a live org share a timestamp with another. A high-water mark steps over all of them.
 *   - The cursor must never advance past a failure, or that candidate is excluded from the
 *     next query and is never scored, with nothing anywhere saying so.
 *
 * What it saves is API calls, and API calls are not the scarce resource: the rate limit is
 * 1000 and a delivery spends about nine. Listing everything and letting the LEDGER decide
 * who is new is both simpler and strictly more correct. The repo's own contract doc had this
 * right all along — "the cursor is an optimisation; the ledger is the guarantee."
 *
 * Above roughly ten thousand applications the call volume starts to matter and a cursor
 * earns its place again. It is not close, and re-introducing one means re-introducing the
 * three bugs above deliberately rather than by accident.
 *
 * THE GATE IS PER ROW, NEVER A QUERY PARAMETER. Ashby silently ignores request parameters it
 * does not recognise and still answers `success: true` — an impossible `customFieldFilters`
 * returns every row, and so does a parameter that does not exist. So a server-side `jobId`
 * filter is an unfalsifiable claim about who you are grading. We ask for everything and
 * refuse locally, which makes trusting the filter a mistake that cannot be made.
 */
import { postAll } from '../endpoints/client.js';
import { ENDPOINTS } from '../../shared/ashby-contract.js';
import { wasDelivered, claim, release, missingSurfaces, recordFailure, isExhausted, attemptsFor, MAX_ATTEMPTS, gradedAgainstVersion } from './ledger.js';
import { requireGradableJob, descriptionFor } from '../services/jobDescriptions.js';
import { raiseAlert, ALERT, SEVERITY } from './alerts.js';

export const OUTCOME = {
  delivered: 'delivered',
  resumed: 'resumed',
  alreadyDelivered: 'already_delivered',
  notEnrolled: 'not_enrolled',
  noDescription: 'no_description',
  notActive: 'not_active',
  noCandidate: 'no_candidate',
  exhausted: 'needs_a_human',
  failed: 'failed',
};

/** Only an Active application is worth grading. */
const ACTIVE = 'Active';

/** Every application in the org, every page of it. */
const defaultLister = () => postAll(ENDPOINTS.listApplications, { limit: 100 });

/**
 * Decides what to do with one application, spending nothing.
 *
 * Ordered by what each refusal costs to discover: a missing field, then a set lookup, then a
 * stored record, then the ledger. Everything expensive happens after this returns `null`.
 *
 * @returns {object|null} a terminal result, or null meaning "grade this one"
 */
export function gate(application) {
  // `application.candidate` is a nested object — there is no `candidateId` field on the row.
  const candidateId = application.candidateId ?? application.candidate?.id ?? null;
  const base = {
    applicationId: application.id,
    candidateId,
    candidateName: application.candidate?.name ?? null,
    jobId: application.job?.id ?? null,
    jobTitle: application.job?.title ?? null,
  };

  if (!candidateId) return { ...base, outcome: OUTCOME.noCandidate, detail: 'the row names no candidate' };

  // Archived, rejected and withdrawn applications are the majority of most pipelines — 26 of
  // 34 in a live org. Grading them spends the engine on people already turned down, and puts
  // a fresh Snapshot on someone a recruiter rejected last week.
  if (application.status && application.status !== ACTIVE) {
    return { ...base, outcome: OUTCOME.notActive, detail: `application is ${application.status}` };
  }

  try {
    requireGradableJob(application);
  } catch (err) {
    const outcome = err.name === 'JobNotEnrolledError' ? OUTCOME.notEnrolled : OUTCOME.noDescription;
    return { ...base, outcome, detail: err.message };
  }

  if (wasDelivered(candidateId, base.jobId)) {
    // Delivered — but against WHICH version of the job description? A posting edited since
    // means this score answers requirements that no longer exist, and nothing on the Ashby
    // record says so. Surfaced, never acted on: whether a rubric change re-issues a Snapshot
    // is a product decision, and silently re-grading everyone on an edit would be expensive
    // and surprising.
    const gradedAgainst = gradedAgainstVersion(candidateId, base.jobId);
    const current = descriptionFor(base.jobId)?.version ?? null;
    const drifted = Boolean(gradedAgainst && current && gradedAgainst !== current);
    return { ...base, outcome: OUTCOME.alreadyDelivered, drifted, gradedAgainst, current };
  }

  // Past the cap this candidate stops costing engine calls and starts asking for a person.
  // Reported every pass rather than dropped — an invisible give-up is how somebody never
  // gets scored and nobody ever finds out.
  if (isExhausted(candidateId, base.jobId)) {
    return {
      ...base,
      outcome: OUTCOME.exhausted,
      detail: `failed ${attemptsFor(candidateId, base.jobId)} times — needs a look`,
    };
  }

  return null;
}

/**
 * One full pass.
 *
 * @param {object}   args
 * @param {Function} args.scoreAndDeliver  async ({application, jobId, description}) => result
 * @param {Function} [args.listApplications] async () => every application
 * @param {Function} [args.onCandidate]    progress callback, per row
 */
export async function sweep({ scoreAndDeliver, listApplications = defaultLister, onCandidate = () => {} }) {
  const applications = await listApplications();
  const results = [];

  for (const application of applications) {
    const refusal = gate(application);
    if (refusal) {
      results.push(refusal);
      onCandidate(refusal);
      continue;
    }

    const candidateId = application.candidateId ?? application.candidate?.id;
    const jobId = application.job?.id;

    // Claimed BEFORE the first await. Without this, two passes over the same list both clear
    // the gate and both deliver, because the check and the write are separated by the
    // engine call. Released in `finally` — a claim that outlives a failed delivery is worse
    // than the duplicate it prevents, because the candidate is then skipped forever.
    if (!claim(candidateId, jobId)) {
      const busy = { applicationId: application.id, candidateId, jobId, outcome: OUTCOME.alreadyDelivered, detail: 'in flight' };
      results.push(busy);
      onCandidate(busy);
      continue;
    }

    const resuming = missingSurfaces(candidateId, jobId);
    try {
      const { description } = requireGradableJob(application);
      const delivery = await scoreAndDeliver({ application, jobId, description });
      const done = {
        applicationId: application.id,
        candidateId,
        candidateName: application.candidate?.name ?? null,
        jobId,
        jobTitle: application.job?.title ?? null,
        outcome: resuming.length ? OUTCOME.resumed : OUTCOME.delivered,
        resumed: resuming.length ? resuming : undefined,
        delivery,
      };
      results.push(done);
      onCandidate(done);
    } catch (err) {
      // One candidate failing must not end the pass — the next person is unrelated, and a
      // pass that stops on the first error silently stops grading everyone behind them.
      // No ledger entry is written, so the next pass is their retry.
      // Durable, so the count survives the restart that a scheduled runner does constantly.
      const { attempts } = recordFailure({ candidateId, jobId, detail: err.message });
      const failed = {
        applicationId: application.id,
        candidateId,
        candidateName: application.candidate?.name ?? null,
        jobId,
        outcome: OUTCOME.failed,
        attempts,
        detail: `${err.message} (attempt ${attempts} of ${MAX_ATTEMPTS})`,
      };
      results.push(failed);
      onCandidate(failed);
    } finally {
      release(candidateId, jobId);
    }
  }

  const tally = (o) => results.filter((r) => r.outcome === o).length;
  const failed = results.filter((r) => r.outcome === OUTCOME.failed);

  if (failed.length) {
    raiseAlert({
      code: ALERT.deliveryIncomplete,
      severity: SEVERITY.warning,
      message: `${failed.length} of ${applications.length} candidates failed to grade in this `
        + 'pass. They keep no ledger entry, so the next pass retries them.',
      context: { failed: failed.map((f) => ({ candidateId: f.candidateId, detail: f.detail })) },
    });
  }

  const exhausted = results.filter((r) => r.outcome === OUTCOME.exhausted);
  if (exhausted.length) {
    raiseAlert({
      code: ALERT.deliveryIncomplete,
      severity: SEVERITY.warning,
      message: `${exhausted.length} candidates have failed ${MAX_ATTEMPTS} times and are no `
        + 'longer being retried. They will never be scored until somebody looks.',
      context: { candidates: exhausted.map((e) => ({ candidateId: e.candidateId, detail: e.detail })) },
    });
  }

  const drifted = results.filter((r) => r.drifted);
  if (drifted.length) {
    raiseAlert({
      code: ALERT.staleScoreVisible,
      severity: SEVERITY.warning,
      message: `${drifted.length} candidates were graded against a job description that has `
        + 'since been edited. Their published scores answer requirements that no longer exist.',
      context: { candidates: drifted.map((d) => ({ candidateId: d.candidateId, jobId: d.jobId, gradedAgainst: d.gradedAgainst, current: d.current })) },
    });
  }

  return {
    seen: applications.length,
    delivered: tally(OUTCOME.delivered),
    resumed: tally(OUTCOME.resumed),
    alreadyDelivered: tally(OUTCOME.alreadyDelivered),
    exhausted: tally(OUTCOME.exhausted),
    drifted: results.filter((r) => r.drifted).length,
    notEnrolled: tally(OUTCOME.notEnrolled),
    noDescription: tally(OUTCOME.noDescription),
    notActive: tally(OUTCOME.notActive),
    noCandidate: tally(OUTCOME.noCandidate),
    failed: failed.length,
    results,
  };
}
