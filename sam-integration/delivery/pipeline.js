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
import { fetchSnapshotPdf } from '../sam/client.js';
import { stitchSnapshotWithResume, stitchSnapshot } from '../render/stitch.js';
import { buildSnapshot } from '../render/model.js';
import { uploadSnapshotFile, snapshotFilename } from '../endpoints/candidate.uploadFile.js';
import { createSnapshotNote } from '../endpoints/candidate.createNote.js';
import { setSamScores } from '../endpoints/customField.setValue.js';
import { record as recordDelivery } from './ledger.js';
import { tagAsGraded, tagBand } from '../endpoints/candidate.addTag.js';
import { addToSamProject } from '../endpoints/candidate.addProject.js';
import { refFor } from './followUp.js';
import { openQuestionsFor } from './openQuestions.js';
import { unansweredFrom, recordAsked } from './conversation.js';
import { ASK_LIMIT } from '../endpoints/candidate.createNote.js';

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
  { id: 'tag', label: 'Mark them findable', produces: 'a search facet, not a judgement' },
  { id: 'project', label: 'Add to the Sam project', produces: 'the one sortable column surface' },
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
    snapshot: prebuiltSnapshot = null,
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
    `${response.name} → ${rubric ? rubric.jobTitle : 'unknown job'}`
    + (response.answeredCount == null ? '' : ` · ${response.answeredCount} of 6 questions answered`));

  // ── score ────────────────────────────────────────────────────────────────
  // THE PRODUCTION SEAM. When Sam's engine is live the caller has already turned its payload
  // into a view model with snapshotFromEnginePayload, and passes it here — this side never
  // re-derives a number. `buildSnapshot` is the demo path, scoring locally from the survey,
  // and it is the half that disappears when the engine lands.
  const snapshot = prebuiltSnapshot ?? buildSnapshot(score, response);
  const spans = snapshot.roleAnchors.reduce((n, a) => n + (a.spans?.length ?? 0), 0);
  record('score', true,
    `Role Fit ${Math.round(snapshot.roleFit * 100)}% at ${Math.round(snapshot.coverage * 100)}% coverage · ${spans} quotable spans`);

  // ── render ───────────────────────────────────────────────────────────────


  /**
   * SAM RENDERS, WE PLACE.
   *
   * Sam returns a PDF of its own alongside every score, and it is the better document: it
   * carries the cohort rank, marks requirements core or supporting, and gives met-by-
   * equivalence a callout naming the assumption. Drawing our own from the same JSON means
   * our version silently drifts from theirs every time they improve it.
   *
   * Ours stays as the fallback, because a Snapshot we drew is worth far more to a reviewer
   * than no Snapshot at all — and the stage line says which one landed, so a silent
   * downgrade is not possible.
   */
  let pdf;
  let renderedBy = 'sam';
  if (snapshot.samPdfUrl) {
    try {
      pdf = await fetchSnapshotPdf(snapshot.samPdfUrl);
    } catch (err) {
      renderedBy = 'us (Sam’s PDF unavailable)';
      record('render', true, `falling back to our renderer — ${String(err.message).slice(0, 70)}`);
    }
  } else {
    renderedBy = 'us (no Sam PDF in the payload)';
  }
  if (!pdf) pdf = await renderSnapshotPdf(snapshot);

  // Named AFTER rendering, because the name carries a fingerprint of the bytes — that is
  // what lets an improved Snapshot attach while an identical re-run still dedupes.
  const filename = snapshotFilename(response.name, pdf);
  record('render', true, `${filename} · ${pdf.length} bytes · rendered by ${renderedBy}`);

  // Ashby's Files list gives no ordering and no way to say "read this one first", so two
  // documents on a record is two documents the reviewer has to relate to each other.
  // Binding the resume in behind the Snapshot makes the judgement and its evidence one
  // artefact. Degrades to the Snapshot alone rather than failing the delivery.
  // Documents come from ASHBY when the caller supplies them — the production path — and from
  // the local cache only for the demo. Without this the engine path shipped the Snapshot
  // alone: the candidate has a résumé on their Ashby record, and the stitch was looking for
  // it in a survey response that has no files in it.
  const bound = ctx.documents
    ? await stitchSnapshot({ snapshotBytes: pdf, sources: ctx.documents })
    : await stitchSnapshotWithResume({ snapshotBytes: pdf, response });
  record('stitch', true,
    `${bound.pages} pages · ${bound.snapshotPages} Snapshot + ${bound.resumePages} resume · ${bound.detail}`);

  // The engine's own link wins. Only fall back to a locally constructed one for the demo
  // path, where there is no engine and therefore no canonical URL to prefer.
  const dossierUrl = snapshot.samUrl ?? `${dossierBase}/${slug(response.name)}`;

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

  // What Sam does not know, best first, minus anything a person has already answered.
  //
  // The second half is what makes this a conversation rather than a recurring notice: a
  // candidate with eight open items gets the top three now and the NEXT three once those
  // are answered, instead of the same three forever.
  const conversationJobId = rubric?.jobId ?? applicationId;
  const ref = refFor(candidateId, conversationJobId);
  const asking = unansweredFrom(
    openQuestionsFor(snapshot, conversationJobId), candidateId, conversationJobId,
  ).slice(0, ASK_LIMIT);

  try {
    note = await createSnapshotNote({
      candidateId,
      snapshot,
      dossierUrl,
      deliveryId,
      // Ties a reply back to THIS grading. Without it "the next note after ours" is the
      // only way to find an answer, and that is wrong the moment two recruiters are
      // talking to each other on the same candidate — which they do.
      ref,
      questions: asking,
      attachment: attachment
        ? {
          filename,
          pages: bound.pages,
          resumePages: bound.resumePages,
          mode: bound.mode,
          extras: bound.bound.filter((b) => !b.read).map((b) => b.label).join(', '),
        }
        : null,
    });
    // Recorded only once the note is actually ON the record. Writing it before the post
    // would mark questions as asked that nobody can see, and the next pass would move on to
    // the following three — losing them silently.
    if (asking.length) recordAsked({ candidateId, jobId: conversationJobId, ref, questions: asking });
    record('annotate', true, `${note.format} · ${note.body.length} chars`
      + `${attachment ? ' · references the attachment' : ' · no attachment to reference'}`
      + `${asking.length ? ` · asking ${asking.length} open question(s)` : ''}`);
  } catch (err) {
    record('annotate', false, err.message);
  }

  // ── discovery marker ─────────────────────────────────────────────────────
  // Last, and deliberately not one of the three DELIVERABLES. The tag carries no judgement
  // and duplicates no content — it exists only so a recruiter can FIND graded candidates,
  // which the custom fields cannot do: every Ashby list endpoint ignores a custom-field
  // filter and still returns success. Never throws, and never fails a delivery.
  const tag = await tagAsGraded({ candidateId });
  record('tag', tag.ok, tag.ok ? `tagged "${tag.tag}" — findable in candidate search` : `not tagged — ${tag.detail}`);

  // And into the Sam project, if the client made one. This is the only Ashby surface where
  // the four numbers become a SORTABLE COLUMN rather than four values on one person's page —
  // custom-field filtering does not exist on any list endpoint. Silent when no project
  // exists, because that is a choice the client is entitled to make.
  // The band as a tag: the only ranked-ish view that needs NO setup from the client. A
  // Project gives sortable columns but someone has to add them by hand; a tag is a search
  // facet the moment it lands.
  const bandTag = await tagBand({ candidateId, band: snapshot.band });
  if (!bandTag.skipped) {
    record('tag', bandTag.ok,
      bandTag.ok
        ? `tagged "${bandTag.tag}"${bandTag.removed?.length ? ` · removed ${bandTag.removed.join(', ')}` : ''}`
        : `band not tagged — ${bandTag.detail}`);
  }

  const project = await addToSamProject({ candidateId });
  if (!project.skipped) {
    record('project', project.ok,
      project.ok ? 'added to the Sam project — sortable by Role Fit there' : `not added — ${project.detail}`);
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
      candidateId,
      // Keyed with the job, so one person applying to two roles gets a Snapshot for each
      // instead of the second sweep seeing them as already delivered.
      jobId: rubric?.jobId ?? 'unknown-job',
      applicationId,
      snapshot,
      dossierUrl,
      filename: attachment ? filename : null,
      // Which wording of the job description this score answers. Without it, an edited
      // posting is undetectable and every published score quietly becomes unverifiable.
      descriptionVersion: ctx.descriptionVersion ?? null,
      // WHICH surfaces actually landed. A partial delivery must not read as done: the
      // fields can be on the record with no note explaining them, and if the ledger called
      // that finished nothing would ever look at this candidate again. Recording the map
      // makes the next pass finish the job instead of skipping it.
      surfaces: {
        fields: Boolean(fields),
        attachment: Boolean(attachment),
        note: Boolean(note),
      },
    });
  }

  record('confirm', outcome === OUTCOME.complete,
    `${okCount} of ${delivered.length} deliverables on the record — ${outcome}`);

  return {
    outcome,
    complete: outcome === OUTCOME.complete,
    candidate: response.name,
    deliveryId,
    // Read off the SNAPSHOT, not the raw score. On the engine path there is no local
    // `score` object at all — the numbers arrive already decided — and reading `score` here
    // threw after all three surfaces had already landed, so a completed delivery reported
    // itself as a failure.
    roleFit: snapshot.roleFit,
    coverage: snapshot.coverage,
    capability: snapshot.capability,
    steps,
    delivered,
    filename,
    dossierUrl,
    snapshot,
    pdf,
  };
}
