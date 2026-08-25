/**
 * Ashby's system of record.
 *
 * This is the important boundary in the whole mockup. Ashby holds the candidates,
 * their applications, their files and their custom field values — and the Ashby UI
 * renders THIS, not anything Sam computed. So a score only appears on screen if a
 * real API call actually landed it here.
 *
 * Seeded with what Ashby genuinely knows the moment someone applies: who they are,
 * how to reach them, the resume they uploaded, and which stage they are in. Nothing
 * from Sam. Everything Sam contributes arrives later, through the write endpoints.
 */
import { randomUUID, createHmac } from 'node:crypto';

/** Deterministic ids, so a restart does not invalidate links the demo just used. */
const stableId = (seed) => {
  const h = createHmac('sha256', 'ashby-demo').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/** Ashby's interview stages for this job. */
export const INTERVIEW_STAGES = [
  { id: stableId('stage:lead'), title: 'Lead', type: 'Lead', orderInInterviewPlan: 1 },
  { id: stableId('stage:review'), title: 'Application Review', type: 'Active', orderInInterviewPlan: 2 },
  { id: stableId('stage:screen'), title: 'Screen', type: 'Active', orderInInterviewPlan: 3 },
  { id: stableId('stage:interview'), title: 'Interview', type: 'Active', orderInInterviewPlan: 4 },
  { id: stableId('stage:offer'), title: 'Offer', type: 'Offer', orderInInterviewPlan: 5 },
  { id: stableId('stage:archived'), title: 'Archived', type: 'Archived', orderInInterviewPlan: 6 },
];

export const JOB = {
  id: stableId('job:sales-ae'),
  title: 'Sales Account Executive',
  status: 'Open',
  employmentType: 'FullTime',
  location: { locationSummary: 'Remote · hybrid flexibility' },
};

/**
 * Custom field definitions configured on this Ashby instance.
 *
 * Sam resolves these by title through customField.list and then writes by id — it can
 * never invent a field, exactly as in production.
 */
export const CUSTOM_FIELDS = [
  { id: stableId('cf:roleFit'), title: 'Sam Role Fit', objectType: 'Application', fieldType: 'Number', isArchived: false },
  { id: stableId('cf:coverage'), title: 'Sam Evidence Coverage', objectType: 'Application', fieldType: 'Number', isArchived: false },
  { id: stableId('cf:capability'), title: 'Sam Capability Score', objectType: 'Application', fieldType: 'Number', isArchived: false },
  { id: stableId('cf:poolRank'), title: 'Sam Pool Rank', objectType: 'Application', fieldType: 'String', isArchived: false },
];

const REVIEW_STAGE = INTERVIEW_STAGES.find((s) => s.title === 'Application Review');

/** In-memory tables, keyed the way the read endpoints need them. */
const candidates = new Map();
const applications = new Map();
const notesByCandidate = new Map();
const filesById = new Map();
const uploadHandles = new Map();

export const ids = {
  candidateFor: (hash) => stableId(`candidate:${hash}`),
  applicationFor: (hash) => stableId(`application:${hash}`),
};

/**
 * Seeds one applicant exactly as Ashby would hold them at the moment of applying.
 * Deliberately takes only identity and the uploaded resume — no scores.
 */
export function seedApplicant({ responseHash, name, email, location, linkedin, resume, attachments = [], appliedAt }) {
  const candidateId = ids.candidateFor(responseHash);
  const applicationId = ids.applicationFor(responseHash);

  const fileHandles = [];
  const addFile = (doc, isResume) => {
    if (!doc) return null;
    const id = stableId(`file:${responseHash}:${doc.name}`);
    const handle = {
      id, name: doc.name, url: doc.url,
      contentType: doc.name.endsWith('.docx')
        ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : 'application/pdf',
      uploadedAt: appliedAt,
      source: 'candidate',
    };
    filesById.set(id, handle);
    if (!isResume) fileHandles.push(handle);
    return handle;
  };

  const resumeFileHandle = addFile(resume, true);
  for (const a of attachments) addFile(a, false);

  candidates.set(candidateId, {
    id: candidateId,
    name,
    primaryEmailAddress: email ? { value: email, type: 'Personal', isPrimary: true } : null,
    phoneNumbers: [],
    socialLinks: linkedin ? [{ type: 'LinkedIn', url: linkedin }] : [],
    location: location ? { locationSummary: location } : null,
    tags: [],
    source: { title: 'Job Board' },
    createdAt: appliedAt,
    resumeFileHandle,
    fileHandles,
    applicationIds: [applicationId],
  });

  applications.set(applicationId, {
    id: applicationId,
    candidateId,
    jobId: JOB.id,
    status: 'Active',
    currentInterviewStage: { id: REVIEW_STAGE.id, title: REVIEW_STAGE.title, type: REVIEW_STAGE.type },
    createdAt: appliedAt,
    customFields: [],
  });

  return { candidateId, applicationId };
}

// ── reads, shaped the way the matching Ashby endpoints return ────────────────

export const listCandidates = () => [...candidates.values()];
export const getCandidate = (id) => candidates.get(id) ?? null;
export const listApplications = () => [...applications.values()];
export const getApplication = (id) => applications.get(id) ?? null;
export const listNotes = (candidateId) => notesByCandidate.get(candidateId) ?? [];
export const getFile = (id) => filesById.get(id) ?? null;

/** An application with its candidate and custom field values resolved for display. */
export function expandApplication(app) {
  const candidate = candidates.get(app.candidateId);
  const values = Object.fromEntries(app.customFields.map((v) => [v.title, v.value]));
  return { ...app, candidate, customFieldValues: values };
}

// ── writes, called only by the API handlers ──────────────────────────────────

/** customField.setValues — replaces by fieldId so a redelivery cannot duplicate a row. */
export function setCustomFieldValues(objectId, values) {
  const app = applications.get(objectId);
  if (!app) return null;
  for (const { fieldId, fieldValue } of values) {
    const def = CUSTOM_FIELDS.find((f) => f.id === fieldId);
    if (!def) continue;
    const existing = app.customFields.find((v) => v.id === fieldId);
    if (existing) existing.value = fieldValue;
    else app.customFields.push({ id: fieldId, title: def.title, fieldType: def.fieldType, value: fieldValue });
  }
  return app;
}

/** candidate.uploadFile — appends to fileHandles, never touching resumeFileHandle. */
export function attachFile(candidateId, { name, bytes, contentType = 'application/pdf', source = 'Sam' }) {
  const candidate = candidates.get(candidateId);
  if (!candidate) return null;
  const id = stableId(`file:sam:${candidateId}:${name}`);
  const handle = { id, name, contentType, uploadedAt: new Date(0).toISOString(), source, size: bytes?.length ?? 0 };
  filesById.set(id, handle);
  const at = candidate.fileHandles.findIndex((f) => f.name === name);
  if (at >= 0) candidate.fileHandles[at] = handle;
  else candidate.fileHandles.push(handle);
  return handle;
}

/** candidate.createNote — newest first, matching the activity feed's own order. */
export function addNote(candidateId, { type, value, author = 'Sam' }) {
  if (!candidates.has(candidateId)) return null;
  const note = {
    id: randomUUID(),
    createdAt: new Date(0).toISOString(),
    author,
    content: { type, value },
  };
  const list = notesByCandidate.get(candidateId) ?? [];
  list.unshift(note);
  notesByCandidate.set(candidateId, list);
  return note;
}

export const putUploadHandle = (handle, meta) => uploadHandles.set(handle, meta);
export const getUploadHandle = (handle) => uploadHandles.get(handle) ?? null;
export const hasUploadHandle = (handle) => uploadHandles.has(handle);

/** What Sam has contributed so far — drives the "nothing yet" state in the UI. */
export function samCoverage() {
  const apps = [...applications.values()];
  const scored = apps.filter((a) => a.customFields.length > 0).length;
  const withFile = [...candidates.values()].filter((c) => c.fileHandles.some((f) => f.source === 'Sam')).length;
  const withNote = [...notesByCandidate.values()].filter((n) => n.length > 0).length;
  return { total: apps.length, scored, withFile, withNote };
}
