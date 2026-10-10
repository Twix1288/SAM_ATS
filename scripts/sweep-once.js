#!/usr/bin/env node
/**
 * One live pass against a real Ashby org. The production entry point.
 *
 *   ASHBY_API_KEY=<key> ASHBY_LIVE=1 node scripts/sweep-once.js            # dry run
 *   ASHBY_API_KEY=<key> ASHBY_LIVE=1 node scripts/sweep-once.js --deliver  # writes
 *
 * Dry run is the default ON PURPOSE. This writes to real candidate records — a note in the
 * feed, a PDF in their files, four fields and a tag — and none of that is undone by running
 * it again. Seeing exactly who would be touched, before touching them, is the whole point.
 *
 * WHAT IT DOES
 *   1. reads which jobs the client ticked "Sam Grading" on, inside Ashby
 *   2. pulls the description for each, once
 *   3. lists every application, paging to exhaustion
 *   4. gates each row locally — enrolled, active, not already delivered
 *   5. grades and delivers whoever is left
 *
 * THE ENGINE IS A STAND-IN. Sam's engine does not exist yet, so `--deliver` builds a
 * placeholder payload marked as such on the document itself. It exercises every line of the
 * delivery path — contract validation, the PDF, the note, the four fields, the tag — and it
 * does not grade anybody. Grading is Sam's, and nothing here should ever start doing it.
 */
import { syncEnrolmentFromAshby, pullJobDescription, descriptionFor, provisionCustomFields } from '../sam-integration/services/jobDescriptions.js';
import { sweep, OUTCOME } from '../sam-integration/delivery/sweep.js';
import { deliverSnapshot } from '../sam-integration/delivery/pipeline.js';
import { snapshotFromEnginePayload } from '../sam-integration/ingest/enginePayload.js';
import { fetchCandidateDocuments, stitchSourcesFrom } from '../sam-integration/ingest/ashbyFile.js';
import { post } from '../sam-integration/endpoints/client.js';
import { setJobSummary } from '../sam-integration/endpoints/job.setSummary.js';
import { addToSamProject } from '../sam-integration/endpoints/candidate.addProject.js';
import { setSamScores } from '../sam-integration/endpoints/customField.setValue.js';
import { cohortFor, MIN_COHORT } from '../sam-integration/delivery/cohort.js';
import { lookup, lookupAll, entriesForJob } from '../sam-integration/delivery/ledger.js';
import { openSync, closeSync, unlinkSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const B = '\x1b[1m'; const G = '\x1b[32m'; const Y = '\x1b[33m'; const R = '\x1b[31m';
const D = '\x1b[90m'; const C = '\x1b[36m'; const O = '\x1b[0m';

const DELIVER = process.argv.includes('--deliver');
const PROVISION = process.argv.includes('--provision');

/**
 * One pass at a time, across PROCESSES.
 *
 * The ledger's in-memory claim closes the window between checking and writing inside one
 * run. It cannot see a second `npm run sweep`, or a cron tick that fires while the last one
 * is still going — and both of those read the same ledger, both find the candidate
 * undelivered, and both deliver. A duplicate note on a real person's record is the result.
 *
 * `wx` is the whole mechanism: the open fails if the file exists, atomically, which is
 * exactly the primitive a lock needs. A stale lock from a killed process is detected by
 * checking whether its pid is still alive, because a crash that permanently wedges every
 * future run is worse than the duplicate this prevents.
 */
const LOCK = process.env.SAM_LOCK ?? '.sam/sweep.lock';
function acquireLock() {
  mkdirSync('.sam', { recursive: true });
  try {
    const fd = openSync(LOCK, 'wx');
    writeFileSync(LOCK, String(process.pid));
    closeSync(fd);
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const holder = Number(readFileSync(LOCK, 'utf8').trim());
    try {
      process.kill(holder, 0);            // signal 0 tests liveness, sends nothing
      return false;                       // genuinely still running
    } catch {
      unlinkSync(LOCK);                   // the holder is gone; take it over
      return acquireLock();
    }
  }
}

if (!acquireLock()) {
  console.error(`\n  ${R}Another pass is already running${O} ${D}(${LOCK}). Nothing done.${O}\n`);
  process.exit(0);
}
process.on('exit', () => { try { unlinkSync(LOCK); } catch { /* already gone */ } });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(1));

console.log(`\n${B}Sam · one pass${O}  ${DELIVER ? `${R}WRITING TO REAL RECORDS${O}` : `${D}dry run — nothing will be written${O}`}\n`);

if (PROVISION) {
  console.log(`${C}Provisioning${O}  ${D}the client's entire setup is handing over an API key${O}`);
  const provisioned = await provisionCustomFields();
  for (const f of provisioned) {
    const mark = f.status === 'created' ? `${G}created${O}` : f.status === 'exists' ? `${D}exists ${O}` : `${R}${f.status}${O}`;
    console.log(`  ${mark}  ${f.title.padEnd(24)} ${D}${f.fieldType} on ${f.objectType}${O}`);
  }

  // A FIELD CREATED SECONDS AGO CANNOT BE WRITTEN TO YET.
  //
  // Verified: delivering in the same run as the provisioning failed every setValues call
  // with `custom_field_not_found_on_object`, and the identical run a minute later worked.
  // Ashby's custom fields are eventually consistent — the same behaviour the job-level
  // enrolment tick shows, where an immediate read-back returns nothing.
  //
  // Refusing is much better than retrying here. The failure lands mid-delivery, after the
  // Snapshot has been rendered and possibly attached, so it produces exactly the partial
  // records this system works hardest to avoid.
  const fresh = provisioned.filter((f) => f.status === 'created');
  if (fresh.length && DELIVER) {
    console.log(`\n  ${Y}${fresh.length} fields were just created.${O} ${D}Ashby needs a moment before values `
      + `can be written to them — delivering now fails every write with custom_field_not_found_on_object.${O}`);
    console.log(`  ${D}Run again without --provision in a minute.${O}\n`);
    process.exit(0);
  }
  console.log();
}

// ── 1. what the client switched on, in Ashby ─────────────────────────────────
console.log(`${C}Enrolled jobs${O}  ${D}read from the "Sam Grading" tick on each job${O}`);
const enrolment = await syncEnrolmentFromAshby();
if (!enrolment.field) {
  console.log(`  ${R}no "Sam Grading" field in this org${O} — run with --provision first\n`);
  process.exit(1);
}
if (!enrolment.enrolled.length) {
  console.log(`  ${Y}none of ${enrolment.checked} jobs is switched on${O}`);
  console.log(`  ${D}tick "Sam Grading" on a job in Ashby, then run again${O}\n`);
  process.exit(0);
}

// ── 2. the description each rubric is compiled from ──────────────────────────
for (const jobId of enrolment.enrolled) {
  try {
    const d = await pullJobDescription(jobId);
    console.log(`  ${G}on${O}  ${d.jobTitle.padEnd(26)} ${D}${d.text.length} chars · v${d.version} · ${d.droppedBoilerplate} boilerplate dropped${O}`);
  } catch (err) {
    console.log(`  ${R}on${O}  ${D}${jobId.slice(0, 8)} — ${err.message.slice(0, 70)}${O}`);
  }
}

// ── 3-5. the pass ────────────────────────────────────────────────────────────
console.log(`\n${C}Every application${O}  ${D}listed in full, then gated one row at a time${O}`);

const MARK = {
  [OUTCOME.delivered]: `${G}deliver${O}`,
  [OUTCOME.resumed]: `${G}resume ${O}`,
  [OUTCOME.alreadyDelivered]: `${D}done   ${O}`,
  [OUTCOME.notEnrolled]: `${D}skip   ${O}`,
  [OUTCOME.noDescription]: `${Y}no jd  ${O}`,
  [OUTCOME.notActive]: `${D}closed ${O}`,
  [OUTCOME.noCandidate]: `${Y}orphan ${O}`,
  [OUTCOME.failed]: `${R}FAILED ${O}`,
  [OUTCOME.exhausted]: `${R}STUCK  ${O}`,
};

const shown = { [OUTCOME.notEnrolled]: 0, [OUTCOME.notActive]: 0 };
const QUIET = new Set([OUTCOME.notEnrolled, OUTCOME.notActive]);

const pass = await sweep({
  scoreAndDeliver: DELIVER ? deliverOne : async () => ({ outcome: 'would-deliver' }),
  onCandidate: (r) => {
    // The two bulk refusals are counted, not listed: 37 lines of "closed" would bury the
    // three rows anybody is reading this for.
    if (QUIET.has(r.outcome)) { shown[r.outcome]++; return; }
    const who = (r.candidateName ?? r.candidateId ?? '?').slice(0, 24).padEnd(26);
    const job = (r.jobTitle ?? '').slice(0, 22).padEnd(24);
    console.log(`  ${MARK[r.outcome] ?? r.outcome}  ${who}${D}${job}${r.detail ? r.detail.slice(0, 40) : ''}${O}`);
  },
});

for (const [outcome, n] of Object.entries(shown)) {
  if (n) console.log(`  ${MARK[outcome]}  ${D}${n} ${outcome === OUTCOME.notActive ? 'archived or closed' : 'on jobs nobody enrolled'}${O}`);
}

// ── 6. cohort + job summary ──────────────────────────────────────────────────
// Only now, with every delivery in the ledger, does a rank mean anything. Rank is ORDERING
// numbers the engine already decided — presentation, not judgement — and it is the one
// field that stayed permanently null while the ledger lived in memory.
if (DELIVER) {
  const at = new Date().toISOString();
  console.log(`\n${C}Cohort${O}  ${D}rank is computed once everyone is in, never during a delivery${O}`);

  for (const jobId of enrolment.enrolled) {
    const entries = entriesForJob(jobId);
    const { ranked, size } = cohortFor(entries);
    const title = descriptionFor(jobId)?.jobTitle ?? jobId.slice(0, 8);

    if (!ranked.size) {
      console.log(`  ${D}${title}: ${size} comparable — need ${MIN_COHORT} before a rank means anything${O}`);
    } else {
      for (const [candidateId, pool] of ranked) {
        const entry = lookup(candidateId, jobId);
        if (!entry?.snapshot) continue;
        // Re-writes ONLY the four scoring fields, with pool filled in. The note and the
        // document are untouched — a rank changing must not repost anything to the feed.
        await setSamScores({
          applicationId: entry.applicationId,
          snapshot: { ...entry.snapshot, pool: { roleFitRank: pool.rank, size: pool.size, topPercent: pool.topPercent } },
          deliveryId: `rank-${candidateId.slice(0, 8)}`,
        });
      }
      console.log(`  ${G}${title}${O}  ${D}${ranked.size} ranked${O}`);
    }

    // BACKFILL INTO THE PROJECT.
    //
    // The per-delivery step only fires for candidates delivered in THIS pass. Anyone graded
    // before the client created the project — or before project support existed — is marked
    // done in the ledger and skipped for good, so they would never appear in the very list
    // the project exists to provide. Re-asserting membership here costs one call each and is
    // idempotent, which makes "the project is complete" true rather than true-since-Tuesday.
    let added = 0;
    for (const entry of entries) {
      if (entry.failed || !entry.snapshot) continue;
      const r = await addToSamProject({ candidateId: entry.candidateId });
      if (r.ok) added++;
      else if (r.skipped) break;              // no project in this org; stop asking
    }
    if (added) console.log(`  ${D}  → ${added} in the Sam project — sortable by Role Fit there${O}`);

    const summary = await setJobSummary({ jobId, entries, at });
    console.log(summary.ok
      ? `  ${D}  → job page: ${summary.graded} graded · median fit ${summary.medianRoleFit ?? '—'} · last run now${O}`
      : `  ${Y}  → job summary not written: ${summary.detail}${O}`);
  }
}

console.log(`\n${C}Result${O}`);
console.log(`  ${pass.seen} applications seen`);
console.log(`  ${pass.delivered} delivered · ${pass.resumed} resumed · ${pass.alreadyDelivered} already done · ${pass.failed} failed`);
console.log(`  ${pass.notActive} not active · ${pass.notEnrolled} not enrolled · ${pass.noDescription} no description`);
if (pass.exhausted) console.log(`  ${R}${pass.exhausted} stuck${O} ${D}— failed too many times, no longer retried. Needs a person.${O}`);
if (pass.drifted) console.log(`  ${Y}${pass.drifted} graded against an older job description${O} ${D}— the posting was edited since.${O}`);
if (!DELIVER) console.log(`\n  ${D}dry run. Re-run with --deliver to write these to Ashby.${O}`);
console.log();

/**
 * Grades one candidate and puts the Snapshot on their record.
 *
 * The payload below is a PLACEHOLDER and says so on the document. When Sam's engine lands,
 * this function POSTs the job brief and the résumé to it and passes the reply through
 * `snapshotFromEnginePayload` unchanged — that is the only line that changes.
 */
async function deliverOne({ application, jobId, description }) {
  const candidate = await post('/candidate.info', { id: application.candidate.id });

  // Refuses a candidate with nothing to read, rather than grading an empty document.
  const docs = await fetchCandidateDocuments(candidate);

  const payload = placeholderPayload({ candidate, application, jobId, description, docs });
  const snapshot = snapshotFromEnginePayload(payload, {
    candidate,
    job: { title: description.jobTitle, company: null },
    pool: null,
  });

  return deliverSnapshot({
    snapshot,
    response: { name: candidate.name, answeredCount: null },
    candidateId: candidate.id,
    applicationId: application.id,
    deliveryId: `sweep-${application.id.slice(0, 8)}`,
    dossierBase: process.env.SAM_DOSSIER_BASE ?? 'https://example.invalid/sam',
    rubric: { jobId, jobTitle: description.jobTitle },
    // Their own résumé, fetched from Ashby, bound in behind the Snapshot so the judgement
    // and the document it was read from travel as one file.
    documents: stitchSourcesFrom(docs),
    // Stamped so a later pass can tell this score was written against THIS wording.
    descriptionVersion: description.version,
    onStage: (s) => console.log(`        ${s.ok ? G + '·' : R + '×'}${O} ${D}${s.label}: ${s.detail ?? ''}${O}`),
  });
}

/** Everything here is marked as a placeholder, on the record, in two places. */
function placeholderPayload({ candidate, application, jobId, description, docs }) {
  const PLACEHOLDER = 'PLACEHOLDER — Sam’s engine has not scored this candidate. '
    + 'This document demonstrates the delivery path only.';
  return {
    schemaVersion: '1.0',
    scoreId: `placeholder_${application.id.slice(0, 8)}`,
    scoredAt: new Date().toISOString(),
    engine: { version: 'not-yet-live', rubricId: jobId, rubricVersion: '0', rubricSource: `Ashby posting v${description.version}` },
    subject: { ashbyCandidateId: candidate.id, ashbyApplicationId: application.id, ashbyJobId: jobId },
    inputs: {
      read: ['résumé'],
      resume: { fileHandleId: candidate.resumeFileHandle?.id ?? null, filename: docs.resume.filename },
      jobDescription: { storedAt: description.fetchedAt, version: description.version },
      answeredCount: null,
      audio: [],
    },
    scores: {
      roleFit: 0, coverage: 0, band: 'Not scored',
      capability: 0, capabilityRaw: 0,
      capabilitySignals: { met: [], missing: [] },
    },
    anchors: [{
      id: 'PLACEHOLDER',
      label: 'Awaiting Sam’s engine',
      detail: description.jobTitle,
      weight: 1,
      state: 'NOT_COLLECTED',
      reason: PLACEHOLDER,
      evidence: [],
    }],
    narrative: { netRead: PLACEHOLDER, recommendedNextStep: 'None — this is not an assessment.', caveats: [PLACEHOLDER], gapsToInvestigate: null },
    profile: {
      careerHistory: { roles: [], source: docs.resume.filename, note: 'Not parsed — the engine reads the résumé.' },
      additionalSkills: [], experienceMatch: null, responsibilityMatch: null, roleLevelFit: null,
    },
  };
}
