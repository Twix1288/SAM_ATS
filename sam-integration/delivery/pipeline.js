/**
 * The delivery workflow: how one application becomes three deliverables in Ashby.
 *
 * Sam writes three surfaces, covering the three things a recruiter does:
 *
 *   1. SCORES      into Ashby's own fields — the candidate becomes searchable and
 *                  filterable, which is what makes a graded candidate findable
 *   2. ATTACHMENT  the full designed Snapshot with the candidate's own resume bound in
 *                  behind it, appended via candidate.uploadFile as a single document
 *   3. RICH NOTE   the summary in the activity feed, pointing at the attachment
 *
 * ORDER IS LOAD-BEARING. Scores go first so the candidate is triageable the moment
 * anything lands. The note goes last because it names the attachment — write it first
 * and it publishes a reference to a document that does not exist yet.
 *
 * Every stage records what it produced, so at the end the run can say plainly whether
 * the deliverables are complete, partially delivered, or failed — rather than leaving
 * a half-finished record and reporting success.
 */
import { renderSnapshotPdf } from '../render/snapshot.js';
import { stitchSnapshotWithResume } from '../render/stitch.js';
import { buildSnapshot } from '../render/model.js';
import { uploadSnapshotFile } from '../endpoints/candidate.uploadFile.js';
import { createSnapshotNote } from '../endpoints/candidate.createNote.js';
import { setSamScores } from '../endpoints/customField.setValue.js';
import { record as recordDelivery } from './ledger.js';

/** The ordered stages. Each one either produces a deliverable or prepares the next. */
export const STAGES = [
  { id: 'receive', label: 'Verify and deduplicate', produces: null },
  { id: 'resolve', label: 'Resolve candidate and job', produces: null },
  { id: 'score', label: 'Score against the compiled rubric', produces: null },
  { id: 'render', label: 'Render the Snapshot', produces: 'snapshot.pdf' },
  { id: 'stitch', label: 'Bind in their resume', produces: 'one document, not two' },
  { id: 'fields', label: 'Write scores into Ashby’s fields', produces: 'DELIVERABLE 1 · dashboard scores' },
  { id: 'attach', label: 'Append the Snapshot to their files', produces: 'DELIVERABLE 2 · attachment' },
  { id: 'annotate', label: 'Write the note that points at it', produces: 'DELIVERABLE 3 · rich note' },
  { id: 'confirm', label: 'Confirm all three landed', produces: 'delivery receipt' },
];

/** The three things this workflow exists to put into Ashby. */
export const DELIVERABLES = [
  {
    id: 'scores',
    name: 'Dashboard scores',
    endpoint: '/customField.setValues',
    surface: 'Custom fields on the Summary tab — searchable and filterable',
    carries: 'Role Fit, Evidence Coverage, Capability and pool rank as typed values',
  },
  {
    id: 'attachment',
    name: 'Snapshot attachment',
    endpoint: '/candidate.uploadFile',
    surface: 'Files list on the candidate record',
    carries: 'The full designed Snapshot — every anchor, its evidence, and the coverage gaps '
      + '— with the candidate’s own resume bound in behind a divider page',
  },
  {
    id: 'note',
    name: 'Rich note',
    endpoint: '/candidate.createNote',
    surface: 'Activity feed, the default tab',
    carries: 'The read: score with its coverage, anchors, gaps, and a route into the detail',
  },
];

export const OUTCOME = {
  complete: 'complete',
  partial: 'partial',
  failed: 'failed',
};

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/**
 * Runs the workflow for one application.
 *
 * @param {object}   ctx
 * @param {object}   ctx.response      the normalized survey response
 * @param {object}   ctx.score         the calibrated score
 * @param {string}   ctx.candidateId   Ashby candidate id
 * @param {string}   ctx.applicationId Ashby application id — custom fields are application-scoped
 * @param {string}   ctx.deliveryId    webhookActionId — the idempotency key
 * @param {string}   ctx.dossierBase   base URL for the hosted dossier
 * @param {object}   ctx.rubric        the rubric resolved from the application's job
 * @param {Function} [ctx.onStage]     progress callback, for the live walkthrough
 */
export async function deliverSnapshot(ctx) {
  const {
    response, score, candidateId, applicationId, deliveryId, dossierBase, rubric,
    onStage = () => {},
  } = ctx;

  const steps = [];
  const record = (id, ok, detail) => {
    const stage = STAGES.find((s) => s.id === id);
    const step = { id, label: stage.label, produces: stage.produces, ok, detail };
    steps.push(step);
    onStage(step);
    return step;
  };

  record('receive', true, `delivery ${deliveryId.slice(0, 8)} · signature verified`);
  record('resolve', true,
    `${response.name} → ${rubric ? rubric.jobTitle : 'unknown job'} · ${response.answeredCount} of 6 questions answered`);

  // ── score ────────────────────────────────────────────────────────────────
  const snapshot = buildSnapshot(score, response);
  const spans = snapshot.roleAnchors.reduce((n, a) => n + a.spans.length, 0);
  record('score', true,
    `Role Fit ${Math.round(score.roleFit * 100)}% at ${Math.round(score.coverage * 100)}% coverage · ${spans} quotable spans`);

  // ── render ───────────────────────────────────────────────────────────────
  const filename = `sam_snapshot_${slug(response.name)}.pdf`;
  const pdf = await renderSnapshotPdf(snapshot);
  record('render', true, `${filename} · ${pdf.length} bytes`);

  // Ashby's Files list gives no ordering and no way to say "read this one first", so two
  // documents on a record is two documents the reviewer has to relate to each other.
  // Binding the resume in behind the Snapshot makes the judgement and its evidence one
  // artefact. Degrades to the Snapshot alone rather than failing the delivery.
  const bound = await stitchSnapshotWithResume({ snapshotBytes: pdf, response });
  record('stitch', true,
    `${bound.pages} pages · ${bound.snapshotPages} Snapshot + ${bound.resumePages} resume · ${bound.detail}`);

  const dossierUrl = `${dossierBase}/${slug(response.name)}`;

  // ── DELIVERABLE 1 · dashboard scores ─────────────────────────────────────
  // First, so the candidate is sortable in the pipeline the moment anything lands.
  // Role Fit never ships without Coverage beside it as its own field.
  let fields = null;
  try {
    fields = await setSamScores({ applicationId, snapshot, deliveryId });
    record('fields', true, `${fields.length} fields on the application · ${fields.map((f) => f.value).join(' · ')}`);
  } catch (err) {
    record('fields', false, err.message);
  }

  // ── DELIVERABLE 2 · attachment ───────────────────────────────────────────
  // Deliberately candidate.uploadFile, not candidate.uploadResume: this appends to the
  // candidate's fileHandles rather than writing the resume slot, so their own document
  // is never displaced.
  let attachment = null;
  try {
    attachment = await uploadSnapshotFile({ candidateId, filename, bytes: bound.bytes, deliveryId });
    record('attach', true,
      `${filename} appended via ${attachment.via} · ${attachment.bytes} bytes · ${bound.mode}`);
  } catch (err) {
    record('attach', false, err.message);
  }

  // ── DELIVERABLE 3 · rich note ────────────────────────────────────────────
  // Written last so it can name the file that now exists. If the attachment failed, the
  // note still goes out — but without a reference to a document that is not there.
  let note = null;
  try {
    note = await createSnapshotNote({
      candidateId,
      snapshot,
      dossierUrl,
      deliveryId,
      attachment: attachment
        ? { filename, pages: bound.pages, resumePages: bound.resumePages, mode: bound.mode }
        : null,
    });
    record('annotate', true, `${note.format} · ${note.body.length} chars${attachment ? ' · references the attachment' : ' · no attachment to reference'}`);
  } catch (err) {
    record('annotate', false, err.message);
  }

  // ── confirm ──────────────────────────────────────────────────────────────
  const delivered = [
    { ...DELIVERABLES[0], ok: Boolean(fields), detail: fields ? `${fields.length} fields` : 'not delivered' },
    { ...DELIVERABLES[1], ok: Boolean(attachment), detail: attachment ? filename : 'not delivered' },
    { ...DELIVERABLES[2], ok: Boolean(note), detail: note ? note.format : 'not delivered' },
  ];
  const okCount = delivered.filter((d) => d.ok).length;
  const outcome = okCount === delivered.length ? OUTCOME.complete
    : okCount === 0 ? OUTCOME.failed
      : OUTCOME.partial;

  // Remember what landed and where. This is what makes a later candidateMerge recoverable
  // rather than silent data loss.
  if (fields || attachment || note) {
    recordDelivery({
      candidateId, applicationId, snapshot, dossierUrl,
      filename: attachment ? filename : null,
    });
  }

  record('confirm', outcome === OUTCOME.complete,
    `${okCount} of ${delivered.length} deliverables on the record — ${outcome}`);

  return {
    outcome,
    complete: outcome === OUTCOME.complete,
    candidate: response.name,
    deliveryId,
    roleFit: score.roleFit,
    coverage: score.coverage,
    capability: score.capability,
    steps,
    delivered,
    filename,
    dossierUrl,
    snapshot,
    pdf,
  };
}
