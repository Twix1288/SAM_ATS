#!/usr/bin/env node
/**
 * Which job positions Sam is set up to grade, and who it has graded.
 *
 *   ASHBY_API_KEY=<key> node scripts/jobs.js            # status of every job
 *   ASHBY_API_KEY=<key> node scripts/jobs.js --enroll   # pull descriptions for postable jobs
 *   ASHBY_API_KEY=<key> node scripts/jobs.js --graded   # candidates carrying a Sam score
 *
 * A company connects Ashby and picks which jobs Sam should grade. Each of those needs its
 * description pulled once and stored; an application is then graded against the rubric for
 * ITS OWN job, resolved from `application.job.id` and never guessed.
 *
 * READ-ONLY. Enrolling stores descriptions in this process; it writes nothing to Ashby.
 *
 * ON FILTERING. Ashby's list endpoints do NOT filter on custom fields — `application.list`
 * accepts a `customFieldFilters` argument, returns success, and IGNORES it. Verified: an
 * impossible filter returns every row, and a wholly invented parameter also returns
 * success. So `--graded` pages the list and filters here. Recruiter-facing filtering is a
 * UI feature (Candidate Search advanced filters), not an API one.
 */
import { ENDPOINTS, SAM_CUSTOM_FIELDS } from '../shared/ashby-contract.js';
import { post } from '../sam-integration/endpoints/client.js';
import { pullJobDescriptions, descriptionFor } from '../sam-integration/services/jobDescriptions.js';
import { hasRubricFor } from '../sam-integration/services/rubrics.js';

const B = '\x1b[1m'; const G = '\x1b[32m'; const Y = '\x1b[33m'; const D = '\x1b[90m';
const C = '\x1b[36m'; const R = '\x1b[31m'; const O = '\x1b[0m';

const SAM_TITLES = new Set(Object.values(SAM_CUSTOM_FIELDS).map((f) => f.name));

/** Every page of a list endpoint. The sweep's own bug was stopping at the first one. */
async function listAll(endpoint, body = {}, cap = 20) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < cap; page++) {
    const res = await post(endpoint, { ...body, limit: 100, ...(cursor ? { cursor } : {}) }, { envelope: true });
    const rows = res?.results ?? res ?? [];
    out.push(...rows);
    if (!res?.moreDataAvailable || !res?.nextCursor) break;
    cursor = res.nextCursor;
  }
  return out;
}

const mode = process.argv.includes('--graded') ? 'graded'
  : process.argv.includes('--enroll') ? 'enroll' : 'status';

const jobs = await post(ENDPOINTS.listJobs, { limit: 100 });
const postings = await post(ENDPOINTS.listJobPostings, { limit: 100 });
const apps = await post(ENDPOINTS.listApplications, { limit: 100 });

const postedJobs = new Set(postings.map((p) => p.jobId));
const appsByJob = new Map();
for (const a of apps) {
  const id = a.job?.id;
  if (id) appsByJob.set(id, [...(appsByJob.get(id) ?? []), a]);
}

const samValues = (application) => {
  const found = (application.customFields ?? []).filter((f) => SAM_TITLES.has(f.title));
  const scored = found.filter((f) => f.value !== null && f.value !== undefined);
  return { found, scored, isGraded: scored.length > 0 };
};

if (mode === 'enroll') {
  const targets = jobs.filter((j) => postedJobs.has(j.id)).map((j) => j.id);
  console.log(`\n${B}Pulling descriptions for ${targets.length} postable jobs${O}\n`);
  const results = await pullJobDescriptions(targets);
  for (const r of results) {
    const title = jobs.find((j) => j.id === r.jobId)?.title ?? r.jobId;
    if (r.ok) console.log(`  ${G}stored${O}  ${title.padEnd(34)} ${D}${r.record.text.length} chars · v${r.record.version}${O}`);
    else console.log(`  ${R}refused${O} ${title.padEnd(34)} ${D}${r.why}${O}`);
  }
  const blocked = jobs.filter((j) => !postedJobs.has(j.id));
  if (blocked.length) {
    console.log(`\n  ${Y}Not enrollable${O} — no posting, so no description exists:`);
    for (const j of blocked) console.log(`    ${j.title} ${D}(${appsByJob.get(j.id)?.length ?? 0} applications)${O}`);
  }
  console.log();
}

if (mode === 'status') {
  console.log(`\n${B}Sam · job positions${O}\n`);
  console.log(`  ${D}${'JOB'.padEnd(34)}${'APPS'.padStart(5)}  ${'GRADED'.padStart(6)}  DESCRIPTION   RUBRIC${O}`);
  for (const j of jobs) {
    const mine = appsByJob.get(j.id) ?? [];
    const graded = mine.filter((a) => samValues(a).isGraded).length;
    const desc = descriptionFor(j.id) ? `${G}stored${O}  ` : postedJobs.has(j.id) ? `${Y}pullable${O}` : `${R}none${O}    `;
    const rub = hasRubricFor(j.id) ? `${G}yes${O}` : `${Y}awaiting Sam${O}`;
    console.log(`  ${j.title.padEnd(34)}${String(mine.length).padStart(5)}  ${String(graded).padStart(6)}  ${desc}      ${rub}`);
  }
  console.log(`\n  ${D}DESCRIPTION  what Sam compiles a rubric from — pulled from the job POSTING${O}`);
  console.log(`  ${D}RUBRIC       the compiled anchors. Owned by Sam's engine, not this repo.${O}`);
  console.log(`  ${D}A job with no posting has no description, so nobody applying to it can be graded.${O}\n`);
}

if (mode === 'graded') {
  console.log(`\n${B}Candidates carrying a Sam score${O}`);
  console.log(`${D}filtered here, not by Ashby — application.list ignores customFieldFilters${O}\n`);
  const rows = apps.map((a) => ({ a, ...samValues(a) })).filter((r) => r.isGraded);
  if (!rows.length) {
    console.log(`  none yet. ${D}Every delivery writes these four fields; none has run on this org.${O}\n`);
  } else {
    const val = (r, title) => r.found.find((f) => f.title === title)?.value ?? '—';
    console.log(`  ${D}${'CANDIDATE'.padEnd(24)}${'JOB'.padEnd(26)}${'FIT'.padStart(5)}${'COV'.padStart(5)}${'CAP'.padStart(5)}${O}`);
    for (const r of rows.sort((x, y) => (val(y, 'Sam Role Fit') || 0) - (val(x, 'Sam Role Fit') || 0))) {
      console.log(`  ${String(r.a.candidate?.name ?? '?').padEnd(24)}${String(r.a.job?.title ?? '?').slice(0, 24).padEnd(26)}`
        + `${String(val(r, 'Sam Role Fit')).padStart(5)}${String(val(r, 'Sam Evidence Coverage')).padStart(5)}`
        + `${String(val(r, 'Sam Capability Score')).padStart(5)}`);
    }
    console.log(`\n  ${rows.length} of ${apps.length} applications graded.\n`);
  }
}
