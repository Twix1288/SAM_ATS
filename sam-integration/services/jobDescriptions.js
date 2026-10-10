/**
 * How a candidate reaches the rubric for the job they actually applied to.
 *
 * The chain, every link verified against a live Ashby org on 2026-09-10:
 *
 *   application.job.id              present on 34/34 applications — never guessed
 *     → job.info(id).jobPostingIds  job.info carries NO description; it carries posting ids
 *       → jobPosting.info({jobPostingId}).descriptionPlain    ← the rubric's source text
 *
 * Two things about that chain are easy to get wrong and both fail quietly:
 *
 *   `appliedViaJobPostingId` looks like the obvious shortcut and is present on **0 of 34**
 *   applications in a real org. Reading it would resolve nothing, for everyone.
 *
 *   `jobPosting.info` takes `jobPostingId`, not `id`. The wrong name returns
 *   `{success:false, errors:["invalid_input"]}` — with HTTP **200**, so a client that
 *   branches on status codes sees a success.
 *
 * WHAT THIS FILE DOES NOT DO. It fetches and stores the description; it does not compile a
 * rubric from it. Turning a job description into anchors is judgement, and judgement lives
 * on Sam's side. This is the plumbing that hands Sam the right text for the right job, and
 * refuses to hand it the wrong one.
 */
import { createHash } from 'node:crypto';
import { ENDPOINTS, SAM_CUSTOM_FIELDS, SAM_JOB_FIELDS } from '../../shared/ashby-contract.js';
import { post as defaultPost } from '../endpoints/client.js';

/**
 * A job we cannot score, told apart from a job we simply have not pulled yet.
 *
 * "Head of Testing" in the sandbox is Open with zero postings — an unposted requisition is
 * a real, ordinary state, not a misconfiguration. There is no description anywhere for it,
 * so anyone applying to it cannot be graded against anything, and the honest outcome is to
 * decline rather than to grade them against a neighbouring job's requirements.
 */
export class NoJobDescriptionError extends Error {
  constructor(jobId, jobTitle, why) {
    super(`No job description available for "${jobTitle ?? 'unknown'}" (${jobId}): ${why}. `
      + 'Sam will not score an application against another job’s requirements.');
    this.name = 'NoJobDescriptionError';
    this.jobId = jobId;
    this.jobTitle = jobTitle;
    this.why = why;
  }
}

/** jobId -> stored description. */
const STORE = new Map();

/**
 * A content hash of the description text.
 *
 * The point is re-scoring. A job description edited after a candidate was scored means that
 * candidate was graded against requirements that no longer exist, and nothing on the record
 * would say so. Comparing this against the stored value is how that becomes detectable
 * rather than invisible — it pairs with `rubricVersion` in the engine payload.
 */
export const descriptionVersion = (text) =>
  createHash('sha256').update(String(text)).digest('hex').slice(0, 12);

/**
 * Which posting carries the description, when a job has more than one.
 *
 * Every job in the sandbox has exactly one, so the multi-posting branch costs an extra call
 * that is never made in the common case. It exists because picking the wrong posting is a
 * silent wrong answer: a different board's copy of the role, scored as though it were the
 * requirements the candidate applied under.
 *
 * Preference is listed-before-unlisted, then earliest published, then id — deterministic, so
 * two sweeps of the same job never disagree with each other.
 */
async function choosePosting(job, post) {
  const ids = job?.jobPostingIds ?? [];
  if (ids.length === 1) return { postingId: ids[0], amongst: 1 };

  const all = (await post(ENDPOINTS.listJobPostings, { limit: 100 })) ?? [];
  const mine = all.filter((p) => p.jobId === job.id);
  if (!mine.length) return { postingId: ids[0], amongst: ids.length };

  const ranked = [...mine].sort((a, b) => (
    (b.isListed === true) - (a.isListed === true)
    || String(a.publishedDate ?? '').localeCompare(String(b.publishedDate ?? ''))
    || String(a.id).localeCompare(String(b.id))
  ));
  return { postingId: ranked[0].id, amongst: mine.length };
}

/**
 * Pulls one job's description from Ashby.
 *
 * `post` is injected so the chain is testable without a network — the two guarantees worth
 * testing (refusing an unposted job, and picking deterministically among several postings)
 * both need fake responses rather than a live org.
 *
 * @returns {Promise<{jobId, jobTitle, postingId, text, version, fetchedAt, amongstPostings}>}
 */
export async function fetchJobDescription(jobId, { post = defaultPost, now = () => new Date().toISOString() } = {}) {
  if (!jobId) throw new NoJobDescriptionError(jobId, undefined, 'no job id was given');

  const job = await post(ENDPOINTS.jobInfo, { id: jobId });
  if (!job) throw new NoJobDescriptionError(jobId, undefined, 'job.info returned nothing');

  const { postingId, amongst } = await choosePosting(job, post);
  if (!postingId) throw new NoJobDescriptionError(jobId, job.title, 'the job has no posting');

  // `jobPostingId`, NOT `id`. See the header note.
  const posting = await post(ENDPOINTS.jobPostingInfo, { jobPostingId: postingId });
  const { text, source, dropped } = descriptionTextOf(posting);
  if (!text) {
    throw new NoJobDescriptionError(jobId, job.title, `posting ${postingId} carries no description text`);
  }

  return {
    jobId,
    jobTitle: job.title,
    postingId,
    text,
    textSource: source,
    droppedBoilerplate: dropped,
    version: descriptionVersion(text),
    fetchedAt: now(),
    amongstPostings: amongst,
    // Structured signals the prose does not state cleanly. Sam calibrates against these —
    // a $120–240K band and an on-site requirement are rubric-relevant and are nowhere in
    // the body text in a form worth parsing.
    context: {
      employmentType: posting?.employmentType ?? null,
      workplaceType: posting?.workplaceType ?? null,
      isRemote: posting?.isRemote ?? null,
      location: posting?.locationName ?? null,
      team: posting?.teamName ?? null,
      department: posting?.departmentName ?? null,
      compensation: posting?.compensation?.compensationTierSummary ?? null,
    },
  };
}

/**
 * The part of a posting that is actually about the job.
 *
 * `descriptionPlain` is opening + body + closing concatenated, and the closing is the equal
 * employment opportunity statement — **888 characters, byte-identical on all nine postings
 * in the sandbox**, between a fifth and a quarter of the whole text. Handing that to a
 * rubric compiler invites anchors like "committed to equal employment opportunity", which
 * is not a hiring requirement and which no candidate can evidence.
 *
 * `descriptionParts.descriptionBody` is the same text without it, and it is present on 9 of
 * 9 postings. Prefer it; fall back to the concatenated form only when the parts are absent,
 * and say which was used so a bad rubric can be traced back to its input.
 */
export function descriptionTextOf(posting) {
  const parts = posting?.descriptionParts;
  const body = parts?.descriptionBody?.plain ?? parts?.descriptionBody?.html ?? null;
  const whole = posting?.descriptionPlain ?? null;

  if (body && String(body).trim()) {
    return {
      text: String(body).trim(),
      source: 'descriptionParts.descriptionBody',
      dropped: Math.max(0, (whole?.length ?? 0) - String(body).length),
    };
  }
  if (whole && String(whole).trim()) {
    return { text: String(whole).trim(), source: 'descriptionPlain', dropped: 0 };
  }
  return { text: null, source: null, dropped: 0 };
}

/**
 * Pulls a description and stores it. This is the "once, when the job is added" step.
 *
 * Returns the stored record. Re-pulling an unchanged description keeps the original
 * `fetchedAt` so a no-op refresh does not look like a change.
 */
export async function pullJobDescription(jobId, opts) {
  const pulled = await fetchJobDescription(jobId, opts);
  const existing = STORE.get(jobId);
  const record = existing && existing.version === pulled.version
    ? { ...pulled, fetchedAt: existing.fetchedAt, unchanged: true }
    : { ...pulled, unchanged: false };
  STORE.set(jobId, record);
  return record;
}

/**
 * Pulls every job asked for, and reports per job rather than throwing.
 *
 * One unpostable job must not stop the others being pulled — the same reason the sweep does
 * not stop on the first candidate that fails.
 */
export async function pullJobDescriptions(jobIds, opts) {
  const results = [];
  for (const jobId of jobIds) {
    try {
      results.push({ jobId, ok: true, record: await pullJobDescription(jobId, opts) });
    } catch (err) {
      results.push({ jobId, ok: false, error: err.message, why: err.why ?? null });
    }
  }
  return results;
}

export const descriptionFor = (jobId) => STORE.get(jobId) ?? null;
export const hasDescriptionFor = (jobId) => STORE.has(jobId);
export const storedJobs = () => [...STORE.values()].map(
  ({ jobId, jobTitle, version, fetchedAt, text }) => ({ jobId, jobTitle, version, fetchedAt, chars: text.length }),
);
export const resetJobDescriptions = () => STORE.clear();

/** Registers a description directly. For tests and for a store loaded from disk. */
export function rememberJobDescription(record) {
  if (!record?.jobId) throw new Error('A job description must declare the Ashby jobId it belongs to.');
  STORE.set(record.jobId, { ...record, version: record.version ?? descriptionVersion(record.text) });
  return record;
}

/**
 * The job an application was submitted against, from the application itself.
 *
 * Verified: `application.job.id` is present on every application in a real org, and
 * `application.candidateId` does NOT exist — the candidate arrives as a nested object. Both
 * shapes are accepted so a webhook payload and a list row resolve the same way.
 */
export function jobOfApplication(application) {
  const job = application?.job;
  const id = job?.id ?? application?.jobId ?? null;
  return id ? { id, title: job?.title ?? null } : null;
}

/**
 * Which job positions Sam is switched on for.
 *
 * THE GATE IS THE JOB ID, NOT THE POSTING ID, and that is not arbitrary:
 * `application.job.id` is present on every application, while `appliedViaJobPostingId` was
 * null on **0 of 34** in a real org. Keying enrolment on the posting would match nothing.
 * The posting is only where the description TEXT lives; the requisition is the thing a
 * candidate applies to.
 *
 * Default-deny. An application for a job nobody enrolled is declined, not graded against
 * whichever rubric happens to be loaded — a score against the wrong job's requirements is
 * a confident number that means nothing, and it looks exactly like a real one.
 */
const ENROLLED = new Set();

export class JobNotEnrolledError extends Error {
  constructor(jobId, jobTitle) {
    super(`Sam is not switched on for "${jobTitle ?? 'unknown'}" (${jobId}). `
      + 'Enrol the job before applications to it are graded.');
    this.name = 'JobNotEnrolledError';
    this.jobId = jobId;
    this.jobTitle = jobTitle;
  }
}

export const enrolJob = (jobId) => { ENROLLED.add(jobId); return jobId; };
export const withdrawJob = (jobId) => ENROLLED.delete(jobId);
export const isEnrolled = (jobId) => ENROLLED.has(jobId);
export const enrolledJobs = () => [...ENROLLED];
export const resetEnrolment = () => ENROLLED.clear();

/**
 * The one call the delivery path makes before spending anything on a candidate.
 *
 * Runs in the order the failures cost money: enrolment is a set lookup, the description is
 * already stored, and scoring is the expensive half. Both refusals are distinguishable —
 * "nobody asked us to grade this job" and "we cannot, because there is no description" are
 * different conversations with the customer.
 *
 * @throws {JobNotEnrolledError|NoJobDescriptionError}
 */
export function requireGradableJob(application) {
  const job = jobOfApplication(application);
  if (!job) throw new JobNotEnrolledError(undefined, undefined);
  if (!ENROLLED.has(job.id)) throw new JobNotEnrolledError(job.id, job.title);

  const description = STORE.get(job.id);
  if (!description) {
    throw new NoJobDescriptionError(job.id, job.title,
      'the job is enrolled but its description has not been pulled yet');
  }
  return { job, description };
}

/**
 * Exactly what Sam's engine needs to compile a rubric for one job, and nothing else.
 *
 * Deliberately not the whole posting: the engine gets the text and the structured facts
 * that shape a rubric, plus the version so a rubric can be traced to the description it
 * came from and re-compiled when that description is edited.
 */
export function jobBriefForEngine(jobId) {
  const d = STORE.get(jobId);
  if (!d) return null;
  return {
    ashbyJobId: d.jobId,
    title: d.jobTitle,
    description: d.text,
    descriptionVersion: d.version,
    descriptionSource: d.textSource,
    fetchedAt: d.fetchedAt,
    context: d.context ?? null,
  };
}

/**
 * Enrolment the client controls from inside Ashby, with no portal and no job ids to copy.
 *
 * A Job-scoped Yes/No custom field called "Sam Grading" appears on the job's own page in
 * Ashby. A recruiter ticks it on the roles they want graded, in the product they already
 * have open, and that tick IS the enrolled set. Nothing to paste anywhere, nothing to keep
 * in sync, and turning Sam off for a role is the same tick again.
 *
 * WE CREATE THE FIELD, NOT THEM. `customField.create` works on a normal key — verified — so
 * first connect provisions all five fields (four on the application, this one on the job)
 * and the client's entire setup is handing over an API key.
 *
 * TWO THINGS ABOUT READING IT BACK, both verified the hard way:
 *
 *   `job.list` does NOT expand job custom fields — its `customFields` is always `[]`, and
 *   `expand` is refused. Only `job.info` and `job.search` carry the values, so this costs
 *   one call per job. At ten jobs that is ten calls against a limit of a thousand.
 *
 *   The value is EVENTUALLY CONSISTENT. Reading `job.info` immediately after writing the
 *   field returned `[]`; the same read a minute later returned `true`. So never confirm a
 *   tick by reading it straight back — you will conclude the client did nothing.
 */
export const ENROLMENT_FIELD = SAM_JOB_FIELDS.grading.name;

/**
 * Reads the enrolled set from Ashby and replaces whatever we held.
 *
 * Replaces rather than merges, deliberately: unticking a job in Ashby has to be able to turn
 * Sam OFF, and a merge would make enrolment a one-way door.
 *
 * @returns {Promise<{enrolled: string[], checked: number, field: string|null}>}
 */
export async function syncEnrolmentFromAshby({ post = defaultPost } = {}) {
  const fields = (await post(ENDPOINTS.listCustomFields, {})) ?? [];
  const flag = fields.find((f) => f.title === ENROLMENT_FIELD && !f.isArchived);
  if (!flag) return { enrolled: [], checked: 0, field: null };

  const jobs = (await post(ENDPOINTS.listJobs, { limit: 100 })) ?? [];
  const enrolled = [];

  for (const job of jobs) {
    // Closed jobs cannot receive new applications, so reading them is wasted budget.
    if (job.status && job.status !== 'Open') continue;
    const full = await post(ENDPOINTS.jobInfo, { id: job.id });
    const on = (full?.customFields ?? []).find((f) => f.id === flag.id)?.value === true;
    if (on) enrolled.push(job.id);
  }

  resetEnrolment();
  enrolled.forEach(enrolJob);
  return { enrolled, checked: jobs.length, field: flag.id };
}

/**
 * Everything a client's org needs before a single candidate can be graded.
 *
 * Idempotent: an existing field is left exactly as it is, including its type. Creating a
 * field is the one operation that needs a broader permission than the rest of the
 * integration, so it is done once at connect time rather than on every delivery.
 */
export async function provisionCustomFields({ post = defaultPost } = {}) {
  const existing = (await post(ENDPOINTS.listCustomFields, {})) ?? [];
  const byTitle = new Map(existing.map((f) => [f.title, f]));
  const wanted = [
    ...Object.values(SAM_CUSTOM_FIELDS).map((f) => ({ title: f.name, objectType: 'Application', fieldType: f.type })),
    ...Object.values(SAM_JOB_FIELDS).map((f) => ({ title: f.name, objectType: 'Job', fieldType: f.type })),
  ];

  const results = [];
  for (const want of wanted) {
    const found = byTitle.get(want.title);
    if (found) {
      results.push({ ...want, status: found.fieldType === want.fieldType ? 'exists' : 'WRONG TYPE', id: found.id, actualType: found.fieldType });
      continue;
    }
    try {
      const made = await post(ENDPOINTS.createCustomField, want);
      results.push({ ...want, status: 'created', id: made?.id });
    } catch (err) {
      results.push({ ...want, status: 'failed', detail: err.message });
    }
  }
  return results;
}
