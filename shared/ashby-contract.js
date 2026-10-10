/**
 * Verified Ashby API contract.
 *
 * Every value here was confirmed against developers.ashbyhq.com rather than assumed.
 * Six items in the original integration plan were wrong; each is marked CORRECTED.
 *
 *   https://developers.ashbyhq.com/reference/introduction
 *   https://developers.ashbyhq.com/docs/authenticating-webhooks
 *   https://developers.ashbyhq.com/docs/common-payload-data
 */

/** Real base URL. CORRECTED: the plan used an `/api/` path prefix, which does not exist. */
export const ASHBY_BASE_URL = 'https://api.ashbyhq.com';

/** RPC-style endpoints: POST /CATEGORY.method */
export const ENDPOINTS = {
  /**
   * CORRECTED — the Snapshot goes here, NOT in the resume slot.
   * `candidate.uploadResume` writes the resume slot specifically, so sending a Snapshot
   * through it risks displacing the candidate's real resume. `candidate.uploadFile`
   * attaches a file alongside it instead.
   * POST multipart { candidateId, file } or JSON { candidateId, fileHandle }
   */
  uploadFile: '/candidate.uploadFile',

  /** The candidate's actual resume slot. Sam never writes here. */
  uploadResume: '/candidate.uploadResume',

  /**
   * Two-step upload. `fileUploadContext` is an enum — use `CandidateFiles` for a
   * Snapshot, never `CandidateResume`. Handles expire after 10 minutes.
   */
  createFileUploadHandle: '/file.createFileUploadHandle',

  /**
   * CORRECTED — `note` is not plain-text-only. It accepts a bare string OR
   * { type: 'text/html' | 'text/plain', value }. Ashby sanitises submitted HTML down
   * to the subset its own rich-text editor supports.
   * CORRECTED — the plan called this `candidateNote.create`, which does not exist.
   */
  createNote: '/candidate.createNote',

  /**
   * CORRECTED — prefer the batch form. Firing several single setValue calls
   * concurrently at the same object has a documented race condition, and Sam writes
   * four fields at once.
   * POST { objectId, objectType, values: [{ fieldId, fieldValue }] }
   */
  setCustomFields: '/customField.setValues',
  setCustomField: '/customField.setValue',
  listCustomFields: '/customField.list',
  /** Needs hiringProcessMetadataWrite — a higher permission than candidatesWrite. */
  createCustomField: '/customField.create',

  /**
   * Reads. The Ashby UI in this repo is driven entirely by these, so what appears on
   * screen is only ever what a write endpoint actually landed — never anything Sam
   * still holds in memory. All names verified against the llms.txt index.
   */
  listCandidates: '/candidate.list',
  candidateInfo: '/candidate.info',
  searchCandidates: '/candidate.search',
  listApplications: '/application.list',
  applicationInfo: '/application.info',
  listNotes: '/candidate.listNotes',
  fileInfo: '/file.info',
  jobInfo: '/job.info',
  listJobs: '/job.list',
  listInterviewStages: '/interviewStage.list',

  /**
   * Where the job description actually lives. VERIFIED live 2026-09-10.
   *
   * `job.info` does NOT carry the description — its keys are id, title, confidential,
   * status, employmentType, locationId, departmentId, defaultInterviewPlanId,
   * interviewPlanIds, jobPostingIds, customFields, hiringTeam, customRequisitionId,
   * brandId, author and the timestamps. The text is on the POSTING, reached through
   * `job.jobPostingIds`.
   *
   * NOTE the parameter name: `jobPostingId`, not `id`. Sending `id` returns
   * `{success:false, errors:["invalid_input"]}` — and Ashby answers that with HTTP 200,
   * so it does not look like an error to anything watching status codes.
   */
  listJobPostings: '/jobPosting.list',
  jobPostingInfo: '/jobPosting.info',

  /**
   * The discovery surface. Custom fields are visible but NOT filterable — verified against
   * a live org, every list endpoint ignores a custom-field filter and still returns success
   * — so a tag is the only marker that makes "who has Sam graded" answerable at all.
   * Applying a tag is idempotent; creating one needs a higher permission than applying it.
   */
  addCandidateTag: '/candidate.addTag',

  /**
   * Projects — the ONE surface where Ashby documents custom-field columns, so the one place
   * Sam's numbers can be sorted on. Adding a candidate works on an ordinary key; CREATING a
   * project returns 403 missing_endpoint_permission, so the client makes it themselves.
   */
  listProjects: '/project.list',
  addCandidateProject: '/candidate.addProject',
  removeCandidateProject: '/candidate.removeProject',
  listCandidateTags: '/candidateTag.list',
  removeCandidateTag: '/candidate.removeTag',
  createCandidateTag: '/candidateTag.create',

  /**
   * Investigated and not used. Kept named so the decision is visible in the contract
   * rather than lost: the assessment framework is partner-gated, and a scorecard filed
   * beside human ones reads as a peer opinion. Both are questions for Ashby, not code.
   */
  // addCompletedAssessment: '/assessment.addCompletedToCandidate',
  // submitFeedback:         '/applicationFeedback.submit',
};

/**
 * Request parameter names for file.createFileUploadHandle.
 *
 * Ashby's reference page does not publish this schema, so these come from the
 * integration architecture spec rather than from the endpoint docs. They are isolated
 * here because they are the one part of the file flow we could not verify directly —
 * if Ashby names them differently, this object is the only edit, and it is on the
 * questions list.
 */
export const UPLOAD_HANDLE_PARAMS = {
  context: 'fileUploadContext',
  name: 'filename',
  type: 'contentType',
  length: 'contentLength',
};

/** `fileUploadContext` enum for file.createFileUploadHandle. */
export const FILE_CONTEXT = {
  candidateFiles: 'CandidateFiles',
  candidateResume: 'CandidateResume',
  applicationForm: 'ApplicationForm',
};

/** `objectType` enum accepted by customField.setValues. */
export const CUSTOM_FIELD_OBJECT = {
  application: 'Application',
  candidate: 'Candidate',
  job: 'Job',
  opening: 'Opening',
};

/** Webhook event name. CORRECTED: `application.created` is not an Ashby event. */
export const WEBHOOK_ACTION_APPLICATION_SUBMIT = 'applicationSubmit';

/**
 * Fires when a coordinator merges two duplicate candidate profiles.
 *
 * Sam keys everything it writes on candidateId, so a merge silently orphans our custom
 * field values, the attached Snapshot and the note against an id that no longer resolves.
 * Nothing else we listen for tells us that happened.
 */
export const WEBHOOK_ACTION_CANDIDATE_MERGE = 'candidateMerge';

/** Signature header. HMAC-SHA256 over the RAW request body, formatted `sha256=<hex>`. */
export const SIGNATURE_HEADER = 'ashby-signature';
export const SIGNATURE_PREFIX = 'sha256=';

/** Auth: API key as basic-auth username, empty password. */
export const authHeader = (apiKey) =>
  `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`;

/** Success envelope: { success: true, results }. */
export const ok = (results) => ({ success: true, results });

/** Error envelope: { success: false, errors: [{ message }] }. */
export const fail = (...messages) => ({
  success: false,
  errors: messages.map((message) => ({ message })),
});

/**
 * Custom fields Sam writes back.
 *
 * Role Fit and Coverage are deliberately two fields, not one. A Number field renders
 * as a bare number with no room for a denominator, so a single "65%" would reach the
 * reviewer stripped of the fact that it covers 65% of the rubric.
 */
export const SAM_CUSTOM_FIELDS = {
  roleFit: { name: 'Sam Role Fit', type: 'Number' },

  /**
   * How many of the role's anchors were met, out of how many exist — "5 of 6".
   *
   * THIS REPLACED `Sam Evidence Coverage`, and the reason matters. Coverage answered "how
   * much of the job could Sam even assess", which is the honest denominator for a
   * coverage-denominated score. Sam's live API does not produce that number, and the field
   * rendered as **"Role Fit 94% at 0% evidence coverage"** against a real payload — not
   * missing, actively wrong, on a candidate's record.
   *
   * A met-count is a weaker claim than coverage and it is a TRUE one. String, not Number,
   * because "5 of 6" is the whole point: a lone 83 would be mistaken for a second score.
   */
  anchorsMet: { name: 'Sam Anchors Met', type: 'String' },

  /**
   * Kept so an org that already has the field keeps a place to clear it, and so the local
   * demo path — which does compute coverage — still has somewhere to write. Written as null
   * on every Sam-scored candidate, which reads as empty rather than as zero.
   */
  coverage: { name: 'Sam Evidence Coverage', type: 'Number' },
  capability: { name: 'Sam Capability Score', type: 'Number' },
  poolRank: { name: 'Sam Pool Rank', type: 'String' },

  /**
   * The three fields that make the Summary tab readable WITHOUT opening anything.
   *
   * Four numbers tell a reviewer how this candidate scored and nothing about what to do
   * with them. These carry the verdict, the action and the provenance in the one place
   * Ashby shows beside the résumé — so a recruiter skimming a record gets the whole read
   * before deciding whether the note is worth opening.
   *
   * All String, deliberately. A band is not a number, and rendering "Strong" as a 3 would
   * invite exactly the arithmetic the four-state model exists to prevent.
   */
  band: { name: 'Sam Band', type: 'String' },
  nextStep: { name: 'Sam Next Step', type: 'String' },
  readFrom: { name: 'Sam Read From', type: 'String' },

  /**
   * What a human established that the documents could not — and the ONE field the grading
   * path must never write.
   *
   * Everything above is Sam's judgement, rewritten in full on every delivery, because a
   * stale number in a filterable column is worse than no number. This field is the
   * opposite: it holds what a named person confirmed in the activity feed, and a re-score
   * knows nothing about it. Including it in `samFieldValues` would clear a recruiter's
   * answer on the next pass — the exact failure that function exists to prevent, pointed
   * the other way.
   *
   * So it is declared here to be PROVISIONED with the rest, and written only by the
   * conversation. If you add it to `samFieldValues`, you will delete evidence.
   */
  confirmed: { name: 'Sam Confirmed', type: 'String' },
};

/**
 * What Sam has done for a JOB, shown on the job's own page.
 *
 * The candidate fields answer "how did this person do". Nothing answered "what is Sam doing
 * for this role" — which is the question a hiring manager opening a requisition actually
 * has, and the one a client asks when deciding whether this is worth paying for.
 *
 * `grading` is also the enrolment control: the client ticks it, and that tick IS the
 * enrolled set. The other three are written by each pass, so the job page becomes a status
 * board nobody had to build a portal for.
 */
export const SAM_JOB_FIELDS = {
  grading: { name: 'Sam Grading', type: 'Boolean' },
  graded: { name: 'Sam Candidates Graded', type: 'Number' },
  medianFit: { name: 'Sam Median Role Fit', type: 'Number' },
  lastRun: { name: 'Sam Last Run', type: 'String' },

  /**
   * What Sam noticed about the whole applicant pool — "no applicant for this role shows
   * multi-stakeholder deal navigation; worth confirming whether it is genuinely required".
   *
   * This is the one output that is about the JOB DESCRIPTION rather than a person, and the
   * most commercially interesting thing Sam produces: it tells an employer their own
   * requirements may be screening out people who could do the work. It only exists once
   * there is a cohort to notice it across.
   */
  cohortFinding: { name: 'Sam Cohort Finding', type: 'String' },
};
