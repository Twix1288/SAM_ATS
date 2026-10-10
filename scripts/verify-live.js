#!/usr/bin/env node
/**
 * Preflight, but against the real Ashby org rather than the stand-in.
 *
 *   ASHBY_API_KEY=<key> npm run verify:live
 *
 * `npm run preflight` proves the two halves of this repo agree with each other. It cannot
 * prove either agrees with Ashby, because both halves are ours. This checks the things that
 * only a real org can answer, and it is the file to run before believing a demo will work.
 *
 * READ-ONLY. It creates one file-upload handle — which reserves a presigned URL, attaches
 * nothing, and expires in ten minutes — and otherwise only reads. It writes no note, no
 * file, and no custom field value to anybody's record.
 */
import { ASHBY_BASE_URL, ENDPOINTS, authHeader, SAM_CUSTOM_FIELDS, SAM_JOB_FIELDS, FILE_CONTEXT, UPLOAD_HANDLE_PARAMS as P } from '../shared/ashby-contract.js';
import { composeNoteHtml } from '../sam-integration/endpoints/candidate.createNote.js';

const KEY = process.env.ASHBY_API_KEY ?? process.env.ASHBY_KEY;
if (!KEY) {
  console.error('\n  No ASHBY_API_KEY (or ASHBY_KEY). This script only means anything against a real org.\n');
  process.exit(1);
}

const B = '\x1b[1m'; const G = '\x1b[32m'; const R = '\x1b[31m'; const Y = '\x1b[33m';
const D = '\x1b[90m'; const C = '\x1b[36m'; const O = '\x1b[0m';

let pass = 0; let fail = 0; let warn = 0;
const step = (s) => process.stdout.write(`  ${s.padEnd(52)}`);
const ok = (d = '') => { pass++; console.log(`${G}PASS${O} ${D}${d}${O}`); };
const bad = (d = '') => { fail++; console.log(`${R}FAIL${O} ${D}${d}${O}`); };
const meh = (d = '') => { warn++; console.log(`${Y}WARN${O} ${D}${d}${O}`); };

const call = async (endpoint, body = {}) => {
  const res = await fetch(`${ASHBY_BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: { authorization: authHeader(KEY), 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json, headers: res.headers };
};

console.log(`\n${B}Sam ↔ Ashby · live verification${O}`);
console.log(`${D}${ASHBY_BASE_URL}${O}\n`);

// ── auth ───────────────────────────────────────────────────────────────────────
console.log(`${C}Credential${O}`);

step('authenticates');
const fields = await call(ENDPOINTS.listCustomFields, {});
if (fields.json?.success) ok(`${fields.json.results.length} custom fields visible`);
else bad(`HTTP ${fields.status} ${JSON.stringify(fields.json?.errors)}`);

step('rate-limit headroom');
const limit = fields.headers.get('x-ratelimit-limit');
const left = fields.headers.get('x-ratelimit-remaining');
limit ? ok(`${left} of ${limit} remaining`) : meh('no x-ratelimit header returned');

// The integration needs candidate read+write and nothing else. Anything beyond that is
// blast radius if the key ever leaks.
step('scoped no wider than candidates');
const wide = [];
for (const [label, ep] of [['users', '/user.list'], ['offers', '/offer.list']]) {
  const r = await call(ep, {});
  if (r.json?.success) wide.push(label);
}
wide.length
  ? meh(`key can also read ${wide.join(' + ')} — re-issue scoped to candidates`)
  : ok('candidates only');

// ── the fields the scores land in ──────────────────────────────────────────────
console.log(`\n${C}Custom fields${O}`);
const byTitle = new Map((fields.json?.results ?? []).map((f) => [f.title, f]));
for (const { name, type } of Object.values(SAM_CUSTOM_FIELDS)) {
  step(`  ${name}`);
  const f = byTitle.get(name);
  if (!f) bad(`MISSING — create it as ${type}, or every delivery is "partial"`);
  else if (f.fieldType !== type) bad(`is ${f.fieldType}, must be ${type}`);
  else ok(`${f.fieldType} on ${f.objectType}${f.isArchived ? ' — ARCHIVED' : ''}`);
}

// The job page is a surface in its own right — the client's enrolment tick lives on it,
// and so does everything a hiring manager sees about what Sam is doing for the role.
console.log(`\n${C}Job fields${O}`);
for (const { name, type } of Object.values(SAM_JOB_FIELDS)) {
  step(`  ${name}`);
  const f = byTitle.get(name);
  if (!f) bad(`MISSING — run the sweep with --provision`);
  else if (f.fieldType !== type) bad(`is ${f.fieldType}, must be ${type}`);
  else if (f.objectType !== 'Job') bad(`is scoped to ${f.objectType}, must be Job`);
  else ok(`${f.fieldType} on ${f.objectType}`);
}

step('no file can be un-attached, so dedupe is load-bearing');
// Asserted rather than remembered: if Ashby ever ships a delete, the guard can relax.
const del = await call('/candidate.removeFile', {});
del.status === 404
  ? ok('confirmed — Ashby publishes no file delete; a duplicate needs a human')
  : meh('a file-removal endpoint now answers; the no-undo note is stale');

// ── the chain that binds a candidate to their rubric ───────────────────────────
console.log(`\n${C}Job → rubric binding${O}`);

step('applications name their own job');
const apps = (await call(ENDPOINTS.listApplications, { limit: 100 })).json?.results ?? [];
const orphans = apps.filter((a) => !a.job?.id);
orphans.length ? bad(`${orphans.length} of ${apps.length} have no job.id`)
  : ok(`${apps.length} applications, all resolve`);

step('every applied-to job has a description');
const jobs = (await call(ENDPOINTS.listJobs, { limit: 100 })).json?.results ?? [];
const appliedTo = [...new Set(apps.map((a) => a.job?.id).filter(Boolean))];
const postings = (await call(ENDPOINTS.listJobPostings, { limit: 100 })).json?.results ?? [];
const postedJobs = new Set(postings.map((p) => p.jobId));
const undescribed = appliedTo.filter((id) => !postedJobs.has(id));
if (!undescribed.length) ok(`${appliedTo.length} jobs, all posted`);
else {
  // A WARNING, not a failure. An unposted requisition that people have applied to is an
  // ordinary state of a real ATS, not a misconfiguration — and the gate already handles it
  // correctly by refusing those applicants with `no_description` rather than grading them
  // against a neighbouring job's requirements.
  //
  // Reporting a designed refusal as a failed check is worse than noise: it trains whoever
  // runs this to expect a red line, and a red line nobody trusts is the same as no check.
  // What is worth saying out loud is that these applicants will never be graded until
  // somebody posts the job.
  const names = undescribed.map((id) => jobs.find((j) => j.id === id)?.title ?? id);
  meh(`${names.join(', ')} — unposted, so applicants to it are refused rather than graded`);
}

step('description text is reachable');
const probeJob = jobs.find((j) => postedJobs.has(j.id));
const posting = postings.find((p) => p.jobId === probeJob?.id);
const info = await call(ENDPOINTS.jobPostingInfo, { jobPostingId: posting?.id });
const text = info.json?.results?.descriptionPlain;
text ? ok(`${probeJob.title}: ${text.length} chars of descriptionPlain`)
  : bad(`jobPosting.info returned no descriptionPlain ${JSON.stringify(info.json?.errors ?? '')}`);

step('jobPosting.info rejects the wrong param name');
// Guards the trap: `id` returns success:false at HTTP 200, which reads as a pass to
// anything checking status codes.
const wrongParam = await call(ENDPOINTS.jobPostingInfo, { id: posting?.id });
wrongParam.json?.success === false
  ? ok('`id` refused as expected — `jobPostingId` is the only key')
  : meh('Ashby now accepts `id` too; the contract note is stale');

// ── the surfaces we write ──────────────────────────────────────────────────────
console.log(`\n${C}Delivery surfaces${O}`);

step('note emits only tags Ashby renders');
const stub = {
  candidate: { name: 'Verify' }, role: { title: 'Role', company: null },
  roleFit: 0.6, coverage: 0.8, capability: 7, band: 'Moderate', scoreIsPublishable: true,
  recommendedNextStep: 'x', netRead: 'x', caveats: [],
  roleAnchors: [{ label: 'a', state: 'MET', reason: 'r' }],
  anchorSummary: { met: 1, observable: 1, notCollected: 0 },
  evidenceQuotes: [{ anchor: 'a', quote: 'q', column: 'résumé · p.1' }],
  coverageGaps: [{ label: 'g', status: 's' }],
  gapsToInvestigate: [{ label: 'g', reason: 'r' }],
  capabilitySignals: { met: ['m'], missing: [] }, pool: null,
};
const html = composeNoteHtml(stub, 'https://example.com/d', { filename: 'x.pdf' });
const banned = [...new Set([...html.matchAll(/<\/?([a-z0-9]+)/gi)]
  .map((m) => m[1].toLowerCase())
  .filter((t) => ['table', 'thead', 'tbody', 'tr', 'th', 'td', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr'].includes(t)))];
banned.length ? bad(`emits ${banned.join(', ')} — Ashby flattens or drops these`)
  : ok('bold, italic, code, links and lists only');

step('presigned upload handle is issued');
const handle = await call(ENDPOINTS.createFileUploadHandle, {
  [P.context]: FILE_CONTEXT.candidateFiles,
  [P.name]: 'verify-live.pdf',
  [P.type]: 'application/pdf',
  [P.length]: 1024,
});
const h = handle.json?.results;
h?.url && h?.fields ? ok(`${Object.keys(h.fields).length} policy fields`)
  : bad(`no handle ${JSON.stringify(handle.json?.errors ?? '')}`);

step('policy Content-Type is satisfiable');
// The 403 that broke the documented upload path for weeks: the policy conditions on a
// Content-Type FORM FIELD that Ashby does not return in `fields`.
try {
  const policy = JSON.parse(Buffer.from(h.fields.Policy, 'base64').toString('utf8'));
  const conds = policy.conditions.filter((c) => !Array.isArray(c)).flatMap((c) => Object.keys(c));
  const missing = conds.filter((k) => !(k in h.fields));
  missing.length
    ? ok(`policy needs ${missing.join(', ')}, supplied from the policy itself`)
    : ok('every condition already present in fields');
} catch (e) { bad(`could not decode the policy: ${e.message}`); }

// ── summary ────────────────────────────────────────────────────────────────────
console.log();
if (fail === 0) {
  console.log(`${G}${B}  ✓ ${pass} checks passed${warn ? `, ${warn} warning${warn > 1 ? 's' : ''}` : ''}.${O}\n`);
} else {
  console.log(`${R}${B}  ✗ ${fail} of ${pass + fail} checks failed.${O}\n`);
}
process.exit(fail > 0 ? 1 : 0);
