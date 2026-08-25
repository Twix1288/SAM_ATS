/**
 * Which rubric to score an application against.
 *
 * The applicationSubmit webhook carries `data.application.job.id`, so the job is known
 * the moment an application arrives — Sam does not have to guess, and must not.
 *
 * Rubrics are registered against an Ashby job id. When an application arrives for a job
 * with no registered rubric, Sam DECLINES TO SCORE rather than falling back to whichever
 * rubric happens to be configured. Scoring someone against the wrong job's requirements
 * produces a confident number that is entirely meaningless, and it would be invisible in
 * the UI — the score would simply look wrong to nobody.
 *
 * In production the registry is populated per customer: one entry per Ashby job, its
 * rubric compiled from that job's description. Here it holds the one job in the seed data.
 */
import { createHmac } from 'node:crypto';
import { ANCHORS, ROLE } from './rubric.js';

/** Matches the id scheme the Ashby store uses, so the two sides agree without coupling. */
const stableId = (seed) => {
  const h = createHmac('sha256', 'ashby-demo').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/**
 * Registered rubrics, keyed by Ashby job id.
 *
 * `surveyForm` records which interview instrument the anchors were mapped against. An
 * application for the right job but the wrong survey would evidence nothing, so the two
 * are registered together rather than assumed to match.
 */
const REGISTRY = new Map([
  [stableId('job:sales-ae'), {
    jobId: stableId('job:sales-ae'),
    jobTitle: ROLE.title,
    company: ROLE.company,
    source: ROLE.source,
    surveyForm: 'survey_agree.com_business_development_representative',
    anchors: ANCHORS,
  }],
]);

export class UnknownJobError extends Error {
  constructor(jobId, jobTitle) {
    super(
      `No rubric is registered for job "${jobTitle ?? 'unknown'}" (${jobId}). `
      + 'Sam will not score an application against another job’s requirements.',
    );
    this.name = 'UnknownJobError';
    this.jobId = jobId;
    this.jobTitle = jobTitle;
  }
}

/**
 * Resolves the rubric for an incoming application.
 *
 * @param {{id: string, title?: string}} job  from data.application.job on the webhook
 * @throws {UnknownJobError} when the job has no registered rubric
 */
export function rubricForJob(job) {
  if (!job?.id) throw new UnknownJobError(undefined, job?.title);
  const rubric = REGISTRY.get(job.id);
  if (!rubric) throw new UnknownJobError(job.id, job.title);
  return rubric;
}

export const hasRubricFor = (jobId) => REGISTRY.has(jobId);
export const registeredJobs = () => [...REGISTRY.values()].map(
  ({ jobId, jobTitle, anchors }) => ({ jobId, jobTitle, anchorCount: anchors.length }),
);

/** Registers a rubric at runtime. Used by tests and by per-customer configuration. */
export function registerRubric(rubric) {
  if (!rubric?.jobId) throw new Error('A rubric must declare the Ashby jobId it scores for.');
  REGISTRY.set(rubric.jobId, rubric);
  return rubric;
}
