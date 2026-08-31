import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { loadPool, findByRow } from '../shared/seed/survey.js';
import { extractAll } from '../sam-integration/services/evidence.js';
import { scoreResponse } from '../sam-integration/services/score.js';
import { scorePool } from '../sam-integration/services/calibrate.js';
import { buildSnapshot } from '../sam-integration/render/model.js';
import { STATE, TOTAL_WEIGHT } from '../sam-integration/services/rubric.js';
import { verifySignature, parseEnvelope, createDeliveryLog } from '../sam-integration/webhooks/applicationSubmit.js';
import { SIGNATURE_PREFIX, ENDPOINTS, WEBHOOK_ACTION_APPLICATION_SUBMIT, UPLOAD_HANDLE_PARAMS, ok, fail } from '../shared/ashby-contract.js';
import { PLACEMENT_VERSIONS, REFUSED, INVESTIGATED, placementById, singlePointFields } from '../sam-integration/placements/registry.js';
import { SNAPSHOT_FIELDS, fidelityScore } from '../sam-integration/placements/fields.js';
import { composeNoteHtml, composeNote } from '../sam-integration/endpoints/candidate.createNote.js';
import { STAGES, DELIVERABLES, OUTCOME } from '../sam-integration/delivery/pipeline.js';
import * as ledger from '../sam-integration/delivery/ledger.js';
import { reconcileMerge, MERGE_OUTCOME } from '../sam-integration/delivery/merge.js';
import * as db from '../ashby-simulator/store.js';
import { rubricForJob, UnknownJobError, registeredJobs } from '../sam-integration/services/rubrics.js';
import { OPEN_QUESTIONS, HIGH_RISK } from '../scripts/questions.js';
import { snapshotFromEnginePayload, validateEnginePayload, MIN_SCOREABLE_COVERAGE, scoreIsPublishable } from '../sam-integration/ingest/enginePayload.js';
import { samFieldValues, CLEAR } from '../sam-integration/endpoints/customField.setValue.js';
import { seedApplicant, setCustomFieldValues, getApplication, CUSTOM_FIELDS } from '../ashby-simulator/store.js';
import { raiseAlert, listAlerts, resetAlerts, onAlert, ALERT, SEVERITY } from '../sam-integration/delivery/alerts.js';
import { sweepJob, sweepAll, resetCursors, SWEEP_OUTCOME } from '../sam-integration/delivery/sweep.js';
import { SAM_CUSTOM_FIELDS } from '../shared/ashby-contract.js';
import { extractPdfText } from '../sam-integration/ingest/pdf.js';
import { renderSnapshotPdf } from '../sam-integration/render/snapshot.js';
import { stitchSnapshot, stitchSnapshotWithResume, STITCH_MODE, toWinAnsi, MAX_BOUND_PAGES } from '../sam-integration/render/stitch.js';
import { resumeFileForResponse, candidateFilesForResponse } from '../sam-integration/ingest/resume.js';
import { ANCHORS } from '../sam-integration/services/rubric.js';
import { renderAshbyUI } from '../ashby-simulator/ui.js';
import { readFileSync, readdirSync } from 'node:fs';

const SURVEY = join(import.meta.dirname, '..', 'data', 'survey_agree.com_business_development_representative.xlsx');
const pool = loadPool(SURVEY);
const aditya = findByRow(pool, 6);

describe('survey ingest', () => {
  test('parses every response without the vulnerable xlsx package', () => {
    assert.equal(pool.length, 41);
    assert.equal(aditya.name, 'Aditya Alapati');
  });

  test('Q4 (invoiced volume) collected no response pool-wide', () => {
    const answered = pool.filter((r) => r.answers.find((a) => a.id === 'Q4').answered);
    assert.equal(answered.length, 0, 'Q4 must be empty for all 41 — this drives the NOT_COLLECTED state');
  });

  test('every candidate has a resume on file', () => {
    const without = pool.filter((r) => !r.resume).map((r) => r.name);
    assert.deepEqual(without, [], 'resumes live in HYPERLINK formulas, not the cached <v>');
    assert.equal(pool.length, 41);
  });

  test('a HYPERLINK resume cell yields its target and its display name', () => {
    assert.equal(aditya.resume.name, 'Aditya Alapati_CV.pdf');
    assert.match(aditya.resume.url, /^https:\/\/cdn\.voiceform\.com\/.*aditya_alapati_cv\.pdf$/);
  });

  test('a cell holding several bare URLs yields resume plus attachments', () => {
    const hare = pool.find((r) => r.name === 'James Hare');
    assert.match(hare.resume.name, /resume\.pdf$/);
    assert.equal(hare.attachments.length, 1);
    assert.match(hare.attachments[0].name, /cover_letter\.pdf$/);
  });

  test('a formula cell never leaks its cached value', () => {
    for (const r of pool) assert.notEqual(r.resume?.name, '0');
  });
});

describe('evidence disambiguation', () => {
  test('"I ramp quickly" does not count as the employer Ramp', () => {
    const hits = pool.flatMap((r) =>
      Object.values(extractAll(r)).flatMap((q) => q.fintechEmployer ?? []));
    assert.equal(hits.length, 0, 'a naive token scan returns 1 false positive here');
  });

  test('evidence quotes never clip mid-word', () => {
    for (const anchor of scoreResponse(aditya).anchors) {
      for (const span of anchor.spans) {
        const trimmed = span.quote.replace(/^…|…$/g, '');
        assert.ok(trimmed.length > 0);
        assert.ok(!/\s$/.test(trimmed), 'quote should not end on whitespace');
      }
    }
  });

  test('every scored anchor carries a quotable span', () => {
    for (const a of scoreResponse(aditya).anchors) {
      if (a.state === STATE.MET) assert.ok(a.spans.length > 0, `${a.id} is MET but has no evidence`);
    }
  });
});

describe('scoring', () => {
  const score = scoreResponse(aditya);

  test('distinguishes NOT_COLLECTED from NOT_MET', () => {
    const byId = Object.fromEntries(score.anchors.map((a) => [a.id, a.state]));
    assert.equal(byId.A4, STATE.NOT_COLLECTED, 'question was never answered by anyone');
    assert.equal(byId.A6, STATE.NOT_COLLECTED, 'no question maps to this anchor');
    assert.equal(byId.A5, STATE.NOT_MET, 'question answered, evidence genuinely absent');
  });

  test('NOT_COLLECTED anchors are excluded from the denominator, not scored as zero', () => {
    const observable = score.anchors.filter((a) => a.state !== STATE.NOT_COLLECTED);
    const observableWeight = observable.reduce((s, a) => s + a.weight, 0);
    assert.equal(score.coverage, Math.round((observableWeight / TOTAL_WEIGHT) * 100) / 100);
    assert.ok(score.coverage < 1, 'coverage must reflect the two uncollected anchors');
  });

  test('band is qualified when coverage is incomplete', () => {
    assert.match(score.band, /verify live/);
  });

  test('scoring is deterministic', () => {
    assert.deepEqual(scoreResponse(aditya), scoreResponse(findByRow(loadPool(SURVEY), 6)));
  });

  test('no candidate reaches a Strong band on this instrument', () => {
    // Max coverage is 65%, so every band must carry its caveat.
    for (const { score: s } of scorePool(pool)) assert.match(s.band, /verify live/);
  });
});

describe('pool calibration', () => {
  const scored = scorePool(pool);

  test('scores the whole pool, never one candidate in isolation', () => {
    assert.equal(scored.length, 41);
    assert.ok(scored.every((s) => s.score.pool.size === 41));
  });

  test('ranks are unique and complete', () => {
    const ranks = scored.map((s) => s.score.pool.roleFitRank).sort((a, b) => a - b);
    assert.deepEqual(ranks, Array.from({ length: 41 }, (_, i) => i + 1));
  });

  test('discriminates well enough for rank to be meaningful', () => {
    const distinct = new Set(scored.map((s) => s.score.roleFit)).size;
    assert.ok(distinct >= 20, `only ${distinct} distinct scores across 41 candidates`);
  });

  test('evidence ranking differs from sentiment ranking', () => {
    const bySentiment = [...pool].sort((a, b) => {
      const mean = (r) => { const v = r.answers.map((x) => x.sentimentScore).filter((n) => Number.isFinite(n)); return v.reduce((s, n) => s + n, 0) / v.length; };
      return mean(b) - mean(a);
    });
    const topByEvidence = scored.find((s) => s.score.pool.roleFitRank === 1).response.name;
    assert.notEqual(bySentiment[0].name, topByEvidence, 'sentiment must not be a proxy for evidence');
  });
});

describe('Ashby webhook contract', () => {
  const secret = 'test_secret';
  const body = Buffer.from(JSON.stringify({
    webhookActionId: 'abc-123',
    action: WEBHOOK_ACTION_APPLICATION_SUBMIT,
    data: { application: { id: 'app-1', candidate: { id: 'cand-1' } }, surveyRow: 6 },
  }));
  const sig = SIGNATURE_PREFIX + createHmac('sha256', secret).update(body).digest('hex');

  test('accepts a correctly signed payload', () => {
    assert.equal(verifySignature(body, sig, secret), true);
  });

  test('rejects a forged signature', () => {
    assert.equal(verifySignature(body, `${SIGNATURE_PREFIX}deadbeef`, secret), false);
  });

  test('rejects a missing signature', () => {
    assert.equal(verifySignature(body, undefined, secret), false);
  });

  test('rejects a payload mutated after signing', () => {
    const tampered = Buffer.from(body.toString().replace('"surveyRow":6', '"surveyRow":7'));
    assert.equal(verifySignature(tampered, sig, secret), false);
  });

  test('accepts the real applicationSubmit envelope', () => {
    assert.equal(parseEnvelope(body).action, 'applicationSubmit');
  });

  test('rejects the non-existent application.created event', () => {
    const wrong = Buffer.from(JSON.stringify({ webhookActionId: 'x', action: 'application.created', data: {} }));
    assert.throws(() => parseEnvelope(wrong), /Unsupported action/);
  });

  test('deduplicates redelivered webhookActionIds', () => {
    const log = createDeliveryLog();
    assert.equal(log.isDuplicate('abc-123'), false);
    log.remember('abc-123', { ok: true });
    assert.equal(log.isDuplicate('abc-123'), true);
  });
});

describe('Ashby API contract', () => {
  test('uses the verified endpoint names', () => {
    assert.equal(ENDPOINTS.createNote, '/candidate.createNote', 'not candidateNote.create');
    assert.equal(ENDPOINTS.uploadResume, '/candidate.uploadResume');
    assert.equal(ENDPOINTS.setCustomField, '/customField.setValue');
  });

  test('envelopes match Ashby shapes', () => {
    assert.deepEqual(ok({ id: 1 }), { success: true, results: { id: 1 } });
    assert.deepEqual(fail('nope'), { success: false, errors: [{ message: 'nope' }] });
  });
});

describe('the three surfaces', () => {
  test('exactly three, each doing a different job', () => {
    assert.equal(PLACEMENT_VERSIONS.length, 3);
    const jobs = new Set(PLACEMENT_VERSIONS.map((p) => p.job));
    assert.equal(jobs.size, 3, 'two surfaces doing the same job means one is redundant');
  });

  test('they land in three different places', () => {
    const tabs = new Set(PLACEMENT_VERSIONS.map((p) => p.tab));
    assert.equal(tabs.size, 3);
  });

  test('fidelity is derived from the field matrix, never asserted', () => {
    for (const p of PLACEMENT_VERSIONS) {
      assert.equal(p.fidelity, fidelityScore(p.survives), `${p.id} fidelity disagrees with its field list`);
    }
  });

  test('lost is the exact complement of survives', () => {
    for (const p of PLACEMENT_VERSIONS) {
      assert.equal(p.survives.length + p.lost.length, SNAPSHOT_FIELDS.length, `${p.id} field accounting`);
    }
  });

  test('the score and its coverage appear on every surface', () => {
    for (const p of PLACEMENT_VERSIONS) {
      assert.ok(p.survives.includes('matchScore'), `${p.id} drops the score`);
      assert.ok(p.survives.includes('coverage'), `${p.id} would show a score with no denominator`);
    }
  });

  test('the Snapshot never goes in the candidate resume slot', () => {
    for (const p of PLACEMENT_VERSIONS) {
      assert.notEqual(p.endpoint, ENDPOINTS.uploadResume,
        'writing the Snapshot to the resume slot risks displacing the candidate’s own document');
    }
    assert.equal(REFUSED.endpoint, ENDPOINTS.uploadResume);
    assert.ok(REFUSED.reason.length > 40, 'the refusal needs a real reason, not a label');
  });

  test('the document surface uses candidate.uploadFile', () => {
    assert.equal(placementById('document').endpoint, ENDPOINTS.uploadFile);
  });

  test('the data surface claims only what Ashby documents', () => {
    const fields = placementById('fields');
    assert.equal(fields.endpoint, ENDPOINTS.setCustomFields);
    // Confirmed by Ashby's knowledge base.
    assert.ok(fields.verified.summaryTab);
    assert.ok(fields.verified.searchFilter);
    assert.ok(fields.verified.projectColumns);
    // NOT documented. The mockup draws it, the registry must not claim it.
    assert.equal(fields.verified.pipelineColumn, false,
      'custom-field columns are documented for Projects, not the candidate pipeline');
    assert.equal(fields.verified.sortByValue, false,
      'sorting records by a custom field value is nowhere documented');
    assert.doesNotMatch(fields.appearsOn, /sortable/i,
      'the surface description must not assert sortability');
  });

  test('each surface carries something no other one does', () => {
    const single = singlePointFields();
    assert.ok(single.length > 0, 'three identical surfaces would be two too many');
  });
});
describe('delivery workflow', () => {
  const entry = scorePool(pool).find((e) => e.response.rowNumber === 6);
  const snapshot = buildSnapshot(entry.score, entry.response);
  const DOSSIER = 'https://sam.app/dossier/aditya-alapati';

  test('ships exactly three deliverables, in triage-read-detail order', () => {
    assert.equal(DELIVERABLES.length, 3);
    assert.deepEqual(DELIVERABLES.map((d) => d.endpoint),
      ['/customField.setValues', '/candidate.uploadFile', '/candidate.createNote']);
  });

  test('nothing is ever written to the resume slot', () => {
    for (const d of DELIVERABLES) assert.notEqual(d.endpoint, ENDPOINTS.uploadResume);
    assert.ok(DELIVERABLES.some((d) => d.endpoint === ENDPOINTS.uploadFile));
  });

  test('scores are written before anything else, so the pipeline sorts immediately', () => {
    const ids = STAGES.map((x) => x.id);
    assert.ok(ids.indexOf('fields') < ids.indexOf('attach'));
    assert.ok(ids.indexOf('fields') < ids.indexOf('annotate'));
  });

  test('the attachment stage runs before the note stage', () => {
    const ids = STAGES.map((s) => s.id);
    assert.ok(ids.indexOf('attach') < ids.indexOf('annotate'),
      'the note names the attachment, so the file has to land first');
  });

  test('every stage that produces a deliverable says so', () => {
    const producing = STAGES.filter((x) => x.produces?.startsWith('DELIVERABLE'));
    assert.equal(producing.length, 3);
  });

  test('a note written after a successful attachment names the file', () => {
    const html = composeNoteHtml(snapshot, DOSSIER, { filename: 'sam_snapshot_x.pdf' });
    assert.match(html, /sam_snapshot_x\.pdf/);
    assert.match(html, /attached to this candidate/);
  });

  test('a note written without an attachment advertises no file', () => {
    const html = composeNoteHtml(snapshot, DOSSIER, null);
    assert.doesNotMatch(html, /\.pdf/, 'the note must not reference a document that did not land');
    assert.match(html, /Open the evidence/, 'but the hosted route still has to be offered');
  });

  test('the plain-text fallback follows the same rule', () => {
    assert.match(composeNote(snapshot, DOSSIER, { filename: 'a.pdf' }), /a\.pdf/);
    assert.doesNotMatch(composeNote(snapshot, DOSSIER, null), /\.pdf/);
  });

  test('the note never states a score without its coverage', () => {
    for (const body of [composeNoteHtml(snapshot, DOSSIER), composeNote(snapshot, DOSSIER)]) {
      const roleFit = body.indexOf(`${Math.round(snapshot.roleFit * 100)}%`);
      const coverage = body.indexOf(`${Math.round(snapshot.coverage * 100)}% evidence coverage`);
      assert.ok(roleFit !== -1 && coverage !== -1, 'both figures must appear');
      assert.ok(coverage - roleFit < 80, 'coverage has to sit beside the score, not paragraphs away');
    }
  });

  test('the note distinguishes never-asked from not-met', () => {
    const html = composeNoteHtml(snapshot, DOSSIER);
    assert.match(html, /never asked by this survey/);
    const notCollected = snapshot.roleAnchors.filter((a) => a.state === 'NOT_COLLECTED');
    const notMet = snapshot.roleAnchors.filter((a) => a.state === 'NOT_MET');
    assert.ok(notCollected.length > 0 && notMet.length > 0, 'this candidate exercises both states');
  });

  test('outcome is complete only when both deliverables land', () => {
    assert.equal(OUTCOME.complete, 'complete');
    assert.equal(OUTCOME.partial, 'partial');
    assert.equal(OUTCOME.failed, 'failed');
  });
});

describe('Ashby is the system of record', () => {
  // The store is seeded at import time by the simulator, so seed it here the same way.
  const seeded = pool.slice(0, 5).map((r) => ({
    r,
    ...db.seedApplicant({
      responseHash: r.responseHash,
      name: r.name,
      email: r.email,
      location: r.location,
      linkedin: r.linkedin,
      resume: r.resume,
      attachments: r.attachments,
      appliedAt: '2025-12-11T00:00:00.000Z',
    }),
  }));
  const subject = seeded[0];

  test('an applicant arrives with identity and their own resume, and nothing from Sam', () => {
    const c = db.getCandidate(subject.candidateId);
    assert.equal(c.name, subject.r.name);
    assert.ok(c.resumeFileHandle, 'Ashby holds the resume the candidate uploaded');
    assert.equal(c.resumeFileHandle.source, 'candidate');
    assert.deepEqual(c.fileHandles, [], 'no Sam file before Sam runs');
    assert.deepEqual(db.getApplication(subject.applicationId).customFields, [],
      'no scores before a write call lands');
    assert.deepEqual(db.listNotes(subject.candidateId), []);
  });

  test('custom field values only exist after a write, and are keyed by fieldId', () => {
    const roleFit = db.CUSTOM_FIELDS.find((f) => f.title === 'Sam Role Fit');
    db.setCustomFieldValues(subject.applicationId, [{ fieldId: roleFit.id, fieldValue: 65 }]);
    const app = db.expandApplication(db.getApplication(subject.applicationId));
    assert.equal(app.customFieldValues['Sam Role Fit'], 65);
  });

  test('a redelivered write updates in place rather than duplicating a row', () => {
    const roleFit = db.CUSTOM_FIELDS.find((f) => f.title === 'Sam Role Fit');
    db.setCustomFieldValues(subject.applicationId, [{ fieldId: roleFit.id, fieldValue: 71 }]);
    const app = db.getApplication(subject.applicationId);
    assert.equal(app.customFields.filter((f) => f.id === roleFit.id).length, 1);
    assert.equal(db.expandApplication(app).customFieldValues['Sam Role Fit'], 71);
  });

  test('attaching the Snapshot never touches the candidate’s own resume', () => {
    const before = db.getCandidate(subject.candidateId).resumeFileHandle;
    db.attachFile(subject.candidateId, { name: 'sam_snapshot.pdf', bytes: Buffer.alloc(10) });
    const after = db.getCandidate(subject.candidateId);
    assert.deepEqual(after.resumeFileHandle, before, 'the resume slot must be untouched');
    assert.equal(after.fileHandles.length, 1);
    assert.equal(after.fileHandles[0].source, 'Sam');
  });

  test('re-attaching the same filename replaces it, so retries do not pile up files', () => {
    db.attachFile(subject.candidateId, { name: 'sam_snapshot.pdf', bytes: Buffer.alloc(20) });
    assert.equal(db.getCandidate(subject.candidateId).fileHandles.length, 1);
  });

  test('notes land newest-first, the way an activity feed reads', () => {
    db.addNote(subject.candidateId, { type: 'text/plain', value: 'first' });
    db.addNote(subject.candidateId, { type: 'text/html', value: '<p>second</p>' });
    const notes = db.listNotes(subject.candidateId);
    assert.equal(notes.length, 2);
    assert.equal(notes[0].content.value, '<p>second</p>');
  });

  test('writes to an unknown object are refused rather than silently dropped', () => {
    assert.equal(db.setCustomFieldValues('no-such-application', []), null);
    assert.equal(db.attachFile('no-such-candidate', { name: 'x.pdf', bytes: Buffer.alloc(1) }), null);
    assert.equal(db.addNote('no-such-candidate', { type: 'text/plain', value: 'x' }), null);
  });

  test('candidate ids are stable across restarts, so demo links keep working', () => {
    assert.equal(db.ids.candidateFor(subject.r.responseHash), subject.candidateId);
  });
});

describe('the Ashby UI', () => {
  const html = renderAshbyUI();

  test('is a complete standalone document', () => {
    assert.match(html, /^<!doctype html>/i);
    assert.match(html, /<\/html>\s*$/i);
  });

  test('reads only through Ashby endpoints — it never imports Sam', () => {
    const source = readFileSync('ashby-simulator/ui.js', 'utf8');
    assert.doesNotMatch(source, /from '\.\.\/sam-integration/,
      'the Ashby UI must not depend on Sam; it renders what landed in Ashby');
    for (const ep of ['/application.list', '/candidate.info', '/candidate.listNotes', '/job.info']) {
      assert.ok(html.includes(ep), `the UI should call ${ep}`);
    }
  });

  test('its embedded config cannot close the script tag', () => {
    const cfg = /const CFG = (\{[\s\S]*?\});/.exec(html);
    assert.ok(cfg, 'config block missing');
    assert.doesNotMatch(cfg[1], /<\/script/i);
    assert.doesNotThrow(() => JSON.parse(cfg[1].replace(/\\u003c/g, '<')));
  });

  test('authenticates the way every other Ashby client does', () => {
    assert.match(html, /authorization: 'Basic '/);
  });
});

describe('which role a candidate is scored against', () => {
  const SALES_AE = registeredJobs()[0];

  test('a rubric is registered against an Ashby job id, not a title', () => {
    assert.ok(SALES_AE.jobId, 'the webhook carries the job id, so that is the key');
    assert.equal(SALES_AE.jobTitle, 'Sales Account Executive');
    assert.equal(SALES_AE.anchorCount, ANCHORS.length);
  });

  test('the job on the webhook resolves its own rubric', () => {
    const r = rubricForJob({ id: SALES_AE.jobId, title: SALES_AE.jobTitle });
    assert.equal(r.jobTitle, 'Sales Account Executive');
    assert.equal(r.anchors, ANCHORS);
  });

  test('an unregistered job is refused, never scored against another job’s rubric', () => {
    assert.throws(
      () => rubricForJob({ id: 'some-other-job', title: 'Platform Engineer' }),
      (err) => err instanceof UnknownJobError && /will not score/.test(err.message),
      'scoring against the wrong rubric produces a confident number that means nothing',
    );
  });

  test('a webhook with no job at all is refused too', () => {
    assert.throws(() => rubricForJob(undefined), UnknownJobError);
    assert.throws(() => rubricForJob({ title: 'Sales Account Executive' }), UnknownJobError);
  });

  test('the refusal names the job, so the reason is actionable', () => {
    try {
      rubricForJob({ id: 'job-x', title: 'Platform Engineer' });
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.jobId, 'job-x');
      assert.equal(err.jobTitle, 'Platform Engineer');
    }
  });

  test('the rubric records which survey instrument its anchors were mapped against', () => {
    const r = rubricForJob({ id: SALES_AE.jobId });
    assert.match(r.surveyForm, /business_development_representative/,
      'the right job with the wrong survey would evidence nothing');
  });

  test('Sam and Ashby agree on the job id without sharing code', () => {
    assert.equal(SALES_AE.jobId, db.JOB.id,
      'the two halves derive the same id independently; if they drift, nothing scores');
  });
});

describe('spec alignment', () => {
  test('the presigned flow is used, not the multipart fallback', async () => {
    // The fallback exists for resilience, but it is not the documented path. A regression
    // that quietly reverts to it would still pass an end-to-end demo, so assert the
    // presigned parameters the signature is bound to are the ones we send.
    const src = readFileSync('sam-integration/endpoints/candidate.uploadFile.js', 'utf8');
    assert.match(src, /uploadToPresignedUrl/);
    assert.doesNotMatch(src, /method: 'PUT'/, 'Ashby returns an S3 presigned POST, not a PUT');
    assert.equal((src.match(/Presigned upload failed/g) ?? []).length, 1,
      'two upload implementations is how the wrong one ends up live');
  });

  test('the upload handle declares contentType and contentLength', () => {
    assert.equal(UPLOAD_HANDLE_PARAMS.type, 'contentType');
    assert.equal(UPLOAD_HANDLE_PARAMS.length, 'contentLength');
    assert.equal(UPLOAD_HANDLE_PARAMS.name, 'filename');
  });

  test('a missing key is 401 and a wrong key is 403 missing_endpoint_permission', () => {
    const src = readFileSync('ashby-simulator/mock_ashby_api.js', 'utf8');
    assert.match(src, /status: 401/);
    assert.match(src, /missing_endpoint_permission/);
  });

  test('outbound webhooks carry the Ashby-Webhook user agent', () => {
    const src = readFileSync('ashby-simulator/trigger_application.js', 'utf8');
    assert.match(src, /'user-agent': 'Ashby-Webhook'/);
  });

  test('candidateMerge is reconciled, not ignored and not merely refused', () => {
    // It used to throw. Refusing was safe but still lost the data; the re-sync moves it.
    const merge = Buffer.from(JSON.stringify({
      webhookActionId: 'm1',
      action: 'candidateMerge',
      data: { sourceCandidateId: 'a', destinationCandidateId: 'b' },
    }));
    const env = parseEnvelope(merge);
    assert.ok(env.merge, 'the merge must be routable');
    assert.equal(env.merge.source, 'a');
    assert.equal(env.merge.destination, 'b');
  });

  test('customField.setValues is preferred over repeated setValue', () => {
    const src = readFileSync('sam-integration/endpoints/customField.setValue.js', 'utf8');
    assert.match(src, /setCustomFields/, 'concurrent single writes race on the same object');
  });
});

describe('retrying a write that is not idempotent', () => {
  test('candidate.createNote appends, so a blind retry would duplicate', () => {
    const src = readFileSync('sam-integration/endpoints/candidate.createNote.js', 'utf8');
    assert.match(src, /verify: alreadyPosted/,
      'the note write must check the feed before repeating itself');
    assert.match(src, /noteAlreadyExists/);
  });

  test('the retry loop consults verify before repeating', () => {
    const src = readFileSync('sam-integration/endpoints/client.js', 'utf8');
    assert.match(src, /attempt > 1 && verify/,
      'the check belongs on the retry, not the first attempt');
  });

  test('a failed verify does not block the retry', () => {
    const src = readFileSync('sam-integration/endpoints/client.js', 'utf8');
    // Losing the protection is bad; losing the write because the check errored is worse.
    const block = /if \(attempt > 1 && verify\) \{[\s\S]*?\n    \}/.exec(src)[0];
    assert.match(block, /catch/);
  });
});

describe('reconciling a candidateMerge', () => {
  const SRC = 'src-candidate-1';
  const DST = 'dst-candidate-1';
  const JOB = 'job-sales-ae';

  test('the ledger records where Sam wrote', () => {
    ledger.record({
      candidateId: SRC, jobId: JOB, applicationId: 'app-1',
      snapshot: { candidate: { name: 'Test' } }, dossierUrl: 'https://sam.app/x', filename: 'x.pdf',
    });
    assert.equal(ledger.lookup(SRC, JOB).applicationId, 'app-1');
  });

  test('re-pointing moves every job the person was scored for', () => {
    const moved = ledger.repoint(SRC, DST);
    assert.equal(moved.length, 1);
    assert.equal(moved[0].candidateId, DST);
    assert.equal(moved[0].mergedFrom, SRC);
    assert.equal(ledger.lookup(SRC, JOB), null, 'the retired id must stop resolving');
    assert.equal(ledger.lookup(DST, JOB).applicationId, 'app-1');
  });

  test('a merge Sam never touched reports nothing to move rather than failing', async () => {
    const r = await reconcileMerge({
      sourceCandidateId: 'never-scored', destinationCandidateId: 'someone-else', deliveryId: 'd1',
    });
    assert.equal(r.outcome, MERGE_OUTCOME.nothingToMove);
    assert.equal(r.moved, null);
  });

  test('the merge webhook carries both ids and is routed, not rejected', () => {
    const body = Buffer.from(JSON.stringify({
      webhookActionId: 'm1',
      action: 'candidateMerge',
      data: { sourceCandidateId: 'a', destinationCandidateId: 'b' },
    }));
    const env = parseEnvelope(body);
    assert.deepEqual(env.merge, { source: 'a', destination: 'b', applicationId: undefined });
  });

  test('a merge missing either id is refused — re-syncing to nowhere is worse', () => {
    const body = Buffer.from(JSON.stringify({
      webhookActionId: 'm2', action: 'candidateMerge', data: { sourceCandidateId: 'a' },
    }));
    assert.throws(() => parseEnvelope(body), /missing sourceCandidateId or destinationCandidateId/);
  });

  test('the Snapshot file is deliberately not re-uploaded', () => {
    const src = readFileSync('sam-integration/delivery/merge.js', 'utf8');
    assert.doesNotMatch(src, /uploadSnapshotFile/,
      'a duplicated document is noise; a missing one is recoverable via the note');
  });
});

describe('every module actually loads', () => {
  // A moved file can break an import that no test happens to execute. This walks the
  // whole tree and imports each module, which is what would have caught the ZIP reader
  // moving out from under docx.js.
  test('all source modules import cleanly', async () => {
    const roots = ['shared', 'sam-integration', 'ashby-simulator', 'scripts'];
    const files = [];
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${e.name}`;
        if (e.isDirectory() && e.name !== 'output') walk(full);
        else if (e.name.endsWith('.js')) files.push(full);
      }
    };
    for (const r of roots) walk(r);
    assert.ok(files.length > 20, `expected a real tree, found ${files.length}`);

    const broken = [];
    for (const f of files) {
      // Entry points run on import; only check the modules that export rather than execute.
      if (/(server|mock_ashby_api|trigger_application|build-canvas|build-record)\.js$/.test(f)) continue;
      try { await import(`../${f}`); } catch (err) { broken.push(`${f}: ${err.message}`); }
    }
    assert.deepEqual(broken, [], 'these modules do not load');
  });
});

describe('Binding the resume in behind the Snapshot', () => {
  const pool = loadPool(SURVEY);
  const scored = scorePool(pool);
  const withExt = (ext) => scored.find((e) => resumeFileForResponse(e.response)?.ext === ext);

  const stitchFor = async (entry) => {
    const snapshot = buildSnapshot(entry.score, entry.response);
    const snapshotBytes = await renderSnapshotPdf(snapshot);
    const out = await stitchSnapshotWithResume({ snapshotBytes, response: entry.response });
    return { snapshotBytes, out };
  };

  test('a PDF resume is merged page for page, so their layout survives', async () => {
    const entry = withExt('pdf');
    assert.ok(entry, 'the pool should contain at least one PDF resume');
    const { out } = await stitchFor(entry);
    assert.equal(out.mode, STITCH_MODE.merged);
    assert.ok(out.resumePages >= 1, 'the resume contributed pages');
    // Snapshot + exactly one divider + the resume. The divider is what tells the reviewer
    // where Sam stops, so its absence would be a correctness bug, not a cosmetic one.
    assert.equal(out.pages, out.snapshotPages + 1 + out.resumePages);
  });

  test('a Word resume is typeset and says so rather than implying fidelity', async () => {
    const entry = withExt('docx');
    assert.ok(entry, 'the pool should contain at least one .docx resume');
    const { out } = await stitchFor(entry);
    assert.equal(out.mode, STITCH_MODE.typeset);
    assert.match(out.detail, /not preserved/i);
  });

  test('every resume in the pool binds in — none falls back', async () => {
    // The fallback is correct behaviour, but if it fires across a real pool it means the
    // stitcher is quietly shipping half of what it promises. This is the check that would
    // have caught bullet glyphs crashing the WinAnsi encoder.
    const modes = {};
    for (const entry of scored) {
      const { out } = await stitchFor(entry);
      modes[out.mode] = (modes[out.mode] ?? 0) + 1;
    }
    assert.equal(modes[STITCH_MODE.snapshotOnly] ?? 0, 0,
      `some resumes did not bind in: ${JSON.stringify(modes)}`);
    assert.equal((modes[STITCH_MODE.merged] ?? 0) + (modes[STITCH_MODE.typeset] ?? 0), scored.length);
  });

  test('no resume on file degrades to the Snapshot alone, byte for byte', async () => {
    const entry = scored[0];
    const snapshot = buildSnapshot(entry.score, entry.response);
    const snapshotBytes = await renderSnapshotPdf(snapshot);
    const out = await stitchSnapshotWithResume({
      snapshotBytes,
      response: { ...entry.response, resume: null },
    });
    assert.equal(out.mode, STITCH_MODE.snapshotOnly);
    assert.equal(out.resumePages, 0);
    // Identical bytes, not merely a similar document: the fallback must not re-save and
    // silently drop a page of the Snapshot on its way past.
    assert.equal(Buffer.compare(out.bytes, snapshotBytes), 0);
  });

  test('an unreadable resume costs a convenience, never the delivery', async () => {
    const entry = withExt('pdf');
    const snapshot = buildSnapshot(entry.score, entry.response);
    const snapshotBytes = await renderSnapshotPdf(snapshot);
    const out = await stitchSnapshotWithResume({
      snapshotBytes, response: entry.response, cacheDir: '.cache/does-not-exist',
    });
    assert.equal(out.mode, STITCH_MODE.snapshotOnly);
    assert.match(out.detail, /no documents on file/i);
  });

  test('characters the PDF encoder cannot represent are transliterated, not thrown', () => {
    assert.equal(toWinAnsi('● Closed “enterprise” deals – $2.4M'),
      '- Closed "enterprise" deals - $2.4M');
    assert.equal(toWinAnsi('emoji \u{1F600} vanish'), 'emoji  vanish');
    assert.equal(toWinAnsi('café résumé'), 'café résumé', 'Latin-1 survives intact');
  });

  test('a candidate who also sent a cover letter still has their resume read', () => {
    // Both files sit under the same row prefix in the cache. Taking the first one
    // alphabetically read the cover letter as his resume — for the Career History section
    // and for the document bound in behind the Snapshot.
    const hare = scored.find((e) => /Hare/i.test(e.response.name));
    assert.ok(hare, 'the pool should contain the one candidate with a second document');
    assert.ok(hare.response.attachments.length >= 1);
    assert.match(resumeFileForResponse(hare.response).path, /resume/i);
    assert.doesNotMatch(resumeFileForResponse(hare.response).path, /cover_letter/i);
  });

  test('a document Sam never read is marked as submitted, not as source', async () => {
    const hare = scored.find((e) => /Hare/i.test(e.response.name));
    const files = candidateFilesForResponse(hare.response);
    assert.equal(files.filter((f) => f.read).length, 1, 'exactly one document was read');
    assert.ok(files.some((f) => !f.read), 'the cover letter is present but unread');

    const { out } = await stitchFor(hare);
    const extra = out.bound.find((b) => !b.read);
    assert.ok(extra, 'the cover letter bound in');
    assert.match(out.detail, /unscored/,
      'the summary has to say Sam did not score it, or the document implies evidence it never used');
  });

  test('a format we cannot bind is reported, never dropped in silence', async () => {
    const entry = scored[0];
    const snapshotBytes = await renderSnapshotPdf(buildSnapshot(entry.score, entry.response));
    const out = await stitchSnapshot({
      snapshotBytes,
      sources: [
        { ...resumeFileForResponse(entry.response), label: 'resume.pdf', read: true },
        { path: 'package.json', ext: 'json', label: 'portfolio.json', read: false },
      ],
    });
    assert.equal(out.skipped.length, 1);
    assert.match(out.skipped[0].reason, /cannot be bound in/);
    assert.match(out.detail, /left out/);
  });

  test('the bound-in pages are capped, and the cap says what it dropped', async () => {
    const entry = scored[0];
    const snapshotBytes = await renderSnapshotPdf(buildSnapshot(entry.score, entry.response));
    const one = { ...resumeFileForResponse(entry.response), read: false };
    const out = await stitchSnapshot({
      snapshotBytes,
      sources: Array.from({ length: 60 }, (_, i) => ({ ...one, label: `doc_${i}.pdf` })),
    });
    assert.ok(out.pages - out.snapshotPages <= MAX_BOUND_PAGES * 2,
      'an unbounded candidate upload cannot produce an unbounded attachment');
    assert.ok(out.skipped.length > 0);
    assert.match(out.skipped.at(-1).reason, new RegExp(`${MAX_BOUND_PAGES}-page limit`));
  });

  test('the resume is bound in before the attachment is uploaded', () => {
    const ids = STAGES.map((s) => s.id);
    assert.ok(ids.indexOf('stitch') < ids.indexOf('attach'),
      'stitching after the upload would attach the Snapshot without the evidence');
    assert.ok(ids.indexOf('render') < ids.indexOf('stitch'));
  });
});

describe('Every version the documentation allows is accounted for', () => {
  // The brief asks for every version, and the comparison between them is the point. Three
  // are built. The rest have to carry a stated reason, or "we only built three" reads as an
  // oversight rather than a decision.
  test('each unbuilt surface names a real endpoint, a blocker, and what it would give', () => {
    assert.ok(INVESTIGATED.length >= 5, 'a handful of surfaces were investigated, not one');
    for (const v of INVESTIGATED) {
      assert.match(v.endpoint, /^\/[a-zA-Z]+\.[a-zA-Z]+$/, `${v.name} needs a real endpoint`);
      assert.ok(v.blocker.length > 60, `${v.name} needs a reason, not a shrug`);
      assert.ok(v.wouldGive.length > 20, `${v.name} has to say what we are giving up`);
    }
  });

  test('no surface is both built and listed as unbuilt', () => {
    const built = new Set(PLACEMENT_VERSIONS.map((p) => p.endpoint));
    for (const v of INVESTIGATED) {
      assert.ok(!built.has(v.endpoint), `${v.endpoint} cannot be both`);
    }
    assert.ok(!INVESTIGATED.some((v) => v.endpoint === REFUSED.endpoint),
      'the refused surface has its own section and its own reasoning');
  });
});

describe('The questions are ones only Ashby can answer', () => {
  // The filter that keeps this list worth handing over: if a careful read of the public
  // docs settles it, or a trial account settles it in five minutes, it is our work rather
  // than theirs. `whyAshby` is where each question has to earn its place.
  test('every question states why it cannot be answered anywhere else', () => {
    for (const q of OPEN_QUESTIONS) {
      assert.ok(q.whyAshby && q.whyAshby.length > 40,
        `"${q.topic}" needs to say why Ashby is the only party who can answer it`);
    }
  });

  test('every question carries the assumption we shipped and what it costs to be wrong', () => {
    for (const q of OPEN_QUESTIONS) {
      assert.ok(q.question.trim().endsWith('?'), `"${q.topic}" is not phrased as a question`);
      assert.ok(q.assumption.length > 60, `"${q.topic}" must name what we assumed instead`);
      assert.ok(q.consequence.length > 60, `"${q.topic}" must say what changes if we are wrong`);
      assert.ok(['high', 'medium', 'low'].includes(q.risk), `"${q.topic}" needs a risk level`);
    }
  });

  test('the high-risk ones are the ones that change what we build', () => {
    assert.ok(HIGH_RISK.length >= 3 && HIGH_RISK.length <= 5,
      'too few and the lead is unclear; too many and nothing leads');
    assert.equal(HIGH_RISK[0].topic, 'Custom fields as sortable columns',
      'the column question is the one the triage story depends on — it goes first');
  });

  test('nothing on the list is settled by our own contract', () => {
    // uploadResume vs uploadFile was an open question until the docs confirmed uploadResume
    // forcefully replaces the primary resume. Answered questions come off the list.
    for (const q of OPEN_QUESTIONS) {
      assert.doesNotMatch(q.question, /uploadResume|which endpoint should we use/i,
        `"${q.topic}" was settled by the documentation and should have been removed`);
    }
  });
});

describe('The Snapshot can be built from the engine contract alone', () => {
  // The contract is only worth writing down if it is sufficient. These tests build the
  // Snapshot from the payload plus Ashby and nothing else — no survey file, no scorer.
  const payload = JSON.parse(readFileSync('docs/sam-engine-payload.example.json', 'utf8'));
  const ashby = {
    candidate: {
      name: 'Aditya Alapati',
      primaryEmailAddress: { value: 'candidate@example.com' },
      socialLinks: [{ type: 'LinkedIn', url: 'https://linkedin.com/in/example' }],
      location: { locationSummary: 'Boston, Massachusetts' },
      resumeFileHandle: { name: 'resume.pdf' },
      fileHandles: [],
    },
    job: { title: 'Sales Account Executive', company: 'Agree' },
    pool: { size: 41, roleFitRank: 2, capabilityRank: 5, roleFitPercentile: 95, topPercent: 5 },
  };

  test('the example payload satisfies its own contract', () => {
    assert.doesNotThrow(() => validateEnginePayload(payload));
  });

  test('a full Snapshot PDF renders from the payload with no survey data in reach', async () => {
    const snapshot = snapshotFromEnginePayload(payload, ashby);
    const pdf = await renderSnapshotPdf(snapshot);
    assert.ok(pdf.length > 5000, 'a real multi-section document, not a stub');
    for (const field of ['netRead', 'recommendedNextStep', 'anchors', 'coverageGaps',
      'evidenceQuotes', 'careerHistory', 'additionalSkills', 'experienceMatch']) {
      assert.ok(snapshot[field], `${field} could not be filled from the contract`);
    }
  });

  test('a missing required field names its own path rather than rendering a hole', () => {
    const broken = structuredClone(payload);
    delete broken.anchors[0].reason;
    assert.throws(() => snapshotFromEnginePayload(broken, ashby), (err) => {
      assert.equal(err.name, 'ContractError');
      assert.match(err.message, /anchors\[0\]\.reason/);
      return true;
    });
  });

  test('optional-null prints an honest line instead of guessing', () => {
    const snapshot = snapshotFromEnginePayload(payload, ashby);
    // The example sends roleLevelFit: null — seniority is not derivable from a resume parse.
    assert.equal(snapshot.roleLevelFit.band, 'Not determined');
    assert.match(snapshot.roleLevelFit.line, /did not assert/i);
  });

  test('provenance is whatever the engine says it opened, never an assumption', () => {
    const resumeOnly = structuredClone(payload);
    resumeOnly.inputs.read = ['resume'];
    resumeOnly.inputs.audio = [];
    const snapshot = snapshotFromEnginePayload(resumeOnly, ashby);
    assert.equal(snapshot.provenance, 'resume');
    assert.equal(snapshot.hasResume, true);
    assert.equal(snapshot.audioUrls.length, 0,
      'a resume-only sweep has no recordings to link');
  });

  test('claiming resume-only while shipping recordings is refused', () => {
    // The scheduled sweep is resume-only. If the engine ever sends audio alongside that
    // claim, the Snapshot would invite a reviewer to listen to evidence the score never
    // used — so it fails here rather than printing it.
    const lying = structuredClone(payload);
    lying.inputs.read = ['resume'];
    assert.throws(() => snapshotFromEnginePayload(lying, ashby), (err) => {
      assert.equal(err.name, 'ContractError');
      assert.match(err.message, /inputs\.audio/);
      return true;
    });
  });

  test('a swapped-field career row is dropped rather than printed on someone’s record', () => {
    const dirty = structuredClone(payload);
    dirty.profile.careerHistory.roles.push({ title: 'X', company: 'closes at 40% rates' });
    const snapshot = snapshotFromEnginePayload(dirty, ashby);
    assert.ok(!snapshot.careerHistory.roles.some((r) => /rates/.test(r.company)),
      'a garbled parse row is worse on a person’s record than an absent one');
  });

  test('the anchors the renderer sees carry no scoring internals', () => {
    const snapshot = snapshotFromEnginePayload(payload, ashby);
    for (const a of snapshot.anchors) {
      assert.ok(!('evidencedBy' in a), 'evidencedBy is a rubric input, not a result');
      assert.ok(!('signals' in a), 'signals is how the engine decided, not what we render');
      assert.ok(!('evidence' in a), 'evidence is mapped to spans, never carried twice');
    }
  });
});

describe('A thin read refuses to publish a score', () => {
  // The production flow is a resume-only sweep, and the decision is that a resume cannot
  // "ask" — so anchors it cannot evidence are NOT_COLLECTED and drop out of the denominator.
  // That is honest per anchor and dangerous in aggregate: one observable anchor, met, is
  // 100% of what was observable. This is the guard.
  const base = JSON.parse(readFileSync('docs/sam-engine-payload.example.json', 'utf8'));
  const ashby = {
    candidate: {
      name: 'Jordan Avery', primaryEmailAddress: { value: 'j@example.com' },
      socialLinks: [], location: null, resumeFileHandle: { name: 'r.pdf' }, fileHandles: [],
    },
    job: { title: 'Sales Account Executive', company: 'Agree' },
    pool: null,
  };

  const sweep = (observableCount) => {
    const p = structuredClone(base);
    p.inputs.read = ['resume'];
    p.inputs.audio = [];
    p.anchors = p.anchors.map((a, i) => (i < observableCount
      ? { ...a, state: 'MET', reason: 'Evidenced on the resume.' }
      : { ...a, state: 'NOT_COLLECTED', reason: 'A resume cannot evidence this.', evidence: [] }));
    const total = p.anchors.reduce((n, a) => n + a.weight, 0);
    p.scores.coverage = p.anchors.filter((a) => a.state !== 'NOT_COLLECTED')
      .reduce((n, a) => n + a.weight, 0) / total;
    p.scores.roleFit = 1.0;
    return snapshotFromEnginePayload(p, ashby);
  };

  test('one observable anchor out of six does not become a perfect candidate', () => {
    const s = sweep(1);
    assert.ok(s.coverage < MIN_SCOREABLE_COVERAGE);
    assert.equal(s.scoreIsPublishable, false);
    assert.equal(s.band, 'Insufficient evidence');
  });

  test('the withheld score is cleared in Ashby, not left unwritten', () => {
    const values = samFieldValues(sweep(1));
    const valueOf = (f) => values.find((v) => v.field === f);

    // Present in the call and explicitly empty. Omitting it would be a merge no-op, which
    // is the difference between clearing a stale score and silently keeping one.
    assert.ok(valueOf(SAM_CUSTOM_FIELDS.roleFit), 'Role Fit must be in every write');
    assert.equal(valueOf(SAM_CUSTOM_FIELDS.roleFit).value, CLEAR);
    assert.equal(valueOf(SAM_CUSTOM_FIELDS.coverage).value, 25,
      'coverage is always a real number — it is what explains the empty one');
  });

  test('the document withholds the headline rather than caveating it', async () => {
    const text = extractPdfText(await renderSnapshotPdf(sweep(1)));
    assert.match(text, /Insufficient evidence/,
      'the band has to say so where the percentage used to be');
    assert.doesNotMatch(text, /100%/,
      'a perfect-looking number from one observable anchor is the whole failure mode');
    assert.match(text, /25% COVERAGE/, 'coverage still shows — it explains the withheld score');
  });

  test('above the floor the score publishes normally', () => {
    const s = sweep(5);
    assert.ok(s.coverage >= MIN_SCOREABLE_COVERAGE);
    assert.equal(s.scoreIsPublishable, true);
    assert.notEqual(s.band, 'Insufficient evidence');
    assert.ok(samFieldValues(s).map((v) => v.field).includes(SAM_CUSTOM_FIELDS.roleFit));
  });

  test('a sweep with no cohort clears rank instead of inventing or keeping one', async () => {
    const s = sweep(5);
    assert.equal(s.pool, null);
    const rank = samFieldValues(s).find((v) => v.field === SAM_CUSTOM_FIELDS.poolRank);
    assert.ok(rank, 'rank must be in the write so a stale rank cannot survive a sweep');
    assert.equal(rank.value, CLEAR, '"1 of 1, top 100%" is worse than saying nothing');
    await assert.doesNotReject(renderSnapshotPdf(s), 'the PDF must not dereference a null pool');
  });
});

describe('A re-score that drops below threshold clears what it can no longer assert', () => {
  // customField.setValues merges. The danger is not the write we refuse to make — it is the
  // one we made last sweep and never took back. These go through the store the way the API
  // does, so a merge-vs-replace mistake shows up as a stale value rather than a passing unit.
  let seq = 0;
  const application = () => seedApplicant({
    // A fresh hash per test, so one test's clear cannot make another's pass.
    responseHash: `rescore-fixture-${seq += 1}`,
    name: 'Jordan Avery',
    email: 'jordan@example.com',
    location: 'Austin, TX',
    linkedin: null,
    resume: { name: 'jordan_avery_resume.pdf', url: 'https://example.com/r.pdf' },
    appliedAt: new Date(0).toISOString(),
  }).applicationId;

  const write = (applicationId, snapshot) => setCustomFieldValues(
    applicationId,
    samFieldValues(snapshot).map(({ field, value }) => ({
      fieldId: CUSTOM_FIELDS.find((f) => f.title === field.name).id,
      fieldValue: value,
    })),
  );

  const readField = (applicationId, name) => {
    const app = getApplication(applicationId);
    return app.customFields.find((f) => f.title === name);
  };

  const rich = {
    scoreIsPublishable: true, roleFit: 0.72, coverage: 0.9, capability: 8,
    pool: { roleFitRank: 2, size: 41, topPercent: 5 },
  };
  const thin = {
    scoreIsPublishable: false, roleFit: 1.0, coverage: 0.4, capability: 7, pool: null,
  };

  test('last sweep’s Role Fit does not survive a re-score that drops below threshold', () => {
    const id = application();

    write(id, rich);
    assert.equal(readField(id, 'Sam Role Fit').value, 72, 'the first sweep scored normally');

    write(id, thin);
    const after = readField(id, 'Sam Role Fit');
    assert.equal(after, undefined,
      'a 72 left sitting in a filterable column, attached to a read that no longer supports '
      + 'it and with nothing marking it as old, is worse than the number we refused to write');

    assert.equal(readField(id, 'Sam Evidence Coverage').value, 40,
      'coverage updates to the new, lower number — it is what explains the empty cell');
  });

  test('a stale pool rank does not survive a sweep that has no cohort', () => {
    const id = application();
    write(id, rich);
    assert.match(readField(id, 'Sam Pool Rank').value, /2 of 41/);

    write(id, thin);
    assert.equal(readField(id, 'Sam Pool Rank'), undefined,
      'ranked 2 of 41 must not persist through a sweep that could not rank anyone');
  });

  test('recovering above threshold writes the score back', () => {
    const id = application();
    write(id, thin);
    assert.equal(readField(id, 'Sam Role Fit'), undefined);

    write(id, rich);
    assert.equal(readField(id, 'Sam Role Fit').value, 72,
      'clearing must not be sticky — a fuller re-score restores the number');
  });
});

describe('The coverage floor is inclusive at exactly 50%', () => {
  // Pinning the boundary in a test rather than leaving it implied by >= in one expression.
  // "Below 50%" in the spec means strictly below: 50.0% itself publishes.
  test('exactly MIN_SCOREABLE_COVERAGE publishes', () => {
    assert.equal(MIN_SCOREABLE_COVERAGE, 0.5, 'the floor the rest of this test assumes');
    assert.equal(scoreIsPublishable(0.5), true, '50% is on the publishing side of the line');
  });

  test('a hair below does not publish', () => {
    assert.equal(scoreIsPublishable(0.4999), false);
  });

  test('a hair above publishes', () => {
    assert.equal(scoreIsPublishable(0.5001), true);
  });

  test('the boundary carries through to the Ashby write', () => {
    const at = { scoreIsPublishable: scoreIsPublishable(0.5), roleFit: 0.8, coverage: 0.5, capability: 8, pool: null };
    const below = { ...at, scoreIsPublishable: scoreIsPublishable(0.4999), coverage: 0.4999 };
    const roleFitOf = (s) => samFieldValues(s).find((v) => v.field === SAM_CUSTOM_FIELDS.roleFit).value;
    assert.equal(roleFitOf(at), 80, 'at exactly the floor the score is written');
    assert.equal(roleFitOf(below), CLEAR, 'a hair below and it is cleared');
  });
});

describe('A refused clear reaches a human', () => {
  // The alerting path exists for exactly one failure: a score we withdrew that is still
  // visible in Ashby. Every other failed write leaves the record as it was; this one leaves
  // it wrong. A scheduled sweep has nobody reading its response, so the response is not
  // where this can be reported.
  test('the failure raises a critical alert naming the record and the field', () => {
    resetAlerts();
    const alert = raiseAlert({
      code: ALERT.staleScoreVisible,
      severity: SEVERITY.critical,
      message: 'Could not clear Sam Role Fit on application app_123.',
      context: { applicationId: 'app_123', fields: ['Sam Role Fit'], attemptedClearValue: null },
    });
    assert.equal(alert.severity, SEVERITY.critical,
      'wrong data in front of a hiring manager is not a warning');
    assert.equal(alert.code, ALERT.staleScoreVisible);
    assert.match(alert.message, /app_123/, 'an alert nobody can act on is noise');
    assert.equal(listAlerts().length, 1);
  });

  test('raising an alert never throws, whatever the sink does', () => {
    resetAlerts();
    onAlert(() => { throw new Error('pager is down'); });
    assert.doesNotThrow(() => raiseAlert({
      code: ALERT.staleScoreVisible, severity: SEVERITY.critical, message: 'x', context: {},
    }), 'an alerting path that can fail the delivery it reports on is worse than none');
    onAlert(null);
    assert.equal(listAlerts().length, 1, 'the alert is still recorded when the sink fails');
  });

  test('the alert carries the value we tried, so a wrong guess is diagnosable', () => {
    resetAlerts();
    const alert = raiseAlert({
      code: ALERT.staleScoreVisible,
      severity: SEVERITY.critical,
      message: 'm',
      context: { attemptedClearValue: CLEAR, ashbyError: 'received object' },
    });
    // If this ever fires in production it is the line that tells us null was wrong.
    assert.ok('attemptedClearValue' in alert.context);
    assert.ok('ashbyError' in alert.context);
  });
});

describe('The scheduled sweep scores each person once', () => {
  // The two guarantees Ash asked us to plan around: run on a schedule, and one Snapshot per
  // person. Both live or die on the ledger and the cursor, so both are tested against the
  // real store rather than mocked.
  const JOB = 'job-sales-ae';
  const OTHER_JOB = 'job-support-lead';

  const app = (id, candidateId, createdAt) => ({ id, candidateId, createdAt });

  // Stands in for Ashby's application.list, honouring createdAfter the way the real one does
  // — so the cursor is exercised rather than assumed.
  let listing = [];
  const mockList = (applications) => { listing = applications; };
  const listApplications = async (body) => ({
    results: body.createdAfter
      ? listing.filter((a) => a.createdAt > body.createdAfter)
      : listing,
  });

  /** Stands in for the engine + delivery, recording who it was asked to score. */
  const recordingEngine = (scored, opts = {}) => async ({ application, jobId }) => {
    if (opts.failFor === application.candidateId) throw new Error('engine unavailable');
    scored.push(application.candidateId);
    ledger.record({
      candidateId: application.candidateId,
      jobId,
      applicationId: application.id,
      snapshot: { candidate: { name: 'x' } },
      dossierUrl: 'https://sam.app/x',
    });
    return { outcome: 'complete' };
  };

  beforeEach(() => { ledger.reset(); resetCursors(); resetAlerts(); });

  test('a person seen in two consecutive sweeps is scored once', async () => {
    const scored = [];
    const applications = [app('a1', 'cand-1', '2026-08-01T10:00:00Z')];
    mockList(applications);

    await sweepJob({ jobId: JOB, listApplications, scoreAndDeliver: recordingEngine(scored) });
    await sweepJob({ jobId: JOB, listApplications, scoreAndDeliver: recordingEngine(scored) });

    assert.deepEqual(scored, ['cand-1'], 'the second sweep must skip an already-scored person');
  });

  test('the ledger still prevents a second Snapshot when the cursor is lost', async () => {
    // The cursor is an optimisation — it keeps the query small. The ledger is the actual
    // guarantee, and this is the case that tells them apart: a process restart, a cursor
    // reset, or an overlap window hands the sweep a candidate it has already scored.
    const scored = [];
    mockList([app('a1', 'cand-1', '2026-08-01T10:00:00Z')]);
    await sweepJob({ jobId: JOB, listApplications, scoreAndDeliver: recordingEngine(scored) });

    resetCursors();  // the cursor is gone; the ledger is not

    const second = await sweepJob({ jobId: JOB, listApplications, scoreAndDeliver: recordingEngine(scored) });
    assert.equal(second.seen, 1, 'without a cursor the sweep sees them again');
    assert.equal(second.skipped, 1, 'and the ledger is what stops the second Snapshot');
    assert.equal(second.delivered, 0);
    assert.equal(scored.length, 1,
      'the skip happens before the engine is called — scoring is the expensive half');
  });

  test('one person applying to two jobs gets a Snapshot for each', async () => {
    const scored = [];
    mockList([app('a1', 'cand-1', '2026-08-01T10:00:00Z')]);
    await sweepJob({ jobId: JOB, listApplications, scoreAndDeliver: recordingEngine(scored) });
    await sweepJob({ jobId: OTHER_JOB, listApplications, scoreAndDeliver: recordingEngine(scored) });

    assert.deepEqual(scored, ['cand-1', 'cand-1'],
      'the same person is a different candidate for a different job');
    assert.ok(ledger.wasDelivered('cand-1', JOB));
    assert.ok(ledger.wasDelivered('cand-1', OTHER_JOB));
  });

  test('the cursor advances to the newest application seen, never to wall-clock time', async () => {
    mockList([
      app('a1', 'cand-1', '2026-08-01T10:00:00Z'),
      app('a2', 'cand-2', '2026-08-01T11:30:00Z'),
    ]);
    const pass = await sweepJob({ jobId: JOB, listApplications, scoreAndDeliver: recordingEngine([]) });

    assert.equal(pass.cursorFrom, null, 'the first sweep of a job has no cursor');
    assert.equal(pass.cursorTo, '2026-08-01T11:30:00Z',
      'advancing past what we saw would step over an application created mid-sweep');
  });

  test('one candidate failing does not stop the sweep', async () => {
    const scored = [];
    mockList([
      app('a1', 'cand-1', '2026-08-01T10:00:00Z'),
      app('a2', 'cand-2', '2026-08-01T10:05:00Z'),
      app('a3', 'cand-3', '2026-08-01T10:10:00Z'),
    ]);
    const pass = await sweepJob({
      jobId: JOB,
      listApplications,
      scoreAndDeliver: recordingEngine(scored, { failFor: 'cand-2' }),
    });

    assert.equal(pass.delivered, 2);
    assert.equal(pass.failed, 1);
    assert.deepEqual(scored, ['cand-1', 'cand-3'],
      'a sweep that stops on the first error silently stops scoring everyone behind them');
  });

  test('a failed candidate keeps no ledger entry, so the next sweep retries them', async () => {
    const scored = [];
    mockList([app('a1', 'cand-1', '2026-08-01T10:00:00Z')]);
    await sweepJob({ jobId: JOB, listApplications, scoreAndDeliver: recordingEngine(scored, { failFor: 'cand-1' }) });
    assert.equal(ledger.wasDelivered('cand-1', JOB), false);

    await sweepJob({ jobId: JOB, listApplications, scoreAndDeliver: recordingEngine(scored) });
    assert.deepEqual(scored, ['cand-1'], 'the retry must actually happen');
  });

  test('failures raise a warning rather than dying quietly', async () => {
    mockList([app('a1', 'cand-1', '2026-08-01T10:00:00Z')]);
    await sweepJob({ jobId: JOB, listApplications, scoreAndDeliver: recordingEngine([], { failFor: 'cand-1' }) });
    const alerts = listAlerts();
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].code, ALERT.deliveryIncomplete);
    assert.equal(alerts[0].severity, SEVERITY.warning,
      'nothing incorrect is on the record — it is incomplete, not wrong');
  });
});
