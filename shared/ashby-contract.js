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
  listInterviewStages: '/interviewStage.list',

  /**
   * Investigated and not used. Kept named so the decision is visible in the contract
   * rather than lost: the assessment framework is partner-gated, and a scorecard filed
   * beside human ones reads as a peer opinion. Both are questions for Ashby, not code.
   */
  // addCompletedAssessment: '/assessment.addCompletedToCandidate',
  // submitFeedback:         '/applicationFeedback.submit',
  // addTag:                 '/candidate.addTag',
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
  coverage: { name: 'Sam Evidence Coverage', type: 'Number' },
  capability: { name: 'Sam Capability Score', type: 'Number' },
  poolRank: { name: 'Sam Pool Rank', type: 'String' },
};
