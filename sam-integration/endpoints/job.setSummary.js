/**
 * What Sam has done for a job, written onto the job itself.
 *
 * Every other surface answers "how did this candidate do". Nothing answered "what is Sam
 * doing for this role" — the question a hiring manager has when they open a requisition,
 * and the one a client asks when deciding whether any of this is worth paying for.
 *
 * Four fields on the job page, no portal required. The client already sees them: `Sam
 * Grading` is the tick they use to switch a role on, and the other three fill in underneath
 * it as passes run.
 */
import { ENDPOINTS, SAM_JOB_FIELDS, CUSTOM_FIELD_OBJECT } from '../../shared/ashby-contract.js';
import { post, resolveCustomFieldIds } from './client.js';
import { jobSummary } from '../delivery/cohort.js';

/**
 * Writes the summary for one job.
 *
 * Never throws. This is reporting, not delivery: a job page that is a pass out of date is a
 * cosmetic problem, and failing a run of real candidate deliveries over it would not be.
 *
 * @param {object}   args
 * @param {string}   args.jobId
 * @param {object[]} args.entries   ledger rows for this job
 * @param {string}   args.at        ISO timestamp of this pass
 */
/**
 * A timestamp a person reads, not one a machine emits.
 *
 * This field sits on the job page next to "Candidates Graded: 3" and "Median Role Fit: 50",
 * in a form a recruiter looks at — and it rendered as `2026-10-01T18:12:18.098Z`. Correct,
 * and the only thing on that panel that looks like a log line leaked into the product. The
 * ISO value is still what we store internally; this is purely what the client sees.
 */
function humanTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  return `${date} at ${time} UTC`;
}

export async function setJobSummary({ jobId, entries, at, cohortFindings = [] }) {
  try {
    const summary = jobSummary(entries);
    const ids = await resolveCustomFieldIds([
      SAM_JOB_FIELDS.graded.name,
      SAM_JOB_FIELDS.medianFit.name,
      SAM_JOB_FIELDS.lastRun.name,
      SAM_JOB_FIELDS.cohortFinding.name,
    ]);

    const values = [
      { fieldId: ids.get(SAM_JOB_FIELDS.graded.name), fieldValue: summary.graded },
      // Sam's finding about the POOL, which no arithmetic of ours could produce: "no
      // applicant shows X — worth confirming whether it is genuinely required". It is about
      // the rubric, not any candidate, so it belongs here and nowhere else. Repeating it on
      // every candidate's record would read as a criticism of each of them.
      ...(cohortFindings.length
        ? [{ fieldId: ids.get(SAM_JOB_FIELDS.cohortFinding.name), fieldValue: cohortFindings[0].finding?.slice(0, 250) ?? null }]
        : []),
      // Null rather than 0 when nothing is comparable: a median of zero reads as "everyone
      // scored nothing", where an empty cell correctly reads as "not enough to say".
      { fieldId: ids.get(SAM_JOB_FIELDS.medianFit.name), fieldValue: summary.medianRoleFit },
      { fieldId: ids.get(SAM_JOB_FIELDS.lastRun.name), fieldValue: humanTime(at) },
    ];

    await post(ENDPOINTS.setCustomFields, {
      objectId: jobId,
      objectType: CUSTOM_FIELD_OBJECT.job,
      values,
    });
    return { ok: true, ...summary };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}
