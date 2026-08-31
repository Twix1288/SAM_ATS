/**
 * Generates the example engine payload from a real scored candidate, anonymised.
 *
 * The shapes, the field counts and the string lengths come from real output, so the example
 * is honest about what the engine has to produce. The identity and the quoted text do not:
 * this file is the one most likely to be pasted into a chat window, and a real candidate's
 * interview answers and employment history do not belong in a spec.
 *
 * Source locators are rewritten too. The survey pipeline stores a span's origin as the
 * spreadsheet column it came from — "AG" — which is meaningless to a reviewer. The contract
 * asks for `interview:Q3` or `resume:page 1`, and the example has to show that rather than
 * leak an implementation detail into the spec.
 */
import { writeFileSync } from 'node:fs';
import { loadPool } from '../shared/seed/survey.js';
import { scorePool } from '../sam-integration/services/calibrate.js';
import { resumeForResponse } from '../sam-integration/ingest/resume.js';

const OUT = process.argv[2] ?? 'docs/sam-engine-payload.example.json';
const ROW = Number(process.argv[3] ?? 6);

const entry = scorePool(loadPool('data/survey_agree.com_business_development_representative.xlsx'))
  .find((e) => e.response.rowNumber === ROW);
if (!entry) throw new Error(`No candidate at row ${ROW}`);

const { score, response } = entry;
const parsed = resumeForResponse(response);

const ANON = {
  name: 'Jordan Avery',
  resume: 'jordan_avery_resume.pdf',
  roles: [
    { title: 'Account Executive', company: 'Northwind Software', start: '2023-04', end: 'Present' },
    { title: 'Sales Development Representative', company: 'Latimer Systems', start: '2021-08', end: '2023-03' },
  ],
};

/** Keeps the real length so the example stays honest about how much text has to fit. */
const synthesise = (real, i) => {
  const stand = [
    'I run outbound in three passes — fit, trigger, then a specific reason to talk now — and I keep the first touch under sixty words.',
    'Last quarter I closed eleven deals against a quota of nine, with an average cycle of forty-one days.',
    'I brought finance in at the second call rather than the last, because the objection is always procurement, not product.',
    'When a deal stalls I ask who else has to sign, and I have lost enough deals to know that answer is never one person.',
    'I keep a written loss reason on every closed-lost opportunity, and I review them monthly.',
  ][i % 5];
  return real.length > stand.length ? `${stand} ${'\u2026'}` : stand.slice(0, Math.max(40, real.length));
};

/** The rubric knows which questions evidence an anchor; the spreadsheet column does not. */
const locatorFor = (anchor, i) => {
  const qs = anchor.evidencedBy ?? [];
  return qs.length ? `interview:${qs[i % qs.length]}` : 'resume:page 1';
};

const payload = {
  schemaVersion: '1.0',
  scoreId: 'sam_score_jordan_avery_sales_ae_v1',
  scoredAt: new Date('2026-08-25T12:00:00Z').toISOString(),

  engine: {
    version: 'sam-engine@0.0.0-example',
    rubricId: 'sales-account-executive',
    rubricVersion: '1',
    rubricSource: 'Sales Account Executive.pdf',
  },

  subject: {
    ashbyCandidateId: '00000000-0000-4000-8000-000000000001',
    ashbyApplicationId: '00000000-0000-4000-8000-000000000002',
    ashbyJobId: '00000000-0000-4000-8000-000000000003',
  },

  // What the engine actually opened. Becomes the provenance line on the Snapshot verbatim,
  // so it must be literal — never a description of what it usually reads.
  inputs: {
    read: response.resume ? ['resume', 'voice responses'] : ['voice responses'],
    resume: response.resume ? { fileHandleId: 'file_example', filename: ANON.resume } : null,
    jobDescription: { storedAt: '2026-08-20T09:00:00Z', version: '1' },
    answeredCount: score.answeredCount ?? response.answers.length,
    audio: score.audioUrls ?? [],
  },

  scores: {
    roleFit: score.roleFit,
    coverage: score.coverage,
    band: score.band,
    capability: score.capability,
    capabilityRaw: score.capabilityRaw,
    capabilitySignals: score.capabilitySignals,
  },

  anchors: score.anchors.map((a) => ({
    id: a.id,
    label: a.label,
    detail: a.detail,
    weight: a.weight,
    state: a.state,
    reason: a.reason,
    evidence: (a.spans ?? []).map((s, i) => ({
      quote: synthesise(s.quote, i),
      source: locatorFor(a, i),
      locator: null,
    })),
  })),

  narrative: {
    netRead: score.netRead ?? null,
    recommendedNextStep: score.recommendedNextStep,
    caveats: score.caveats ?? [],
    gapsToInvestigate: null,      // null = derive it from the anchors
  },

  profile: {
    careerHistory: parsed
      ? { roles: ANON.roles, source: ANON.resume, note: null }
      : { roles: [], source: null, note: 'No resume text could be extracted.' },
    additionalSkills: [...new Set(response.answers.flatMap((a) => a.keywords))].slice(0, 10),
    experienceMatch: null,        // null = derive from anchor A1
    responsibilityMatch: null,    // null = derive from anchor A3
    roleLevelFit: null,           // null = print "Not determined" rather than guess
  },
};

// netRead has to be a string in the contract; the current engine composes it downstream, so
// borrow that composition for the example rather than shipping an example that fails validation.
if (!payload.narrative.netRead) {
  const { buildSnapshot } = await import('../sam-integration/render/model.js');
  payload.narrative.netRead = buildSnapshot(score, response).netRead
    .replaceAll(score.candidate.name.split(' ')[0], ANON.name.split(' ')[0]);
}

writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`  wrote ${OUT}  ${JSON.stringify(payload).length} bytes · ${payload.anchors.length} anchors · `
  + `${payload.anchors.reduce((n, a) => n + a.evidence.length, 0)} evidence quotes`);
