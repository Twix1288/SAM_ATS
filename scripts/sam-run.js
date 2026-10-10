#!/usr/bin/env node
/**
 * The whole loop, for real: Ashby → Sam → Ashby.
 *
 *   ASHBY_API_KEY=… ASHBY_LIVE=1 SAM_API_TOKEN=… node scripts/sam-run.js            # dry run
 *   … node scripts/sam-run.js --deliver                                             # writes
 *
 *   1. read which jobs the client ticked "Sam Grading" on
 *   2. register each with Sam — POST /api/v1/jobs — and show the anchors it derived
 *   3. gate every application locally (enrolled, active, not already delivered)
 *   4. fetch each survivor's résumé from Ashby
 *   5. POST /api/v1/snapshots/batch — ONE call per job, not per candidate
 *   6. poll until scored
 *   7. map Sam's payload and write four surfaces onto each Ashby record
 *
 * WHY IT POLLS. Sam returns results by callback, which is the right design and needs a
 * public HTTPS endpoint we do not have from a laptop. `GET /api/v1/snapshots/batch/{id}` is
 * the documented alternative and is what this uses. In production the callback replaces
 * steps 6 — see the note on duplicate callbacks in sam/client.js.
 *
 * COST DISCIPLINE. Scoring is the only thing here that costs money, so everything cheap
 * happens first: the gate refuses before a résumé is downloaded, and the ledger refuses
 * before the gate. A candidate already delivered never reaches Sam.
 */
import { syncEnrolmentFromAshby, pullJobDescription, descriptionFor } from '../sam-integration/services/jobDescriptions.js';
import { sweep, OUTCOME } from '../sam-integration/delivery/sweep.js';
import { deliverSnapshot } from '../sam-integration/delivery/pipeline.js';
import { snapshotFromSamPayload } from '../sam-integration/ingest/samPayload.js';
import { fetchCandidateDocuments, stitchSourcesFrom } from '../sam-integration/ingest/ashbyFile.js';
import { registerJob, submitBatch, submitOne, batchStatus } from '../sam-integration/sam/client.js';
import { post } from '../sam-integration/endpoints/client.js';
import { setSamScores } from '../sam-integration/endpoints/customField.setValue.js';
import { setJobSummary } from '../sam-integration/endpoints/job.setSummary.js';
import { cohortFor, MIN_COHORT } from '../sam-integration/delivery/cohort.js';
import { lookup, entriesForJob } from '../sam-integration/delivery/ledger.js';
import { collectReplies, replyCandidatesFrom, REPLY } from '../sam-integration/delivery/collectReplies.js';
import { readFileSync, existsSync } from 'node:fs';

const B = '\x1b[1m'; const G = '\x1b[32m'; const Y = '\x1b[33m'; const R = '\x1b[31m';
const D = '\x1b[90m'; const C = '\x1b[36m'; const O = '\x1b[0m';

const DELIVER = process.argv.includes('--deliver');
const COMPANY = process.env.SAM_COMPANY_ID ?? 'ashby-sandbox';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`\n${B}Sam · full run${O}  ${DELIVER ? `${R}WRITING TO REAL RECORDS${O}` : `${D}dry run${O}`}\n`);

// ── 1. what the client switched on ───────────────────────────────────────────
const enrolment = await syncEnrolmentFromAshby();
console.log(`${C}Enrolled${O}  ${D}${enrolment.enrolled.length} of ${enrolment.checked} jobs ticked in Ashby${O}`);

// ── 2. collect any answers people left since the last pass ───────────────────
//
// BEFORE the gate, and before every early exit below, which is the whole point. A pipeline
// in steady state has nobody new to score — everyone is delivered and this run stops at
// "nobody new to score". That is where a real client sits most days, and it is exactly when
// replies are arriving. Collecting further down would read answers only on the days new
// applicants happen to turn up.
//
// Costs one listNotes per graded candidate and writes nothing without --deliver.
const ledgerFile = process.env.SAM_LEDGER ?? '.sam/ledger.jsonl';
if (existsSync(ledgerFile)) {
  console.log(`\n${C}Answers left in Ashby${O}`);
  const replies = await collectReplies({
    rows: replyCandidatesFrom(readFileSync(ledgerFile, 'utf8')),
    write: DELIVER,
    onResult: (r) => {
      if (r.outcome === REPLY.waiting || r.outcome === REPLY.notAsked
        || r.outcome === REPLY.alreadyRecorded) return;
      const who = [r.reply?.by?.firstName, r.reply?.by?.lastName].filter(Boolean).join(' ') || 'a reviewer';
      if (r.outcome === REPLY.unparseable) {
        console.log(`  ${Y}${r.name.padEnd(22)}${O}${D}a reply that answers nothing — left open${O}`);
        return;
      }
      console.log(`  ${G}${r.name.padEnd(22)}${O}${who} answered ${r.resolved.length} of ${r.asked}`
        + `${r.outcome === REPLY.recorded ? '' : `${D} (dry run — not recorded)${O}`}`);
      for (const a of r.resolved) console.log(`      ${a.confirmed ? '✅' : '❌'} ${D}${a.label}${O}`);
    },
  });
  const nothing = !replies.recorded && !replies.read && !replies.unparseable;
  console.log(`  ${D}${nothing ? 'nothing new' : `${replies.recorded || replies.read} answered`}`
    + `${replies.waiting ? ` · ${replies.waiting} still waiting on a reply` : ''}${O}`);
}

// ── 3. register each job with Sam ────────────────────────────────────────────
console.log(`\n${C}Registering jobs with Sam${O}`);
const samJobs = new Map();
for (const jobId of enrolment.enrolled) {
  const d = await pullJobDescription(jobId);
  try {
    const reg = await registerJob({ ashbyJobId: jobId, companyId: COMPANY, title: d.jobTitle, description: d.text });
    samJobs.set(jobId, reg);
    console.log(`  ${G}${d.jobTitle.padEnd(34)}${O}${D}sam ${reg.job_id.slice(0, 8)} · ${reg.anchors.length} anchors${O}`);
    for (const a of reg.anchors) console.log(`      ${a.weight === 'core' ? `${B}core${O}` : `${D}supp${O}`} ${D}${a.anchor}${O}`);
  } catch (err) {
    // One job failing must not end the run. A transient DNS blip took down a whole pass
    // after another job had already registered — and the candidates on the jobs that DID
    // register were never scored, for a reason that had nothing to do with them.
    // An unregistered job simply has nobody gated into it below.
    console.log(`  ${R}${d.jobTitle.padEnd(34)}${O}${D}not registered — ${String(err.message).slice(0, 60)}${O}`);
  }
}
if (!samJobs.size) { console.log(`\n  ${R}No job could be registered with Sam. Nothing to do.${O}\n`); process.exit(1); }

// ── 4. gate, and 5. fetch résumés ────────────────────────────────────────────
console.log(`\n${C}Gating every application${O}`);
const queue = [];
const pass = await sweep({
  scoreAndDeliver: async ({ application, jobId }) => {
    if (!samJobs.has(jobId)) throw new Error('its job is not registered with Sam this run');
    const candidate = await post('/candidate.info', { id: application.candidate.id });
    const docs = await fetchCandidateDocuments(candidate);       // refuses anyone with no résumé
    queue.push({ application, jobId, candidate, docs });
    return { outcome: 'queued-for-sam' };
  },
  onCandidate: (r) => {
    if (r.outcome === OUTCOME.notActive || r.outcome === OUTCOME.notEnrolled) return;
    const mark = r.outcome === OUTCOME.delivered ? `${G}queue ${O}`
      : r.outcome === OUTCOME.alreadyDelivered ? `${D}done  ${O}`
        : r.outcome === OUTCOME.failed ? `${R}FAIL  ${O}` : `${Y}${r.outcome.slice(0, 6)}${O}`;
    console.log(`  ${mark}  ${(r.candidateName ?? '?').padEnd(22)}${D}${(r.jobTitle ?? '').slice(0, 34)}${r.detail ? ` · ${r.detail.slice(0, 40)}` : ''}${O}`);
  },
});
console.log(`  ${D}${pass.seen} seen · ${pass.notActive} not active · ${pass.notEnrolled} not enrolled · ${pass.alreadyDelivered} already done${O}`);

if (!queue.length) { console.log(`\n  ${Y}nobody new to score.${O}\n`); process.exit(0); }
if (!DELIVER) {
  console.log(`\n  ${D}dry run — ${queue.length} would go to Sam. Re-run with --deliver.${O}\n`);
  process.exit(0);
}

/**
 * `--sync` scores one applicant at a time through POST /api/v1/snapshots, which returns the
 * finished snapshot IN THE RESPONSE — no batch id, no polling, no callback.
 *
 * Slower per candidate and far simpler, and it is the only path that completes without a
 * public callback endpoint. The batch path stays the production design; this is what makes a
 * laptop run, and a demo, possible.
 */
const SYNC = process.argv.includes('--sync');
const scored = new Map();   // jobId -> Sam's cohort_findings, collected as we go
if (SYNC) {
  console.log(`\n${C}Scoring${O}  ${D}one at a time, synchronously${O}`);
  for (const item of queue) {
    const samJobId = samJobs.get(item.jobId).job_id;
    const d = descriptionFor(item.jobId);
    let sam;
    try {
      const res = await submitOne({
        samJobId,
        applicant: {
          source_person_id: item.candidate.id,
          person_name: item.candidate.name,
          resume_pdf_base64: item.docs.resume.bytes.toString('base64'),
        },
      });
      sam = res.snapshot ?? res;
      if (sam.cohort_findings?.length) scored.set(item.jobId, sam.cohort_findings);
    } catch (err) {
      console.log(`  ${R}failed${O}  ${item.candidate.name.padEnd(22)}${D}${String(err.message).slice(0, 70)}${O}`);
      continue;
    }

    const snapshot = snapshotFromSamPayload(sam, {
      candidate: item.candidate,
      job: { title: d.jobTitle, company: null },
      applicationId: item.application.id,
    });

    const out = await deliverSnapshot({
      snapshot,
      response: { name: item.candidate.name, answeredCount: null },
      candidateId: item.candidate.id,
      applicationId: item.application.id,
      deliveryId: `sam-${item.application.id.slice(0, 8)}`,
      dossierBase: 'https://app.launchsam.com/snapshot',
      rubric: { jobId: item.jobId, jobTitle: d.jobTitle },
      descriptionVersion: d.version,
      documents: stitchSourcesFrom(item.docs),
    });

    const fit = snapshot.scoreIsPublishable ? `${Math.round(snapshot.roleFit * 100)}%` : 'withheld';
    console.log(`  ${out.complete ? `${G}done  ${O}` : `${Y}partial${O}`}  ${item.candidate.name.padEnd(22)}`
      + `${D}${d.jobTitle.slice(0, 30).padEnd(32)}${fit} · ${snapshot.anchorSummary.met + snapshot.anchorSummary.metEquivalent} of ${snapshot.anchorSummary.total} anchors · ${snapshot.band}${O}`);
  }
  // ── cohort, computed from the ledger rather than taken from Sam ────────────
  // Sam's rank is fixed at score time; ours is recomputed every pass, so it stays true as
  // more people apply. Run after every delivery, when the pool is complete.
  console.log(`\n${C}Cohort${O}  ${D}ranked from our ledger, so earlier candidates stay current${O}`);
  const at = new Date().toISOString();
  for (const jobId of new Set(queue.map((q) => q.jobId))) {
    const entries = entriesForJob(jobId);
    const { ranked, size } = cohortFor(entries);
    const title = descriptionFor(jobId)?.jobTitle ?? jobId.slice(0, 8);

    for (const [candidateId, pool] of ranked) {
      const entry = lookup(candidateId, jobId);
      if (!entry?.snapshot) continue;
      await setSamScores({
        applicationId: entry.applicationId,
        snapshot: { ...entry.snapshot, pool: { roleFitRank: pool.rank, size: pool.size, topPercent: pool.topPercent } },
        deliveryId: `rank-${candidateId.slice(0, 8)}`,
      });
    }
    console.log(ranked.size
      ? `  ${G}${title}${O} ${D}${ranked.size} ranked${O}`
      : `  ${D}${title}: ${size} comparable — below the ${MIN_COHORT} needed for a rank to mean anything${O}`);

    // Sam's finding about the pool goes on the job, once.
    const findings = scored.get(jobId) ?? [];
    const summary = await setJobSummary({ jobId, entries, at, cohortFindings: findings });
    console.log(summary.ok
      ? `  ${D}  → job page: ${summary.graded} graded · median ${summary.medianRoleFit ?? '—'}`
        + `${findings.length ? ` · finding: "${String(findings[0].finding).slice(0, 60)}…"` : ''}${O}`
      : `  ${Y}  → job summary not written: ${summary.detail}${O}`);
  }

  console.log();
  process.exit(0);
}

// ── 6. one batch per job ─────────────────────────────────────────────────────
console.log(`\n${C}Sending to Sam${O}  ${D}one batch per job, not one call per candidate${O}`);
const byJob = new Map();
for (const item of queue) byJob.set(item.jobId, [...(byJob.get(item.jobId) ?? []), item]);

const batches = [];
for (const [jobId, items] of byJob) {
  const samJobId = samJobs.get(jobId).job_id;
  const applicants = items.map((i) => ({
    source_person_id: i.candidate.id,
    person_name: i.candidate.name,
    resume_pdf_base64: i.docs.resume.bytes.toString('base64'),
  }));
  const res = await submitBatch({ samJobId, applicants });
  const batchId = res.batch_id ?? res.id;
  batches.push({ jobId, batchId, items });
  console.log(`  ${G}sent${O}  ${descriptionFor(jobId)?.jobTitle?.padEnd(34) ?? jobId}${D}${applicants.length} applicants · batch ${String(batchId).slice(0, 8)}${O}`);
}

// ── 7. poll ──────────────────────────────────────────────────────────────────
console.log(`\n${C}Waiting for Sam${O}  ${D}scoring takes a few minutes${O}`);
const results = new Map();
/**
 * Poll every batch CONCURRENTLY, not one after another.
 *
 * Sequential polling made the last batch wait out the first one's entire timeout before it
 * was looked at even once — three batches at ten minutes each is half an hour to discover
 * that none of them finished. They are independent; wait on them together.
 *
 * DONE IS `completed_at` OR A TERMINAL `status`, NOT "an array came back". The first version
 * treated `Array.isArray(st.snapshots)` as done, and the status response has no results array
 * at all — so an absent field read as an empty result and a running batch was reported as
 * "scored · 0 snapshots". Progress now comes from `applicants_completed / applicants_total`,
 * which is what the endpoint actually reports.
 */
const TERMINAL = new Set(['complete', 'completed', 'failed', 'error', 'cancelled']);

/**
 * The scored snapshots out of a batch status body, whatever shape it arrives in.
 *
 * Per-applicant failures are REPORTED, not silently dropped: a résumé Sam could not read is
 * a candidate who will never be scored, and the only thing worse than that is nobody
 * noticing. Each one is logged with its own reason and simply yields no snapshot.
 */
function pluckSnapshots(st) {
  const perApplicant = st.applicant_results ?? st.applicants ?? null;
  if (Array.isArray(perApplicant)) {
    const ok = [];
    for (const r of perApplicant) {
      const snap = r.snapshot ?? (r.match ? r : null);
      if (snap) { ok.push(snap); continue; }
      const why = r.error ?? r.status ?? 'no snapshot returned';
      console.log(`  ${Y}  · ${r.person_name ?? r.source_person_id ?? '?'} not scored — ${String(why).slice(0, 70)}${O}`);
    }
    return ok;
  }
  return st.snapshots ?? st.results ?? null;
}
const POLL_MS = Number(process.env.SAM_POLL_MS ?? 20_000);
const POLL_BUDGET_MS = Number(process.env.SAM_POLL_BUDGET_MS ?? 15 * 60_000);

await Promise.all(batches.map(async (b) => {
  const short = String(b.batchId).slice(0, 8);
  const deadline = Date.now() + POLL_BUDGET_MS;
  let lastSeen = null;
  let lastDone = null;

  while (Date.now() < deadline) {
    const st = await batchStatus(b.batchId);
    const done = TERMINAL.has(String(st.status)) || Boolean(st.completed_at);

    if (st.status !== lastSeen || st.applicants_completed !== lastDone) {
      lastSeen = st.status; lastDone = st.applicants_completed;
      const skipped = st.applicants_skipped ? ` · ${st.applicants_skipped} skipped` : '';
      console.log(`  ${D}${short} · ${st.status} · ${st.applicants_completed ?? 0}/${st.applicants_total ?? '?'} scored${skipped}${O}`);
    }

    if (done) {
      if (st.error) { console.log(`  ${R}${short} failed${O} ${D}${st.error}${O}`); return; }
      // Results are not in the status body. Sam delivers them by callback; ask for them
      // explicitly here, and say plainly if that is not something this endpoint offers.
      // `applicant_results` is where the per-applicant outcome lives — each carries its own
      // status and error, so one unreadable résumé no longer stalls the batch or takes the
      // others down with it. Older shapes kept as fallbacks.
      const rows = pluckSnapshots(st);
      if (Array.isArray(rows) && rows.length) {
        results.set(b.batchId, rows);
        console.log(`  ${G}${short} scored${O} ${D}${rows.length} snapshots${O}`);
      } else {
        console.log(`  ${Y}${short} complete, but the status body carries no snapshots${O}`);
        console.log(`  ${D}   → results come by callback. Set SAM_CALLBACK_URL and expose sam-callback.js.${O}`);
      }
      return;
    }
    await sleep(POLL_MS);
  }
  console.log(`  ${R}${short} still ${lastSeen} after ${Math.round(POLL_BUDGET_MS / 60000)}m${O} ${D}— scoring is slower than a laptop should wait for; use the callback${O}`);
}));

// ── 8. write onto the Ashby records ──────────────────────────────────────────
console.log(`\n${C}Writing to Ashby${O}`);
for (const b of batches) {
  const rows = results.get(b.batchId) ?? [];
  for (const item of b.items) {
    const sam = rows.find((r) => r.source_person_id === item.candidate.id || r.person_id === item.candidate.id);
    if (!sam) { console.log(`  ${Y}no result${O} ${item.candidate.name}`); continue; }

    const d = descriptionFor(item.jobId);
    const snapshot = snapshotFromSamPayload(sam, {
      candidate: item.candidate,
      job: { title: d.jobTitle, company: null },
      applicationId: item.application.id,
    });

    const out = await deliverSnapshot({
      snapshot,
      response: { name: item.candidate.name, answeredCount: null },
      candidateId: item.candidate.id,
      applicationId: item.application.id,
      deliveryId: `sam-${item.application.id.slice(0, 8)}`,
      dossierBase: 'https://app.launchsam.com/snapshot',
      rubric: { jobId: item.jobId, jobTitle: d.jobTitle },
      descriptionVersion: d.version,
      documents: stitchSourcesFrom(item.docs),
    });

    const fit = snapshot.scoreIsPublishable ? `${Math.round(snapshot.roleFit * 100)}%` : 'withheld';
    console.log(`  ${out.complete ? G + 'done  ' : Y + 'partial'}${O}  ${item.candidate.name.padEnd(22)}`
      + `${D}${fit} · ${snapshot.anchorSummary.met + snapshot.anchorSummary.metEquivalent} of ${snapshot.anchorSummary.total} anchors · ${snapshot.band}${O}`);
  }
}
console.log();
