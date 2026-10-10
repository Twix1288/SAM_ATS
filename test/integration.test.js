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
import { composeNoteHtml, composeNote, ASK_LIMIT, noteFingerprint } from '../sam-integration/endpoints/candidate.createNote.js';
import { openQuestionsFor, questionIdFor, askOf, impactOf } from '../sam-integration/delivery/openQuestions.js';
import { collectReplies, REPLY } from '../sam-integration/delivery/collectReplies.js';
import {
  recordAsked, recordAnswer, unansweredFrom, resolvePositions, resetConversations,
  wasAcknowledged, recordAcknowledged,
} from '../sam-integration/delivery/conversation.js';
import { policyConditions, snapshotFilename } from '../sam-integration/endpoints/candidate.uploadFile.js';
import { post, postAll } from '../sam-integration/endpoints/client.js';
import { claim, release } from '../sam-integration/delivery/ledger.js';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { syncEnrolmentFromAshby, isEnrolled } from '../sam-integration/services/jobDescriptions.js';
import { BAND_TAGS, bandTagFor, isUnrecognisedVerdict } from '../sam-integration/endpoints/candidate.addTag.js';
import { refFor, readReply, parseAnswer, composeAcknowledgementHtml, composeFollowUpHtml } from '../sam-integration/delivery/followUp.js';
import { fetchSnapshotPdf } from '../sam-integration/sam/client.js';
import { snapshotFromSamPayload } from '../sam-integration/ingest/samPayload.js';
import SAM_EXAMPLE from '../docs/sam-snapshot-payload-example.json' with { type: 'json' };
const SAM_ASHBY = { candidate: { id: 'c1', name: 'Jane Doe (Ashby)', primaryEmailAddress: { value: 'ashby@example.com' }, socialLinks: [], fileHandles: [], resumeFileHandle: { name: 'r.pdf' } }, job: { title: 'Head of Operations' }, applicationId: 'a1' };
import { cohortFor, jobSummary } from '../sam-integration/delivery/cohort.js';
import { fetchFile, fetchCandidateDocuments } from '../sam-integration/ingest/ashbyFile.js';
import { fetchJobDescription, pullJobDescription, pullJobDescriptions, storedJobs, resetJobDescriptions, jobOfApplication, descriptionTextOf, requireGradableJob, enrolJob, resetEnrolment, rememberJobDescription } from '../sam-integration/services/jobDescriptions.js';
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
import { sweep, gate, OUTCOME as SWEEP_OUTCOME } from '../sam-integration/delivery/sweep.js';
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
    assert.match(html, /Full report:/);
  });

  test('a note written without an attachment advertises no file', () => {
    const html = composeNoteHtml(snapshot, DOSSIER, null);

    // This used to assert the note contained no ".pdf" at all. That was a proxy for the
    // real rule and it stopped working once the note started naming the résumé its career
    // history was read from — a document the CANDIDATE uploaded, which does exist, and
    // whose filename is useful provenance.
    //
    // The property that actually matters is narrower: never advertise a SAM-PRODUCED
    // attachment that did not land, because a reviewer who clicks it finds nothing.
    assert.doesNotMatch(html, /Full report:/i,
      'the note must not name a report that did not land');
    assert.doesNotMatch(html, /sam_snapshot[^<\s]*\.pdf/i,
      'nor name a Sam-generated file');

    assert.match(html, /Open on Sam/,
      'but the route back to the grading still has to be offered');
  });

  test('no Sam link means no link, never a broken one', () => {
    // A 404 on a hiring manager's screen is a public claim that there is more to see. The
    // reviewer who clicks it concludes the document is stale, which costs more than the
    // link was ever worth — so a missing URL renders nothing at all.
    const html = composeNoteHtml(snapshot, null, null);
    assert.doesNotMatch(html, /href="null"|href="undefined"|Open on Sam/,
      'a missing grading URL must produce no link element whatsoever');
  });

  test('a note WITH an attachment names it', () => {
    const html = composeNoteHtml(snapshot, DOSSIER, { filename: 'sam_snapshot_x.pdf' });
    assert.match(html, /sam_snapshot_x\.pdf/);
    assert.match(html, /Full report:/i);
  });

  test('the plain-text fallback follows the same rule', () => {
    assert.match(composeNote(snapshot, DOSSIER, { filename: 'a.pdf' }), /a\.pdf/);
    assert.doesNotMatch(composeNote(snapshot, DOSSIER, null), /\.pdf/);
  });

  test('the note never states a score without its coverage', () => {
    // The rule, not the wording: wherever a match percentage appears, the share of the role
    // it was drawn from appears right next to it. In the scorecard they are adjacent rows;
    // in the plain-text fallback they are one line. Both are checked.
    const fit = `${Math.round(snapshot.roleFit * 100)}%`;
    const cov = `${Math.round(snapshot.coverage * 100)}%`;

    const html = composeNoteHtml(snapshot, DOSSIER);
    assert.ok(html.includes(fit) && html.includes(cov), 'both figures must appear');
    // Labels are padded with non-breaking spaces so the columns hold, so the match has to
    // allow for one between the words.
    assert.match(html.replace(/\u00a0/g, ' '), /Evidence coverage/i,
      'and coverage must be labelled, not a bare number');
    assert.ok(Math.abs(html.indexOf(cov) - html.indexOf(fit)) < 200,
      'coverage has to sit beside the score, not sections away');

    const plain = composeNote(snapshot, DOSSIER);
    const pf = plain.indexOf(fit);
    const pc = plain.indexOf(`${cov} evidence coverage`);
    assert.ok(pf !== -1 && pc !== -1, 'both figures must appear in the plain-text fallback too');
    assert.ok(pc - pf < 80, 'and sit beside each other there');
  });

  test('the note distinguishes never-asked from not-met', () => {
    // The distinction this whole product rests on. It used to be carried by a coverage-gaps
    // section the briefing no longer has, so it is now asserted where it actually lives:
    // on the anchor line itself, one state word each.
    const html = composeNoteHtml(snapshot, DOSSIER);
    const notCollected = snapshot.roleAnchors.filter((a) => a.state === 'NOT_COLLECTED');
    const notMet = snapshot.roleAnchors.filter((a) => a.state === 'NOT_MET');
    assert.ok(notCollected.length > 0 && notMet.length > 0, 'this candidate exercises both states');

    const items = [...html.matchAll(/<li>(.*?)<\/li>/gs)].map((m) => m[1]);
    for (const a of notCollected) {
      const item = items.find((i) => i.includes(a.label));
      assert.match(item, /never asked/, `"${a.label}" must read as never asked, not as a miss`);
    }
    for (const a of notMet) {
      const item = items.find((i) => i.includes(a.label));
      assert.match(item, /not met/, `"${a.label}" must read as not met`);
      assert.doesNotMatch(item, /never asked/);
    }
  });

  /**
   * The note is composed against a whitelist that was VERIFIED against a live Ashby org on
   * 2026-09-10, by posting a probe note and reading it in the product UI.
   *
   * This test exists because the previous version of the note shipped three HTML tables on
   * the strength of a documentation reading, and Ashby flattens table cells together with
   * no separator — "…named territorymetCarried a named territory…". Every test passed,
   * because the simulator's sanitiser allowed tables and no test looked at the markup.
   *
   * So this asserts the markup, not the content, and it is the only thing standing between
   * a future edit and the same silent failure.
   */
  test('the note only uses tags Ashby actually renders', () => {
    const RENDERS = new Set(['p', 'br', 'b', 'strong', 'i', 'em', 'u', 'code', 'a', 'ul', 'ol', 'li']);
    // Verified to survive as PLAIN TEXT only (no visual weight), or to be dropped outright.
    // Emitting them is not corruption, but it buys nothing, so the note should not bother.
    const POINTLESS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'hr']);
    // Flattened with NO separator between cells. Never emit.
    const CORRUPTS = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td']);

    const html = composeNoteHtml(snapshot, DOSSIER, { filename: 'x.pdf' });
    const used = [...html.matchAll(/<\/?([a-z0-9]+)/gi)].map((m) => m[1].toLowerCase());

    const corrupting = [...new Set(used.filter((t) => CORRUPTS.has(t)))];
    assert.deepEqual(corrupting, [],
      `Ashby flattens these together with no separator, making the note unreadable: ${corrupting.join(', ')}`);

    const pointless = [...new Set(used.filter((t) => POINTLESS.has(t)))];
    assert.deepEqual(pointless, [],
      `these render with no visual weight in Ashby — use <p><b> instead: ${pointless.join(', ')}`);

    const unknown = [...new Set(used.filter((t) => !RENDERS.has(t)))];
    assert.deepEqual(unknown, [],
      `not on the verified whitelist, so its rendering in Ashby is unknown: ${unknown.join(', ')}`);
  });

  test('met requirements land under STRENGTHS, unmet under WATCH', () => {
    // The scorecard splits the anchors by what a reader does with them, so the property is
    // no longer "every anchor in one list" — it is that a requirement never appears under
    // the wrong heading.
    const html = composeNoteHtml(snapshot, DOSSIER);
    const strengths = /✓ STRENGTHS<\/b><\/p><ul>(.*?)<\/ul>/s.exec(html)?.[1] ?? '';
    const watch = /△ WATCH<\/b><\/p><ul>(.*?)<\/ul>/s.exec(html)?.[1] ?? '';
    assert.ok(strengths && watch, 'both blocks should be present for this candidate');

    for (const a of snapshot.roleAnchors.filter((x) => x.state === 'MET')) {
      assert.ok(!watch.includes(a.label), `met requirement "${a.label}" must not appear under WATCH`);
    }
    for (const a of snapshot.roleAnchors.filter((x) => x.state === 'NOT_MET')) {
      assert.ok(!strengths.includes(a.label), `unmet requirement "${a.label}" must not appear under STRENGTHS`);
    }
  });

  test('the note does NOT carry what the attached Snapshot carries better', () => {
    // The note is a briefing read in a feed; the PDF is the report. Duplicating the PDF
    // here produced a five-thousand-character note, most of it below Ashby's "Show more"
    // fold — lines written for nobody.
    const html = composeNoteHtml(snapshot, DOSSIER, { filename: 'x.pdf' });

    // Scoped to the ANCHOR list. "Worth confirming" may legitimately restate a reason —
    // on the demo payload those gaps are derived from the anchors themselves — and that is
    // the one place a reason earns repeating, because it is what someone carries into a
    // screen. The anchor list itself must stay one line per requirement.
    // Reasoning is now CLAMPED rather than absent: a strength without a line saying why is
    // just an assertion. What must not happen is the note carrying it in full.
    for (const a of snapshot.roleAnchors) {
      if (!a.reason || a.reason.length < 140) continue;
      assert.ok(!html.includes(a.reason),
        `the note carries the full reasoning for "${a.label}" — that belongs in the PDF`);
    }
    assert.ok(html.length < 2200,
      `the note is ${html.length} chars; a feed briefing should stay well under the fold`);
    assert.match(html, /x\.pdf/, 'and it must name the attachment where the detail lives');
  });

  /**
   * The presigned upload returned 403 against real S3 for weeks of demo runs, silently
   * falling back to multipart. The cause: Ashby's POST policy conditions on `Content-Type`
   * but omits it from the `fields` object, and S3 requires every condition to arrive as a
   * form field. This is the parser that closes that gap.
   */
  test('policy conditions are read out of the S3 policy, ranges excluded', () => {
    const policy = Buffer.from(JSON.stringify({
      expiration: '2026-09-10T19:44:48Z',
      conditions: [
        { acl: 'private' },
        { 'Content-Type': 'application/pdf' },      // the one Ashby omits from `fields`
        ['content-length-range', 5397, 5397],       // a rule, not a form field
        { key: 'org/candidate/file.pdf' },
      ],
    })).toString('base64');

    const got = Object.fromEntries(policyConditions(policy));
    assert.equal(got['Content-Type'], 'application/pdf',
      'the condition S3 rejects the upload over must be recovered');

    // An exact key set, not a spot-check. Object.entries on the range ARRAY would yield
    // keys "0"/"1"/"2" rather than "content-length-range", so asserting that name is
    // absent passes even when the array leaks through — which it did.
    assert.deepEqual(Object.keys(got).sort(), ['Content-Type', 'acl', 'key'],
      'only exact-match object conditions are form fields; a range rule must contribute nothing');
  });

  test('an unreadable policy degrades to sending only what Ashby gave us', () => {
    // Never throw here: a parse failure must not take down an upload that might still work.
    for (const junk of [undefined, null, '', 'not-base64!!', Buffer.from('{"nope"').toString('base64')]) {
      assert.deepEqual(policyConditions(junk), [], `threw or misparsed on ${JSON.stringify(junk)}`);
    }
  });

  test('a job with no company renders no dangling separator', () => {
    const noCompany = { ...snapshot, role: { ...snapshot.role, company: null } };
    for (const body of [composeNoteHtml(noCompany, DOSSIER), composeNote(noCompany, DOSSIER)]) {
      assert.doesNotMatch(body, /Matched to [^<\n]*·\s*(<|$|\n)/,
        'a job read from Ashby often has no company — the separator must go with it');
    }
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
      // Entry points RUN on import, so importing them here would execute a live pass.
      //
      // Everything under scripts/ is a command, so the whole directory is skipped rather
      // than named file by file. The list used to be per-script, which made it a trap: a
      // new command failed this test for existing and spent the failure budget on a naming
      // convention instead of a real break. The logic those commands call lives in
      // sam-integration/ and IS imported here.
      if (f.startsWith('scripts/')) continue;
      if (/(server|mock_ashby_api|trigger_application)\.js$/.test(f)) continue;
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

  /**
   * pdf-lib's standard fonts are WinAnsi and drawText THROWS outside it, so a candidate
   * whose name is written in CJK, Cyrillic or Arabic did not get a plainer Snapshot — the
   * render threw, the delivery failed before its first Ashby write, and the sweep logged an
   * error that said nothing about a name being the cause. Any real ATS has these names.
   */
  test('a name in an unrepresentable script still produces a Snapshot', async () => {
    for (const name of ['Jim Halpert', 'José Núñez', 'Zoë Müller', '陈伟', 'Дмитрий Иванов', 'محمد علي']) {
      const s = snapshotFromEnginePayload(payload, {
        candidate: { name, primaryEmailAddress: { value: 'x@example.com' }, socialLinks: [], fileHandles: [] },
        job: { title: 'Account Executive' },
        pool: null,
      });
      const pdf = await renderSnapshotPdf(s);
      assert.ok(pdf.length > 5000, `${name} produced no document`);
    }
  });

  test('a name that sanitises to nothing falls back rather than heading a blank document', async () => {
    const s = snapshotFromEnginePayload(payload, {
      candidate: { name: '陈伟', primaryEmailAddress: { value: 'chen@example.com' }, socialLinks: [], fileHandles: [] },
      job: { title: 'Account Executive' },
      pool: null,
    });
    // renderSnapshotPdf must not mutate the caller's view model while doing this.
    const before = s.candidate.name;
    const pdf = await renderSnapshotPdf(s);
    assert.ok(pdf.length > 5000);
    assert.equal(s.candidate.name, before, 'the renderer must not mutate the snapshot it was given');
  });

  /**
   * The payload shapes that come from ANY JOB rather than the one Sales AE rubric this was
   * built against. Each of these produced either a crash or a false statement on a real
   * person's record, and none of them was caught by validateEnginePayload.
   */
  describe('a rubric that is not the Sales AE one', () => {
    const ashby = () => ({
      candidate: { name: 'Test', primaryEmailAddress: { value: 'x@y.com' }, socialLinks: [], fileHandles: [] },
      job: { title: 'Ops Manager' },
      pool: null,
    });
    const clone = () => structuredClone(payload);

    test('anchor ids that are not A1/A3 say "not determined", never "not evidenced"', () => {
      const p = clone();
      // Every anchor MET, but ids the fit-row lookup cannot find.
      p.anchors = p.anchors.map((a, i) => ({
        ...a, id: `ANCH_${i}`, state: 'MET', evidence: [{ quote: 'q', source: 'résumé · p.1' }],
      }));
      const s = snapshotFromEnginePayload(p, ashby());
      for (const row of [s.experienceMatch, s.responsibilityMatch]) {
        assert.equal(row.band, 'Not determined');
        assert.doesNotMatch(row.line, /did not evidence/i,
          'claiming the inputs showed nothing, while every anchor below is MET, is a false '
          + 'statement about the candidate — not knowing and having looked are different');
      }
    });

    test('a short job title survives the career-history filter', () => {
      const p = clone();
      p.profile.careerHistory.roles = [
        { title: 'CEO', company: 'Northwind', start: '2020', end: 'Present' },
        { title: 'VP', company: 'Latimer', start: '2016', end: '2020' },
      ];
      const s = snapshotFromEnginePayload(p, ashby());
      assert.equal(s.careerHistory.roles.length, 2,
        'an executive search would lose its entire career history to a length heuristic');
    });

    test('parser debris is still dropped', () => {
      const p = clone();
      p.profile.careerHistory.roles = [{ title: '-', company: 'Rates & Co', start: '', end: '' }];
      assert.equal(snapshotFromEnginePayload(p, ashby()).careerHistory.roles.length, 0);
    });

    test('a half-filled optional object degrades one line, it does not kill the Snapshot', async () => {
      for (const mutate of [
        (p) => { p.profile.roleLevelFit = { band: 'Strong', line: 'senior' }; },   // no suggestions
        (p) => { p.scores.capabilitySignals = { met: ['a', 'b'] }; },              // no missing
        (p) => { p.scores.capabilitySignals = { missing: ['a'] }; },               // no met
      ]) {
        const p = clone();
        mutate(p);
        const pdf = await renderSnapshotPdf(snapshotFromEnginePayload(p, ashby()));
        assert.ok(pdf.length > 5000, 'the whole delivery died over one absent array');
      }
    });
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

describe('The pass gates every row before spending anything', () => {
  const JOB = 'job-enrolled';
  const OTHER = 'job-not-enrolled';

  const app = (id, over = {}) => ({
    id: `app-${id}`,
    status: 'Active',
    candidate: { id: `cand-${id}`, name: `Candidate ${id}` },
    job: { id: JOB, title: 'Account Executive' },
    createdAt: '2026-08-22T00:00:00.000Z',
    ...over,
  });

  // Stands in for deliverSnapshot, which is what actually writes the ledger row — the pass
  // deliberately does not, because only the delivery knows which surfaces landed.
  const engine = (seen) => async ({ application, jobId }) => {
    seen.push(application.candidate.id);
    ledger.record({ candidateId: application.candidate.id, jobId, applicationId: application.id });
    return { outcome: 'complete' };
  };

  beforeEach(() => {
    ledger.reset();
    resetJobDescriptions();
    resetEnrolment();
    enrolJob(JOB);
    rememberJobDescription({ jobId: JOB, jobTitle: 'Account Executive', text: 'requirements' });
  });

  test('everyone Active on an enrolled job is graded, once', async () => {
    const seen = [];
    const list = async () => [app(1), app(2)];
    const first = await sweep({ scoreAndDeliver: engine(seen), listApplications: list });
    assert.equal(first.delivered, 2);
    assert.deepEqual(seen, ['cand-1', 'cand-2']);

    // The whole point of listing everything: the second pass sees the same rows and must
    // spend nothing on them. The ledger is what decides that, not a cursor.
    const second = await sweep({ scoreAndDeliver: engine(seen), listApplications: list });
    assert.equal(second.delivered, 0);
    assert.equal(second.alreadyDelivered, 2);
    assert.equal(seen.length, 2, 'the engine must not be called again');
  });

  test('a job nobody enrolled is refused, whatever the list returned', async () => {
    const seen = [];
    const pass = await sweep({
      scoreAndDeliver: engine(seen),
      listApplications: async () => [app(1), app(2, { job: { id: OTHER, title: 'Recruiter' } })],
    });
    assert.equal(pass.delivered, 1);
    assert.equal(pass.notEnrolled, 1);
    assert.deepEqual(seen, ['cand-1'], 'the unenrolled job must never reach the engine');
  });

  test('archived applications are skipped — the majority of a real pipeline', async () => {
    const seen = [];
    const pass = await sweep({
      scoreAndDeliver: engine(seen),
      listApplications: async () => [
        app(1),
        app(2, { status: 'Archived' }),
        app(3, { status: 'Hired' }),
      ],
    });
    assert.equal(pass.delivered, 1);
    assert.equal(pass.notActive, 2);
    assert.deepEqual(seen, ['cand-1'],
      'grading an archived candidate spends the engine and puts a Snapshot on someone already rejected');
  });

  test('ties on createdAt are irrelevant, because nothing reads createdAt', async () => {
    // 31 of 34 applications in a live org share a timestamp with another. A high-water-mark
    // cursor steps over every one of them; listing everything cannot.
    const seen = [];
    const same = '2026-08-22T00:00:00.000Z';
    const pass = await sweep({
      scoreAndDeliver: engine(seen),
      listApplications: async () => [
        app(1, { createdAt: same }), app(2, { createdAt: same }), app(3, { createdAt: same }),
      ],
    });
    assert.equal(pass.delivered, 3, 'all three tied rows must be graded');
  });

  test('one candidate failing does not end the pass, and leaves no ledger entry', async () => {
    const seen = [];
    const pass = await sweep({
      listApplications: async () => [app(1), app(2), app(3)],
      scoreAndDeliver: async ({ application }) => {
        if (application.candidate.id === 'cand-2') throw new Error('engine unavailable');
        seen.push(application.candidate.id);
        return { outcome: 'complete' };
      },
    });
    assert.equal(pass.delivered, 2);
    assert.equal(pass.failed, 1);
    assert.deepEqual(seen, ['cand-1', 'cand-3'], 'the people behind the failure must still be graded');
    assert.equal(ledger.wasDelivered('cand-2', JOB), false,
      'a failure must never read as delivered, or the next pass skips its own retry');
    assert.equal(ledger.attemptsFor('cand-2', JOB), 1,
      'but the attempt IS counted, durably, or a poison candidate costs an engine call forever');
  });

  test('a failure releases its claim, or the candidate is skipped forever', async () => {
    let calls = 0;
    const flaky = async () => { calls++; if (calls === 1) throw new Error('transient'); return { outcome: 'complete' }; };
    const list = async () => [app(1)];

    const first = await sweep({ scoreAndDeliver: flaky, listApplications: list });
    assert.equal(first.failed, 1);
    assert.equal(ledger.isClaimed('cand-1', JOB), false, 'the claim must not outlive the failure');

    const second = await sweep({ scoreAndDeliver: flaky, listApplications: list });
    assert.equal(second.delivered, 1, 'the next pass must be able to retry them');
  });

  test('a candidate who keeps failing stops costing engine calls and asks for a person', async () => {
    const seen = [];
    const always = async () => { throw new Error('unparseable résumé'); };
    const list = async () => [app(1)];

    for (let i = 0; i < ledger.MAX_ATTEMPTS; i++) {
      const p = await sweep({ scoreAndDeliver: always, listApplications: list });
      assert.equal(p.failed, 1, `attempt ${i + 1} should still be tried`);
    }

    // Past the cap the engine is never called again — but the candidate is REPORTED every
    // pass, not dropped. An invisible give-up is how somebody never gets scored and nobody
    // ever finds out.
    const after = await sweep({ scoreAndDeliver: engine(seen), listApplications: list });
    assert.equal(after.exhausted, 1);
    assert.equal(after.failed, 0);
    assert.deepEqual(seen, [], 'the engine must not be called again');
    assert.match(after.results[0].detail, /needs a look/);
  });

  test('a job description edited after grading is flagged, never silently re-graded', async () => {
    ledger.record({ candidateId: 'cand-1', jobId: JOB, applicationId: 'app-1', descriptionVersion: 'v-old' });
    rememberJobDescription({ jobId: JOB, jobTitle: 'Account Executive', text: 'REWRITTEN requirements' });

    const seen = [];
    const pass = await sweep({ scoreAndDeliver: engine(seen), listApplications: async () => [app(1)] });

    assert.equal(pass.drifted, 1, 'their published score answers requirements that no longer exist');
    assert.equal(pass.alreadyDelivered, 1);
    assert.deepEqual(seen, [], 're-grading everyone on an edit would be expensive and surprising');
  });

  test('a partially delivered candidate is resumed, not skipped and not repeated', async () => {
    // Fields landed, the note did not. If the ledger called that done, the score would sit on
    // the record with no note explaining it and nothing would ever look again.
    ledger.record({
      candidateId: 'cand-1', jobId: JOB, applicationId: 'app-1',
      surfaces: { fields: true, attachment: true, note: false },
    });
    assert.equal(ledger.wasDelivered('cand-1', JOB), false);

    const seen = [];
    const pass = await sweep({ scoreAndDeliver: engine(seen), listApplications: async () => [app(1)] });
    assert.equal(pass.resumed, 1);
    assert.deepEqual(pass.results[0].resumed, ['note'], 'and it must know which surface was missing');
  });

  test('a row with no candidate is reported, never silently dropped', async () => {
    const pass = await sweep({
      scoreAndDeliver: engine([]),
      listApplications: async () => [{ id: 'app-x', status: 'Active', job: { id: JOB } }],
    });
    assert.equal(pass.noCandidate, 1);
    assert.equal(pass.results[0].detail, 'the row names no candidate');
  });

  test('candidateId is read from the nested object, which is the only shape Ashby sends', () => {
    assert.equal(gate({ id: 'a', status: 'Active', candidate: { id: 'c' }, job: { id: JOB } }), null,
      'a row shaped exactly like Ashby\'s must pass the gate');
    assert.equal(gate({ id: 'a', status: 'Active', candidateId: 'c', job: { id: JOB } }), null,
      'and the flat shape must still work, for the simulator');
  });
});

/**
 * Connecting a candidate to the job they applied for.
 *
 * Grading someone against another job's requirements produces a confident number that is
 * entirely meaningless, and it is invisible in the UI — the score just looks wrong to
 * nobody. So every link in the chain is asserted, and the refusal is asserted hardest.
 *
 * The endpoint shapes here were verified against a live Ashby org on 2026-09-10; the fakes
 * below reproduce them exactly, including the two that fail silently in real life.
 */
describe('job description resolution', () => {
  const JOB = 'job-uuid-1';
  const POSTING = 'posting-uuid-1';

  /** A stand-in shaped like the real API, including `jobPostingId` being the only key that works. */
  const ashbyFake = ({ postingIds = [POSTING], postings = null, description = 'ABOUT THE ROLE\n\nDrive new business.' } = {}) => {
    const calls = [];
    const post = async (endpoint, body) => {
      calls.push({ endpoint, body });
      if (endpoint === ENDPOINTS.jobInfo) {
        return { id: JOB, title: 'Account Executive', jobPostingIds: postingIds };
      }
      if (endpoint === ENDPOINTS.listJobPostings) return postings ?? [];
      if (endpoint === ENDPOINTS.jobPostingInfo) {
        // The real API answers a wrong param name with success:false at HTTP 200.
        if (!body.jobPostingId) return null;
        return { id: body.jobPostingId, jobId: JOB, descriptionPlain: description };
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    };
    return { post, calls };
  };

  test('the description is fetched through jobPostingId, not id', async () => {
    const { post, calls } = ashbyFake();
    const got = await fetchJobDescription(JOB, { post, now: () => 'T' });
    assert.match(got.text, /Drive new business/);
    assert.equal(got.jobTitle, 'Account Executive');

    const infoCall = calls.find((c) => c.endpoint === ENDPOINTS.jobPostingInfo);
    assert.ok('jobPostingId' in infoCall.body,
      'jobPosting.info takes jobPostingId — sending `id` returns invalid_input at HTTP 200, '
      + 'which a status-code check reads as success');
  });

  test('a job with no posting is refused, not scored against something else', async () => {
    const { post } = ashbyFake({ postingIds: [] });
    await assert.rejects(
      () => fetchJobDescription(JOB, { post }),
      (err) => {
        assert.equal(err.name, 'NoJobDescriptionError');
        assert.match(err.why, /no posting/);
        return true;
      },
      'an unposted requisition is an ordinary state — "Head of Testing" is one in the sandbox',
    );
  });

  test('a posting with an empty description is refused too', async () => {
    const { post } = ashbyFake({ description: '   ' });
    await assert.rejects(() => fetchJobDescription(JOB, { post }), /carries no description text/);
  });

  test('several postings resolve deterministically, listed first', async () => {
    const postings = [
      { id: 'p-unlisted', jobId: JOB, isListed: false, publishedDate: '2026-01-01' },
      { id: 'p-listed-late', jobId: JOB, isListed: true, publishedDate: '2026-06-01' },
      { id: 'p-listed-early', jobId: JOB, isListed: true, publishedDate: '2026-02-01' },
    ];
    const seen = new Set();
    for (let i = 0; i < 3; i++) {
      const { post } = ashbyFake({ postingIds: postings.map((p) => p.id), postings });
      seen.add((await fetchJobDescription(JOB, { post })).postingId);
    }
    assert.deepEqual([...seen], ['p-listed-early'],
      'two sweeps of the same job must never pick different postings — a different board’s '
      + 'copy of the role is a different set of requirements');
  });

  test('the version changes when the description does, so a stale score is detectable', async () => {
    resetJobDescriptions();
    const first = await pullJobDescription(JOB, { ...ashbyFake({ description: 'original text' }), now: () => 'T1' });
    assert.equal(first.unchanged, false);

    const same = await pullJobDescription(JOB, { ...ashbyFake({ description: 'original text' }), now: () => 'T2' });
    assert.equal(same.version, first.version);
    assert.equal(same.unchanged, true);
    assert.equal(same.fetchedAt, 'T1', 'a no-op refresh must not look like a change');

    const edited = await pullJobDescription(JOB, { ...ashbyFake({ description: 'REWRITTEN' }), now: () => 'T3' });
    assert.notEqual(edited.version, first.version,
      'a description edited after someone was scored means they were graded against '
      + 'requirements that no longer exist');
    resetJobDescriptions();
  });

  test('one unpostable job does not stop the others being pulled', async () => {
    resetJobDescriptions();
    const post = async (endpoint, body) => {
      if (endpoint === ENDPOINTS.jobInfo) {
        return { id: body.id, title: body.id, jobPostingIds: body.id === 'bad' ? [] : ['p'] };
      }
      if (endpoint === ENDPOINTS.jobPostingInfo) return { id: 'p', descriptionPlain: 'text' };
      return [];
    };
    const results = await pullJobDescriptions(['good-1', 'bad', 'good-2'], { post });
    assert.deepEqual(results.map((r) => r.ok), [true, false, true]);
    assert.equal(storedJobs().length, 2);
    resetJobDescriptions();
  });

  test('the EEO boilerplate is stripped before the text reaches Sam', () => {
    // descriptionPlain is opening + body + closing concatenated, and the closing is the
    // equal-employment statement — 891 chars, byte-identical on all nine sandbox postings.
    // A rubric compiled from it would grow anchors nobody can evidence.
    const posting = {
      descriptionPlain: 'ABOUT THE ROLE\nreal requirements here\n\nEEO STATEMENT\nlegal boilerplate',
      descriptionParts: { descriptionBody: { plain: 'ABOUT THE ROLE\nreal requirements here' } },
    };
    const got = descriptionTextOf(posting);
    assert.equal(got.source, 'descriptionParts.descriptionBody');
    assert.match(got.text, /real requirements/);
    assert.doesNotMatch(got.text, /boilerplate/, 'the EEO closing must not reach the rubric compiler');
    assert.ok(got.dropped > 0, 'and the amount dropped must be reported, so a bad rubric is traceable');
  });

  test('a posting with no parts still yields its whole description', () => {
    const got = descriptionTextOf({ descriptionPlain: 'only the concatenated form' });
    assert.equal(got.source, 'descriptionPlain');
    assert.equal(got.dropped, 0);
    assert.equal(descriptionTextOf({}).text, null);
  });

  test('the gate is default-deny, and names WHICH refusal it is', () => {
    resetJobDescriptions();
    resetEnrolment();
    const app = { job: { id: 'j-1', title: 'Backend Engineer' } };

    // 1. Not enrolled at all — nobody asked Sam to grade this position.
    assert.throws(() => requireGradableJob(app), { name: 'JobNotEnrolledError' });

    // 2. Enrolled, but the description was never pulled. A different conversation with the
    //    customer, so it must be a different error rather than one vague refusal.
    enrolJob('j-1');
    assert.throws(() => requireGradableJob(app), { name: 'NoJobDescriptionError' });

    // 3. Both in place.
    rememberJobDescription({ jobId: 'j-1', jobTitle: 'Backend Engineer', text: 'requirements' });
    assert.equal(requireGradableJob(app).job.title, 'Backend Engineer');

    // 4. A neighbouring job stays refused — enrolment is per position, never global.
    assert.throws(() => requireGradableJob({ job: { id: 'j-2', title: 'Recruiter' } }),
      { name: 'JobNotEnrolledError' });

    resetEnrolment();
    resetJobDescriptions();
  });

  test('the ledger survives a restart — a SEPARATE process sees the delivery', () => {
    // The one test that cannot be satisfied in-process. reset() clears the Map, but a real
    // restart re-reads the file, and that is the path that stands between a crash and a
    // second Snapshot on a real person's record. Before the file existed, every run began
    // empty and re-delivered everyone it could still see.
    const file = `${tmpdir()}/sam-ledger-restart-${process.pid}.jsonl`;
    rmSync(file, { force: true });

    const run = (src) => execFileSync(process.execPath, ['--input-type=module', '-e', src], {
      env: { ...process.env, SAM_LEDGER: file }, encoding: 'utf8',
    }).trim();

    const imp = `const l = await import(${JSON.stringify(pathToFileURL(resolve('sam-integration/delivery/ledger.js')).href)});`;

    // Process 1 delivers.
    assert.equal(run(`${imp} l.record({candidateId:'c1', jobId:'j1', applicationId:'a1'}); console.log(l.wasDelivered('c1','j1'));`), 'true');

    // Process 2 — a restart — must still know.
    assert.equal(run(`${imp} console.log(l.wasDelivered('c1','j1'));`), 'true',
      'a restart re-delivering everyone is the single most expensive bug this system can have');

    // A PARTIAL delivery must NOT read as done, or the candidate is skipped forever with
    // a score on their record and no note explaining it.
    assert.equal(run(`${imp} l.record({candidateId:'c2', jobId:'j1', applicationId:'a2', surfaces:{fields:true, attachment:true, note:false}}); console.log(l.wasDelivered('c2','j1'));`), 'false');
    assert.equal(run(`${imp} console.log(l.missingSurfaces('c2','j1').join(','));`), 'note',
      'and the restart must know WHICH surface is still missing');

    rmSync(file, { force: true });
  });

  test('a claim closes the window between checking and delivering', () => {
    ledger.reset();
    assert.equal(claim('c9', 'j9'), true);
    assert.equal(claim('c9', 'j9'), false, 'a second pass must not also decide to deliver');
    release('c9', 'j9');
    assert.equal(claim('c9', 'j9'), true, 'and releasing must free it, or the candidate is skipped forever');
    release('c9', 'j9');
    ledger.reset();
  });

  test('file.info is called with the opaque handle, never the id', async () => {
    // Verified against a live org: {id} and {fileHandleId} are both refused with
    // invalid_input at HTTP 200, so a status-code check reads the refusal as a success and
    // concludes the candidate has no resume.
    const asked = [];
    const call = async (endpoint, body) => { asked.push(body); return { url: 'https://signed.example/x' }; };
    const fetchImpl = async () => ({ ok: true, headers: new Map([['content-type', 'application/pdf']]), arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });

    const got = await fetchFile({ id: 'the-id', name: 'cv.pdf', handle: 'the-opaque-handle' }, { post: call, fetchImpl });
    assert.deepEqual(asked[0], { fileHandle: 'the-opaque-handle' },
      'the id is refused by Ashby; only the handle works');
    assert.equal(got.filename, 'cv.pdf');
    assert.equal(got.bytes.length, 3);
  });

  test('a candidate with no resume is refused, not graded on nothing', async () => {
    await assert.rejects(
      () => fetchCandidateDocuments({ id: 'c1', fileHandles: [] }),
      { name: 'NoResumeError' },
      'a score derived from an empty document still looks like a score once it is on the record');

    await assert.rejects(
      () => fetchCandidateDocuments({ id: 'c1', resumeFileHandle: { id: 'x', name: 'cv.pdf' } }),
      { name: 'NoResumeError' },
      'a handle with no opaque blob cannot be fetched, and must not be treated as present');
  });

  test('an unreadable attachment does not cost us the resume', async () => {
    const call = async () => ({ url: 'https://signed.example/x' });
    let n = 0;
    const fetchImpl = async () => {
      n++;
      if (n === 2) throw new Error('attachment gone');
      return { ok: true, headers: new Map(), arrayBuffer: async () => new Uint8Array([7]).buffer };
    };
    const got = await fetchCandidateDocuments({
      id: 'c1',
      resumeFileHandle: { name: 'cv.pdf', handle: 'h-resume' },
      fileHandles: [{ name: 'cv.pdf', handle: 'h-resume' }, { name: 'cover.pdf', handle: 'h-cover' }],
    }, { post: call, fetchImpl });

    assert.equal(got.resume.filename, 'cv.pdf');
    assert.equal(got.attachments.length, 0);
    assert.equal(got.unreadable.length, 1, 'what could not be read is reported, never silently dropped');
    assert.equal(got.unreadable[0].name, 'cover.pdf');
  });

  test('Sam never binds its own previous Snapshot into a new one', async () => {
    // candidate.fileHandles is everything on the record, including OUR last upload. Verified
    // on a live record after one delivery. Bind it in and every pass nests the previous
    // Snapshot inside the next one, behind a divider that calls it a source document.
    const call = async () => ({ url: 'https://signed.example/x' });
    const fetchImpl = async () => ({ ok: true, headers: new Map(), arrayBuffer: async () => new Uint8Array([1]).buffer });

    const got = await fetchCandidateDocuments({
      id: 'c1',
      resumeFileHandle: { name: 'Alejandra_Smith_Resume.pdf', handle: 'h-resume' },
      fileHandles: [
        { name: 'Alejandra_Smith_Resume.pdf', handle: 'h-resume' },
        { name: 'SAM_Snapshot_Alejandra_Smith.pdf', handle: 'h-ours' },
        { name: 'cover_letter.pdf', handle: 'h-cover' },
      ],
    }, { post: call, fetchImpl });

    const names = got.attachments.map((a) => a.filename);
    assert.deepEqual(names, ['cover_letter.pdf'],
      'the candidate\'s own cover letter binds in; our previous Snapshot must not');
    assert.equal(got.unreadable.length, 0, 'and skipping ours is not a read failure');
  });

  test('unticking a job in Ashby turns Sam OFF for it', async () => {
    // Enrolment REPLACES rather than merges. If it merged, a client could switch Sam on but
    // never off, and the tick would be a one-way door — the worst possible shape for a
    // control the customer believes they own.
    const jobs = [{ id: 'j1', title: 'AE', status: 'Open' }, { id: 'j2', title: 'BE', status: 'Open' }];
    let on = new Set(['j1', 'j2']);
    const post = async (endpoint, body) => {
      if (endpoint === ENDPOINTS.listCustomFields) return [{ id: 'f1', title: 'Sam Grading', isArchived: false }];
      if (endpoint === ENDPOINTS.listJobs) return jobs;
      if (endpoint === ENDPOINTS.jobInfo) return { ...jobs.find((j) => j.id === body.id), customFields: [{ id: 'f1', value: on.has(body.id) }] };
      return null;
    };

    assert.deepEqual((await syncEnrolmentFromAshby({ post })).enrolled, ['j1', 'j2']);

    on = new Set(['j1']);                       // the client unticks BE in Ashby
    const after = await syncEnrolmentFromAshby({ post });
    assert.deepEqual(after.enrolled, ['j1']);
    assert.equal(isEnrolled('j2'), false, 'unticking must actually stop grading that job');
  });

  test('a closed job is never read, and never enrolled', async () => {
    const post = async (endpoint) => {
      if (endpoint === ENDPOINTS.listCustomFields) return [{ id: 'f1', title: 'Sam Grading', isArchived: false }];
      if (endpoint === ENDPOINTS.listJobs) return [{ id: 'j1', title: 'Closed role', status: 'Closed' }];
      throw new Error('job.info must not be called for a closed job — it cannot receive applications');
    };
    assert.deepEqual((await syncEnrolmentFromAshby({ post })).enrolled, []);
  });

  test('no Sam Grading field means nobody is enrolled, not everybody', async () => {
    const post = async (endpoint) => (endpoint === ENDPOINTS.listCustomFields ? [] : []);
    const got = await syncEnrolmentFromAshby({ post });
    assert.deepEqual(got.enrolled, []);
    assert.equal(got.field, null, 'an unprovisioned org must fail closed');
  });

  test('a real Ashby webhook is DECLINED, never paired with a stranger\'s evidence', async () => {
    // The dangerous repair and the correct one look identical from the handler. `entry` is a
    // seed-spreadsheet person; `application.candidate.id` is an Ashby person. Resolving a row
    // when the payload has none would publish A's interview evidence onto B's record.
    const src = readFileSync('sam-integration/server.js', 'utf8');

    assert.match(src, /data\.surveyRow === undefined \? null/,
      'a payload with no surveyRow must resolve to nothing, not to a default row');
    assert.match(src, /NoEnginePayloadError/,
      'and the refusal must be its own named error, distinguishable from a crash');
    assert.doesNotMatch(src, /byRow\.get\(data\.surveyRow \?\?/,
      'never fall back to another row — that is the data-protection incident');

    const handler = src.slice(src.indexOf('async function processApplication'));
    assert.ok(handler.indexOf('NoEnginePayloadError') < handler.indexOf('deliverSnapshot'),
      'the refusal has to come BEFORE anything is written to a record');
  });

  test('a cohort too small to mean anything gets no rank at all', () => {
    const few = [1, 2, 3].map((i) => ({ candidateId: `c${i}`, snapshot: { roleFit: 0.8, coverage: 0.9 } }));
    assert.equal(cohortFor(few).ranked.size, 0,
      '"top 100% of 1" is the most misleading true statement this system could publish');
  });

  test('only candidates at comparable coverage are ranked against each other', () => {
    // Role Fit is coverage-denominated: someone evidenced on two anchors of six can outscore
    // someone evidenced on all six. Ranking them together produces a confident lie.
    const mixed = [
      { candidateId: 'thin', snapshot: { roleFit: 1.0, coverage: 0.3 } },
      ...[1, 2, 3, 4].map((i) => ({ candidateId: `c${i}`, snapshot: { roleFit: 0.5 + i / 100, coverage: 0.9 } })),
    ];
    const { ranked } = cohortFor(mixed);
    assert.equal(ranked.has('thin'), false, 'a 100% on a third of the rubric must not take first place');
    assert.equal(ranked.size, 4);
    assert.equal(ranked.get('c4').rank, 1, 'the highest comparable score leads');
  });

  test('tied scores share a rank, and the next one skips', () => {
    const tied = [
      { candidateId: 'a', snapshot: { roleFit: 0.9, coverage: 0.9 } },
      { candidateId: 'b', snapshot: { roleFit: 0.8, coverage: 0.9 } },
      { candidateId: 'c', snapshot: { roleFit: 0.8, coverage: 0.9 } },
      { candidateId: 'd', snapshot: { roleFit: 0.7, coverage: 0.9 } },
    ];
    const { ranked } = cohortFor(tied);
    assert.equal(ranked.get('b').rank, 2);
    assert.equal(ranked.get('c').rank, 2, 'breaking a tie invents a distinction the evidence does not support');
    assert.equal(ranked.get('d').rank, 4, 'and the next one skips to 4, not 3');
  });

  test('the job summary uses a median, and says nothing when it cannot', () => {
    const entries = [0.4, 0.6, 0.9].map((f, i) => ({ candidateId: `c${i}`, snapshot: { roleFit: f, coverage: 0.9 } }));
    const s = jobSummary(entries);
    assert.equal(s.graded, 3);
    assert.equal(s.medianRoleFit, 60, 'a median, so one outstanding candidate does not flatter the pipeline');

    const none = jobSummary([{ candidateId: 'x', failed: true }]);
    assert.equal(none.graded, 0);
    assert.equal(none.medianRoleFit, null, 'an empty cell reads as "not enough to say"; a 0 reads as "everyone failed"');
  });

  test('a Snapshot is never attached twice, even with the ledger gone', () => {
    // Observed on a live record: three identical sam_snapshot_*.pdf files, because
    // candidate.uploadFile appends and the ledger had been rolled back between runs.
    // The ledger is the plan; this guard is what stops the failure reaching a recruiter.
    const src = readFileSync('sam-integration/endpoints/candidate.uploadFile.js', 'utf8');
    assert.match(src, /snapshotAlreadyAttached/,
      'the upload must ask whether this file is already on the record');

    const fn = src.slice(src.indexOf('export async function uploadSnapshotFile'));
    assert.ok(fn.indexOf('snapshotAlreadyAttached') < fn.indexOf('createFileUploadHandle'),
      'and it must ask BEFORE uploading, not only before a retry — the duplicate is made by '
      + 'a second run, whose FIRST attempt is where it happens');
  });

  test('a re-scored candidate gets the NEW Snapshot, not the one already on the record', () => {
    // The guard above matched on the FILENAME, and the test above only checks that it is
    // CALLED — which is why this got through both. Observed live: Jamar Herzog's fields read
    // 90% while the PDF attached to that same record was the 3KB one-page draft from an
    // earlier run. The guard saw `sam_snapshot_jamar_herzog.pdf`, called it already attached,
    // skipped the upload, and reported the delivery a success.
    //
    // A record that disagrees with ITSELF is worse than one that is merely out of date: the
    // fields say interview them and the document attached says do not.
    const bytes = (s) => Buffer.from(`%PDF-1.4 ${s}`);
    const first = snapshotFilename('Jamar Herzog', bytes('the first grading'));
    const again = snapshotFilename('Jamar Herzog', bytes('the first grading'));
    const rescored = snapshotFilename('Jamar Herzog', bytes('re-scored at 90%'));

    assert.equal(first, again,
      'the same document must still dedupe — that is the duplicate-file bug this replaced');
    assert.notEqual(first, rescored,
      'but a DIFFERENT document must never be mistaken for one already on the record');
    assert.match(first, /^sam_snapshot_jamar_herzog_[0-9a-f]{8}\.pdf$/);
  });

  test('Sam\'s live payload renders, identity and all, from Ashby', () => {
    const s = snapshotFromSamPayload(SAM_EXAMPLE, SAM_ASHBY);
    assert.equal(Math.round(s.roleFit * 100), 94);
    assert.equal(s.capability, 9);
    assert.equal(s.samUrl, 'https://app.launchsam.com/snapshot/8f21c0');

    // Sam sends person_name "Jane Doe" and person_email. Ashby is the system of record, and
    // a Snapshot showing a name that does not match the record it sits on is the most
    // alarming possible way to discover the two disagree.
    assert.equal(s.candidate.name, SAM_ASHBY.candidate.name);
    assert.doesNotMatch(JSON.stringify(s.candidate), /jane\.doe@example\.com/);
  });

  test('met_by_equivalent gets its own state, and the assumption travels with it', () => {
    const s = snapshotFromSamPayload(SAM_EXAMPLE, SAM_ASHBY);
    const byEquivalence = s.roleAnchors.find((a) => a.label === 'Client retention');
    // Not PARTIAL — Sam is not hedging, it is reasoning — and not MET, because the reviewer
    // should get to judge the transfer. Its own state is the only honest option.
    assert.equal(byEquivalence.state, 'MET_EQUIVALENT');
    assert.match(byEquivalence.reason, /Counted by equivalence to Direct account ownership/);
    assert.match(byEquivalence.reason, /transfers to retention driven through account management/);
  });

  test('the PDF never prints a coverage number Sam did not send', async () => {
    // Caught by actually looking at a rendered page: the header read "0% COVERAGE" beside a
    // 65% score and every footer said "at 0% coverage". A PDF is downloaded, emailed and
    // printed — it cannot be corrected once it is attached to a candidate.
    const s = snapshotFromSamPayload(SAM_EXAMPLE, SAM_ASHBY);
    const text = extractPdfText(await renderSnapshotPdf(s));

    assert.doesNotMatch(text, /0% COVERAGE/i);
    assert.doesNotMatch(text, /at 0% coverage/i);
    assert.doesNotMatch(text, /NaN/);
    assert.match(text, /5 OF 6 ANCHORS|5 of 6 anchors/i,
      'the denominator becomes the anchor count Sam actually sends');
  });

  test('the rail shows a directive, not a sentence cut in half', () => {
    const s = snapshotFromSamPayload(SAM_EXAMPLE, SAM_ASHBY);
    const f = Object.fromEntries(samFieldValues(s).map((x) => [x.field.name, x.value]));

    // Sam writes a verdict then its qualifications. The rail gets the verdict; the note has
    // room for the rest. Cutting at a character count severed it mid-thought.
    assert.equal(f['Sam Next Step'], 'Strong enough to interview.');
    assert.doesNotMatch(f['Sam Next Step'], /…$/, 'a complete first sentence needs no ellipsis');

    // The verdict carries how it was reached: "Strong" alone invites the reader to weigh it
    // as though the whole role had been assessed.
    assert.equal(f['Sam Band'], 'Strong · résumé only');
  });

  test('a very long first sentence still gets trimmed, at a word boundary', () => {
    const long = { ...SAM_EXAMPLE, recommended_next_step: `Interview them ${'soon '.repeat(40)}today.` };
    const f = Object.fromEntries(samFieldValues(snapshotFromSamPayload(long, SAM_ASHBY)).map((x) => [x.field.name, x.value]));
    assert.ok(f['Sam Next Step'].length <= 115);
    assert.match(f['Sam Next Step'], /…$/);
    assert.doesNotMatch(f['Sam Next Step'], /\s…$/, 'trimmed at a word, not leaving a dangling space');
  });

  test('a payload with no coverage never renders a coverage number', () => {
    // The bug this guards: Math.round(null * 100) is 0, so a candidate Sam scored 94 arrived
    // as "Role Fit 94% at 0% evidence coverage" — not a missing number, an actively wrong
    // one, on a hiring manager's screen, uncorrectable once the note is posted.
    const s = snapshotFromSamPayload(SAM_EXAMPLE, SAM_ASHBY);
    const html = composeNoteHtml(s, s.samUrl, { filename: 'x.pdf' });

    assert.doesNotMatch(html, /0% evidence coverage/);
    assert.doesNotMatch(html, /NaN/);
    assert.match(html, /5 of 6/,
      'the denominator becomes the one Sam actually sends');

    const fields = Object.fromEntries(samFieldValues(s).map((f) => [f.field.name, f.value]));
    assert.equal(fields['Sam Evidence Coverage'], null,
      'cleared, so it reads as empty rather than as a real zero');
    assert.equal(fields['Sam Anchors Met'], '5 of 6');
  });

  test('coverage is null rather than invented, because Sam does not send one', () => {
    const s = snapshotFromSamPayload(SAM_EXAMPLE, SAM_ASHBY);
    assert.equal(s.coverage, null,
      'met_count/total is a met-rate, not coverage — feeding it to the coverage gate would '
      + 'make a score look better evidenced than it is');
    assert.equal(s.anchorSummary.notCollected, 0,
      'Sam has no "never asked" state, so nothing may be mapped to it');
  });

  test('a capped score is withheld, carrying Sam\'s own reason', () => {
    // With no coverage figure our floor cannot run, so we defer to Sam's guard.
    const capped = { ...SAM_EXAMPLE, match: { ...SAM_EXAMPLE.match, cap_applied: true, cap_note: 'Core anchor absent.' } };
    const s = snapshotFromSamPayload(capped, SAM_ASHBY);
    assert.equal(s.scoreIsPublishable, false);
    assert.ok(s.caveats.includes('Core anchor absent.'), 'a withheld number must arrive with its reason');
  });

  test('Sam\'s rank is NOT published — it is a point-in-time snapshot', () => {
    // Observed live: submitting three applicants to one job in sequence gave rank null,
    // then 1 of 2, then 1 of 3. Sam never revisits an earlier candidate, so every rank but
    // the most recent is stale the moment somebody else applies — and the first is empty
    // forever. Our ledger recomputes the ordering on every pass instead.
    const s = snapshotFromSamPayload(SAM_EXAMPLE, SAM_ASHBY);
    assert.equal(s.pool, null, 'the published rank comes from our cohort, computed fresh');
    assert.equal(s.samRank.rank, 3, 'Sam\'s own figure is kept for reference');
    assert.equal(s.samRank.size, 128);
  });

  test('Sam\'s cohort finding is carried for the JOB, not the candidate', () => {
    const s = snapshotFromSamPayload(SAM_EXAMPLE, SAM_ASHBY);
    assert.equal(s.cohortFindings.length, 1);
    assert.match(s.cohortFindings[0].finding, /No applicant for this role/);
    // It is a judgement about the rubric across a pool — repeating it on every candidate's
    // record would read as a criticism of each of them.
    const html = composeNoteHtml(s, s.samUrl, null);
    assert.doesNotMatch(html, /No applicant for this role/);
  });

  test('the AI-authorship flag surfaces only when it fires', () => {
    const clean = snapshotFromSamPayload(SAM_EXAMPLE, SAM_ASHBY);
    assert.ok(!clean.caveats.some((c) => /AI authorship/i.test(c)),
      'a "no AI detected" line on every document trains reviewers to ignore it on the one that matters');

    const flagged = { ...SAM_EXAMPLE, integrity: { ai_authorship_flag: true, notes: 'Phrasing is uniform throughout.' } };
    const s = snapshotFromSamPayload(flagged, SAM_ASHBY);
    assert.ok(s.caveats.some((c) => /AI authorship/i.test(c) && /uniform throughout/.test(c)));
  });

  test('an unknown anchor status is refused, never guessed', () => {
    const odd = { ...SAM_EXAMPLE, role_anchors: { ...SAM_EXAMPLE.role_anchors,
      items: [{ anchor: 'x', weight: 'core', status: 'probably_fine', evidence: 'e' }] } };
    assert.throws(() => snapshotFromSamPayload(odd, SAM_ASHBY), { name: 'SamPayloadError' },
      'a status we do not recognise must stop the delivery, not become a default verdict');
  });

  test('a reply is tied to its question, not just "the next note"', () => {
    const ref = refFor('c1', 'j1');
    const notes = [
      { id: 'q', createdAt: '2026-01-01T10:00:00Z', content: `ask ${ref}`, author: { id: 'sam-bot' } },
      // Two recruiters talking to each other. Neither is an answer.
      { id: 'x', createdAt: '2026-01-01T11:00:00Z', content: 'Spoke to the hiring manager', author: { id: 'u1' } },
      { id: 'a', createdAt: '2026-01-01T12:00:00Z', content: '1Y 2N', author: { id: 'u2', firstName: 'Dana' } },
    ];
    const got = readReply(notes, ref, 2, 'sam-bot');
    assert.equal(got.answers.get(1), true);
    assert.equal(got.answers.get(2), false);
    assert.equal(got.by.firstName, 'Dana', 'who answered is part of the record');
  });

  test('Sam never reads its own note as a reply', () => {
    const ref = refFor('c1', 'j1');
    const notes = [
      { id: 'q', createdAt: '2026-01-01T10:00:00Z', content: `ask ${ref}`, author: { id: 'sam-bot' } },
      // Sam posting again. Without the self-check it answers its own question and marks
      // everything confirmed.
      { id: 'q2', createdAt: '2026-01-01T11:00:00Z', content: 'Y', author: { id: 'sam-bot' } },
    ];
    assert.equal(readReply(notes, ref, 2, 'sam-bot'), null);
  });

  test('prose containing "yes" is not an answer', () => {
    // "yes, I'll ask them in the screen" means the opposite of confirmed. A looser parser
    // reads it as agreement and publishes a claim nobody made.
    assert.equal(parseAnswer("yes, I'll ask them in the screen", 2), null);
    assert.equal(parseAnswer('Going to confirm this next week', 2), null);
    assert.equal(parseAnswer('no idea, chasing the hiring manager', 2), null);

    // What a real answer looks like.
    assert.equal(parseAnswer('Y', 2).blanket, true);
    assert.equal(parseAnswer('no', 2).blanket, false);
    assert.equal(parseAnswer('1 yes 2 no', 2).answers.get(2), false);
  });

  test('an out-of-range item number is ignored', () => {
    const got = parseAnswer('1Y 7Y', 2);
    assert.equal(got.answers.get(1), true);
    assert.equal(got.answers.has(7), false, 'there is no item 7 to confirm');
  });

  test('the acknowledgement names who answered', () => {
    const items = [{ label: 'Health-services context' }, { label: 'P&L accountability' }];
    const html = composeAcknowledgementHtml({
      candidateName: 'Jane',
      openItems: items,
      reply: { answers: new Map([[1, true], [2, false]]), blanket: null, by: { firstName: 'Dana', lastName: 'Reed' } },
    });
    assert.match(html, /Dana Reed/, 'an item marked confirmed with no attribution is worse than an open one');
    assert.match(html, /✅.*Health-services/);
    assert.match(html, /❌.*P&amp;L/);
  });

  test('the band tag is derived from Sam\'s own verdict, provenance stripped', () => {
    // Band now reads "Strong · résumé only" on the record; the tag is the verdict alone.
    assert.equal(bandTagFor('Strong · résumé only'), '⭐ Sam · Strong');
    assert.equal(bandTagFor('Partial'), '⭐ Sam · Partial');
    assert.equal(bandTagFor('Not a match · résumé only'), '⭐ Sam · Not a match');

    // A band we do not have a tag for produces none, rather than inventing one.
    assert.equal(bandTagFor('Insufficient evidence'), null);
    assert.equal(bandTagFor(null), null);
  });

  test('exactly one band tag exists per candidate', () => {
    // A re-score that moves somebody from Strong to Partial must not leave both, or a
    // recruiter filtering on either one gets them.
    const titles = Object.values(BAND_TAGS);
    assert.equal(new Set(titles).size, titles.length, 'band tags must be distinct');
    for (const t of titles) assert.match(t, /^⭐ Sam · /, 'and grouped under one visible prefix');
  });

  test('a band Sam ADDS is noisy; a verdict Sam withheld stays silent', () => {
    // Sam documented three bands and then began returning a fourth, SOLID. `bandTagFor`
    // returned null, `tagBand` skipped, nothing failed and nothing was logged — so an 83%
    // candidate sat in Ashby with no band tag and a record that looked finished. Found by
    // audit, which is the wrong way to find it.
    assert.equal(bandTagFor('Solid'), '⭐ Sam · Solid', 'the band Sam actually sends');

    // The distinction that decides whether silence is correct: a verdict we do not recognise
    // is a gap in this map, but NO verdict is a candidate Sam declined to place, and that one
    // is supposed to carry no tag.
    assert.ok(isUnrecognisedVerdict('Exceptional'), 'an unknown band must be reported');
    assert.ok(!isUnrecognisedVerdict('Not determined'), 'no verdict is not a missing tag');
    assert.ok(!isUnrecognisedVerdict('Insufficient evidence'));
    assert.ok(!isUnrecognisedVerdict(null));
  });

  test('the scorecard itself is answerable, and the pipeline actually sends a reference', () => {
    // followUp.js was written, tested and never called: the pipeline imported neither
    // askFollowUp nor refFor, so Sam asked nothing, nobody could answer, and the whole
    // conversation existed only in the test suite. A feature with full coverage and no
    // caller is indistinguishable from a feature that works, right up until a demo.
    const snapshot = snapshotFromSamPayload(SAM_EXAMPLE, SAM_ASHBY);

    const withRef = composeNoteHtml(snapshot, null, null, 'sam:abc123');
    assert.match(withRef, /Reply/, 'the open items must say how to answer them');
    assert.match(withRef, /sam:abc123/, 'and carry the reference a reply is matched on');

    // No reference means no invitation — a note asking for a reply nobody can match is worse
    // than one that does not ask.
    assert.doesNotMatch(composeNoteHtml(snapshot, null, null, null), /Reply <b>1Y/);

    const src = readFileSync('sam-integration/delivery/pipeline.js', 'utf8');
    assert.match(src, /refFor\(candidateId/,
      'and the delivery must derive one — a conversation nobody opens is not a conversation');
    assert.match(src, /questions: asking/, 'and send the questions it recorded as asked');
    assert.match(src, /recordAsked\(/,
      'and write them down, so a reply can be resolved against what was actually shown');
  });

  test('a reply cannot answer an item the note never showed', () => {
    // The scorecard prints the first ASK_LIMIT open items; Sam often returns five. Reading a
    // reply against all five would let a bare "Y" mark two items confirmed that the person
    // was never shown — attributed to them by name, on a hiring record.
    const ref = 'sam:zz1111';
    const notes = [
      { id: 'q', createdAt: '2026-01-01T00:00:00Z', author: { id: 'sam-bot' }, content: `open ${ref}` },
      { id: 'a', createdAt: '2026-01-02T00:00:00Z', author: { id: 'human' }, content: '4Y' },
    ];
    assert.equal(readReply(notes, ref, ASK_LIMIT, 'sam-bot'), null,
      'item 4 was never on the note, so answering it answers nothing');

    // The visible items still work normally.
    const seen = [notes[0], { ...notes[1], content: '2N' }];
    assert.equal(readReply(seen, ref, ASK_LIMIT, 'sam-bot').answers.get(2), false);

    const src = readFileSync('sam-integration/delivery/followUp.js', 'utf8');
    assert.match(src, /Math\.min\(itemCount, ASK_LIMIT\)/,
      'the reader must cap to what the writer printed, from the same constant');
  });

  test('our own "Reply 1Y 2N" hint is never read as somebody\'s answer', () => {
    // The scorecard tells the reader how to answer, and the example IS a valid answer:
    // parseAnswer returns {1:true, 2:false} on our own sentence. Author matching was the
    // only thing stopping that from landing as a confirmation under a named person — and a
    // note with no author, which Ashby can return, defeats author matching silently and in
    // the direction that does damage.
    const ref = 'sam:4b3bff';
    const question = { id: 'q', createdAt: '2026-01-01T00:00:00Z', author: { id: 'sam' }, content: `asked ${ref}` };
    const ourHint = { id: 'ours', createdAt: '2026-01-02T00:00:00Z', author: null,
      content: `Found out since? Reply 1Y 2N on this note. ${ref}` };
    const human = { id: 'h', createdAt: '2026-01-03T00:00:00Z', author: { id: 'human' }, content: '1N 2N 3N' };

    assert.equal(parseAnswer(ourHint.content, 3).answers.get(1), true,
      'the hint really does parse as an answer — that is why the guard exists');

    const got = readReply([question, ourHint, human], ref, 3, null);
    assert.equal(got.noteId, 'h', 'the human reply must win, not our own instruction');
    assert.equal(got.answers.get(1), false);
  });

  test('a reply to LAST month\'s questions is not read as an answer to this month\'s', () => {
    // refFor is sha(candidateId:jobId) — the same string for every set of questions ever put
    // on this pairing. Anchoring on the first note carrying it finds September's asking, and
    // the first human note after THAT is September's reply, which then lands on October's
    // items under that person's name. Seen live: a 2 October reply sitting above a question
    // set posted on 10 October.
    const ref = 'sam:18b929';
    const notes = [
      { id: 'q-sep', createdAt: '2026-09-02T00:00:00Z', author: { id: 'sam' }, content: `old questions ${ref}` },
      { id: 'a-sep', createdAt: '2026-09-02T01:00:00Z', author: { id: 'human' }, content: '1Y 2Y 3Y' },
      { id: 'q-oct', createdAt: '2026-10-10T00:00:00Z', author: { id: 'sam' }, content: `new questions ${ref}` },
    ];

    // Unscoped, September's answer is returned for October's questions.
    assert.equal(readReply(notes, ref, 3, 'sam').noteId, 'a-sep');

    // Scoped to when the current set was asked, there is simply no answer yet.
    assert.equal(readReply(notes, ref, 3, 'sam', { after: '2026-10-10T00:00:00Z' }), null,
      'nobody has answered the questions that are actually on the record');
  });

  test('the questions asked are the ones holding the score down, best first', () => {
    // Sam reports its uncertainty in two places and they are not equally useful. A NOT_MET
    // core anchor is what applies the cap — Jamar Herzog sits at 65% because three are
    // missing. `what_to_confirm` is a template placeholder and a job title. Asking the
    // cosmetic ones first wastes the only three slots a reviewer will actually read.
    const snapshot = {
      roleAnchors: [
        { id: 'a', label: 'Met already', state: 'MET', core: true, weight: 0.3 },
        { id: 'b', label: 'Supporting gap', state: 'NOT_MET', core: false, weight: 0.4, reason: 'r1' },
        { id: 'c', label: 'Core gap', state: 'NOT_MET', core: true, weight: 0.1, reason: 'r2' },
        { id: 'd', label: 'Never assessed', state: 'NOT_COLLECTED', core: false, weight: 0.2 },
      ],
      gapsToInvestigate: [{ label: 'A title that went backwards', reason: 'r3' }],
    };

    const qs = openQuestionsFor(snapshot, 'job-1');
    assert.deepEqual(qs.map((q) => q.label),
      ['Core gap', 'Supporting gap', 'Never assessed', 'A title that went backwards'],
      'core outranks weight, because only a missing core anchor applies the cap');
    assert.ok(!qs.some((q) => q.label === 'Met already'), 'a met requirement is not a question');

    // Only the ones that gate the band carry the "this matters" line. On every row it would
    // be noise; on a row where it is untrue it is a promise the next grading breaks.
    assert.match(impactOf(qs[0]), /core requirement/);
    assert.equal(impactOf(qs[1]), null);

    // An anchor is a yes/no about the person; Sam's own wording is kept for what_to_confirm.
    assert.match(askOf(qs[0]), /^Have they done this\?/);
    assert.equal(askOf(qs[3]), 'A title that went backwards');
  });

  test('a question id survives a re-score, so an answer still binds', () => {
    // Answers are positional when typed and permanent once recorded. If the id moved with
    // the wording of Sam's reason — which is regenerated every grading — yesterday's answer
    // would stop matching today's question and be asked again forever.
    const a = questionIdFor('job-1', 'Multi-stakeholder deal navigation');
    const b = questionIdFor('job-1', '  multi-stakeholder   DEAL navigation ');
    assert.equal(a, b, 'case and spacing must not change the identity of a requirement');
    assert.notEqual(a, questionIdFor('job-2', 'Multi-stakeholder deal navigation'),
      'the same requirement on a different job is a different question');
  });

  test('the next pass asks the NEXT questions, not the same ones again', () => {
    process.env.SAM_CONVERSATIONS = `/tmp/sam-convo-${Date.now()}.jsonl`;
    resetConversations();

    const questions = [
      { id: 'q:1', label: 'One', source: 'anchor' },
      { id: 'q:2', label: 'Two', source: 'anchor' },
      { id: 'q:3', label: 'Three', source: 'confirm' },
    ];
    recordAsked({ candidateId: 'c1', jobId: 'j1', ref: 'sam:aaa', questions });

    // A reply is positional; it resolves against the set that was RECORDED as shown.
    const resolved = resolvePositions('c1', 'j1', new Map([[1, true], [3, false]]), null);
    assert.deepEqual(resolved.map((r) => [r.questionId, r.confirmed]),
      [['q:1', true], ['q:3', false]], 'position 3 is whatever was printed third, not the third question Sam has');

    for (const r of resolved) {
      recordAnswer({ candidateId: 'c1', jobId: 'j1', questionId: r.questionId, confirmed: r.confirmed, by: null, at: null, noteId: 'n1' });
    }

    assert.deepEqual(unansweredFrom(questions, 'c1', 'j1').map((q) => q.id), ['q:2'],
      'answered questions drop out — this is what makes it a conversation and not a recurring notice');

    // And a scheduled re-run must not acknowledge the same reply twice.
    assert.equal(wasAcknowledged('c1', 'j1', 'n1'), false);
    recordAcknowledged({ candidateId: 'c1', jobId: 'j1', noteId: 'n1' });
    assert.equal(wasAcknowledged('c1', 'j1', 'n1'), true);
  });

  test('a pass collects replies BEFORE it can decide there is nothing to do', () => {
    // The run exits early with "nobody new to score" — which is the state a real pipeline
    // sits in most days, every applicant already delivered. That is also exactly when
    // replies are arriving. Collecting after that exit means answers are only ever read on
    // the days new applicants happen to turn up, and a recruiter who answered on a quiet
    // Tuesday is ignored until someone new applies.
    const src = readFileSync('scripts/sam-run.js', 'utf8');
    const collects = src.indexOf('collectReplies({');
    const firstExit = src.indexOf('process.exit(0)');

    assert.ok(collects > 0, 'the pass must collect replies at all');
    assert.ok(firstExit > 0, 'and it does still exit early when there is nothing to grade');
    assert.ok(collects < firstExit,
      'collection has to happen before the first early exit, not after it');
  });

  test('the note fingerprint matches what Ashby stores, not what we sent', () => {
    // Ashby does not return the HTML it was given: a text/html note comes back as plain
    // text, tags stripped, every <li> prefixed with "- ". The old fingerprint was a line
    // composed for the PLAIN-TEXT note — "Role Fit 94% · 6 of 6 anchors met" — which never
    // appeared in an HTML one. So `verify` never matched, the HTML note had no dedupe at
    // all, and a delivery whose response was lost posted a second scorecard. Preflight
    // caught it as "2 notes"; on a real record it is two identical scorecards on a person.
    const snapshot = snapshotFromSamPayload(SAM_EXAMPLE, SAM_ASHBY);
    const html = composeNoteHtml(snapshot, null, null, 'sam:abc123');
    const fingerprint = noteFingerprint(html);

    assert.ok(fingerprint.length > 40, 'a fingerprint short enough to collide is not one');
    assert.doesNotMatch(fingerprint, /[<>]/, 'it has to survive tag stripping');

    // Ashby's rendering: tags gone, <li> bulleted, entities decoded, whitespace collapsed.
    const asAshbyStoresIt = html
      .replace(/<li>/g, '\n- ').replace(/<\/p>|<br>/g, '\n')
      .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
    assert.ok(noteFingerprint(asAshbyStoresIt).includes(fingerprint)
      || asAshbyStoresIt.replace(/[\s\u00a0]+/g, ' ').includes(fingerprint),
      'the fingerprint must be findable in the stored form, or dedupe silently never fires');

    // It stops before the first list ITEM, which is where Ashby's "- " bullets begin, and it
    // carries the parts that differ between two gradings worth telling apart.
    assert.match(fingerprint, /94%/, 'the score must be in it');
    assert.match(fingerprint, /Next step\./, 'and the verdict, which moves when the grading does');
    assert.ok(!fingerprint.includes('by equivalence'), 'but no list content');
  });

  test('collecting a reply records it once, and a second pass does nothing', async () => {
    process.env.SAM_CONVERSATIONS = `/tmp/sam-collect-${Date.now()}.jsonl`;
    resetConversations();

    const askedAt = '2026-10-10T00:00:00Z';
    recordAsked({
      candidateId: 'c9', jobId: 'j9', ref: 'sam:abcdef', at: askedAt,
      questions: [
        { id: 'q:a', label: 'Multi-stakeholder deal navigation', source: 'anchor' },
        { id: 'q:b', label: 'Pipeline management', source: 'anchor' },
      ],
    });

    const notes = [
      { id: 'q', createdAt: askedAt, author: { id: 'sam' }, content: 'questions sam:abcdef' },
      { id: 'reply', createdAt: '2026-10-10T09:00:00Z', author: { id: 'human', firstName: 'Dana', lastName: 'Reed' }, content: '1Y 2N' },
    ];

    const posted = [];
    const fakePost = async (endpoint, body) => {
      posted.push(endpoint);
      if (endpoint === '/candidate.listNotes') return notes;
      return {};
    };

    const rows = [{ candidateId: 'c9', jobId: 'j9', applicationId: 'a9', snapshot: { candidate: { name: 'Jamar Herzog' } } }];

    const first = await collectReplies({ rows, write: true, post: fakePost });
    assert.equal(first.recorded, 1, 'the reply must be recorded');
    assert.ok(posted.includes('/candidate.createNote'), 'and acknowledged on the record');

    // The whole reason this is safe to schedule: running it again must be a no-op, not a
    // second acknowledgement note on a real person's record every time cron fires.
    const outcomes = [];
    const second = await collectReplies({ rows, write: true, post: fakePost, onResult: (r) => outcomes.push(r.outcome) });
    assert.equal(second.recorded, 0);
    assert.deepEqual(outcomes, [REPLY.alreadyRecorded]);

    // And the answers landed on the right questions, by id rather than by position.
    assert.deepEqual(unansweredFrom(
      [{ id: 'q:a' }, { id: 'q:b' }, { id: 'q:c' }], 'c9', 'j9',
    ).map((q) => q.id), ['q:c']);
  });

  test('a non-PDF served at 200 is refused, never attached', async () => {
    // An auth redirect or an error page served with a 200 would otherwise reach a
    // candidate's record as though it were their Snapshot. Checked on the bytes, not the
    // status code, because the status code is what lies here.
    const html = async () => ({
      ok: true, status: 200,
      headers: new Map([['content-type', 'text/html']]),
      arrayBuffer: async () => new TextEncoder().encode('<!doctype html><title>Sign in</title>').buffer,
    });
    await assert.rejects(
      () => fetchSnapshotPdf('https://app.launchsam.com/snapshot/x/pdf', { fetchImpl: html }),
      /expected a PDF/);
  });

  test('real PDF bytes are returned untouched', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.7 ...');
    const ok = async () => ({
      ok: true, status: 200,
      headers: new Map([['content-type', 'application/pdf']]),
      arrayBuffer: async () => pdf.buffer,
    });
    const got = await fetchSnapshotPdf('https://app.launchsam.com/snapshot/x/pdf', { fetchImpl: ok });
    assert.equal(got.subarray(0, 4).toString(), '%PDF');
  });

  test('no Sam PDF url means no fetch at all', async () => {
    assert.equal(await fetchSnapshotPdf(null), null,
      'the caller falls back to our renderer rather than requesting nothing');
  });

  test('the application names its own job, in either shape', () => {
    // Real Ashby nests it; there is no `candidateId`/`jobId` flat field on a list row.
    assert.deepEqual(jobOfApplication({ job: { id: 'j1', title: 'AE' } }), { id: 'j1', title: 'AE' });
    assert.deepEqual(jobOfApplication({ jobId: 'j2' }), { id: 'j2', title: null });
    assert.equal(jobOfApplication({}), null, 'an application with no job must resolve to nothing, not to a default');
  });
});

/**
 * The client's retry taxonomy, against how Ashby ACTUALLY answers.
 *
 * Verified live: validation errors arrive as HTTP 200 with success:false and errors as bare
 * STRINGS. The old code branched on status codes and mapped `e.message`, so a deterministic
 * rejection was retried three times as though transient, a 429 was never retried at all, and
 * every error message this integration ever printed read "undefined".
 */
describe('Ashby client, against the real response shapes', () => {
  const origFetch = globalThis.fetch;
  const origUrl = process.env.ASHBY_API_URL;
  let calls;

  const stub = (responses) => {
    calls = [];
    let i = 0;
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), body: init?.body });
      const r = responses[Math.min(i++, responses.length - 1)];
      if (r.throw) throw r.throw;
      return {
        status: r.status ?? 200,
        headers: new Headers(r.headers ?? {}),
        json: async () => r.json,
      };
    };
  };

  // Point away from api.ashbyhq.com so the live-write guard does not fire, and restore
  // the real fetch when this file is done with it.
  process.env.ASHBY_API_URL = 'http://localhost:3001';
  process.on('exit', () => { globalThis.fetch = origFetch; process.env.ASHBY_API_URL = origUrl; });

  test('a bare-string error becomes a readable message, not "undefined"', async () => {
    stub([{ status: 200, json: { success: false, errors: ['invalid_input'] } }]);
    await assert.rejects(() => post('/job.info', {}), (err) => {
      assert.match(err.message, /invalid_input/,
        'errors is an array of strings; mapping e.message over it yields undefined');
      assert.doesNotMatch(err.message, /undefined/);
      return true;
    });
  });

  test('HTTP 200 + success:false is NOT retried — it is deterministic', async () => {
    stub([{ status: 200, json: { success: false, errors: ['invalid_input'] } }]);
    await assert.rejects(() => post('/job.info', {}));
    assert.equal(calls.length, 1,
      'a malformed request will be malformed on every attempt; retrying it three times '
      + 'wastes the run and hides the cause');
  });

  test('429 IS retried, and honours Retry-After', async () => {
    stub([
      { status: 429, headers: { 'retry-after': '0' }, json: { success: false, errors: ['rate_limited'] } },
      { status: 200, json: { success: true, results: { ok: true } } },
    ]);
    const got = await post('/candidate.list', {});
    assert.deepEqual(got, { ok: true });
    assert.equal(calls.length, 2, '429 is a 4xx, and the old rule threw every 4xx away');
  });

  test('a 5xx retries, a 401 does not', async () => {
    stub([
      { status: 500, json: { success: false, errors: ['server_error'] } },
      { status: 200, json: { success: true, results: [] } },
    ]);
    await post('/candidate.list', {});
    assert.equal(calls.length, 2);

    stub([{ status: 401, json: { success: false, errors: ['unauthorized'] } }]);
    await assert.rejects(() => post('/candidate.list', {}));
    assert.equal(calls.length, 1, 'a bad key is not going to become a good key');
  });

  test('postAll follows pagination to the end', async () => {
    stub([
      { status: 200, json: { success: true, results: [{ id: 1 }, { id: 2 }], moreDataAvailable: true, nextCursor: 'c1' } },
      { status: 200, json: { success: true, results: [{ id: 3 }], moreDataAvailable: false, nextCursor: null } },
    ]);
    const rows = await postAll('/application.list', { limit: 2 });
    assert.deepEqual(rows.map((r) => r.id), [1, 2, 3],
      'one page treated as the whole window is how a cohort goes missing');
    assert.match(String(calls[1].body), /"cursor":"c1"/);
  });

  test('postAll refuses to return a truncated list as though it were complete', async () => {
    // A server that always says "more available" must not produce a silent partial.
    stub([{ status: 200, json: { success: true, results: [{ id: 1 }], moreDataAvailable: true, nextCursor: 'x' } }]);
    await assert.rejects(() => postAll('/application.list', {}, { cap: 3 }), /did not stop paginating/);
  });

  test('the envelope is available when a caller needs the pagination keys', async () => {
    stub([{ status: 200, json: { success: true, results: [1], moreDataAvailable: true, nextCursor: 'z' } }]);
    const env = await post('/application.list', {}, { envelope: true });
    assert.equal(env.nextCursor, 'z');
    assert.deepEqual(await post('/application.list', {}), [1], 'the default still unwraps');
  });
});
