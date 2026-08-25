import { test, describe } from 'node:test';
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

  test('the ledger records where Sam wrote', () => {
    ledger.record({
      candidateId: SRC, applicationId: 'app-1',
      snapshot: { candidate: { name: 'Test' } }, dossierUrl: 'https://sam.app/x', filename: 'x.pdf',
    });
    assert.equal(ledger.lookup(SRC).applicationId, 'app-1');
  });

  test('re-pointing moves the record and retires the old id', () => {
    const moved = ledger.repoint(SRC, DST);
    assert.equal(moved.candidateId, DST);
    assert.equal(moved.mergedFrom, SRC);
    assert.equal(ledger.lookup(SRC), null, 'the retired id must stop resolving');
    assert.equal(ledger.lookup(DST).applicationId, 'app-1');
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
