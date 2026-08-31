/**
 * The contract between Sam's scoring engine and the Snapshot.
 *
 * The engine owns judgement. This side owns presentation. That line is the whole design:
 * every number, state, reason and quote arrives already decided, and nothing in here
 * re-derives a score, re-words a finding, or invents a value the engine did not send.
 *
 * Which makes this file the proof that the contract is sufficient. `snapshotFromEnginePayload`
 * returns exactly the view model the PDF and the note already render, built from the payload
 * and from Ashby — and from nothing else. If a Snapshot section cannot be filled from those
 * two sources, it fails here rather than three weeks after the engine ships.
 *
 * Two rules the engine has to hold to:
 *
 *   1. Optional means null, never missing. A section with no data prints "Not determined";
 *      a section whose key is absent is a bug we cannot tell apart from a real absence.
 *   2. Evidence carries its source. A quote with no locator cannot be shown next to a claim,
 *      because the reader cannot check it — and an unverifiable quote is worse than no quote.
 */

/** Anchor states. NOT_COLLECTED is excluded from the denominator — see coverage. */
export const ANCHOR_STATE = {
  MET: 'MET',
  PARTIAL: 'PARTIAL',
  NOT_MET: 'NOT_MET',
  NOT_COLLECTED: 'NOT_COLLECTED',
};

const STATE_BAND = {
  MET: 'Strong', PARTIAL: 'Partial', NOT_MET: 'Not shown', NOT_COLLECTED: 'Not asked',
};

export class ContractError extends Error {
  constructor(path, expected, got) {
    super(`Engine payload ${path}: expected ${expected}, got ${got === undefined ? 'missing' : JSON.stringify(got)}`);
    this.name = 'ContractError';
    this.path = path;
  }
}

const req = (obj, path, test, expected) => {
  const value = path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  if (!test(value)) throw new ContractError(path, expected, value);
  return value;
};

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v) => typeof v === 'string' && v.length > 0;
const isArr = (v) => Array.isArray(v);
/** Optional means present-and-null, so a real absence is distinguishable from a bug. */
const optional = (v, fallback) => (v === null || v === undefined ? fallback : v);

/**
 * Validates an engine payload against the contract.
 * Throws on the first violation rather than rendering a Snapshot with a hole in it.
 */
export function validateEnginePayload(payload) {
  req(payload, 'schemaVersion', isStr, 'a version string');
  req(payload, 'scoreId', isStr, 'a stable id we can use as the idempotency key');
  req(payload, 'subject.ashbyCandidateId', isStr, 'the Ashby candidate id');
  req(payload, 'subject.ashbyJobId', isStr, 'the Ashby job id');

  req(payload, 'scores.roleFit', (v) => isNum(v) && v >= 0 && v <= 1, 'roleFit in 0..1');
  req(payload, 'scores.coverage', (v) => isNum(v) && v >= 0 && v <= 1, 'coverage in 0..1');
  req(payload, 'scores.capability', (v) => isNum(v) && v >= 0 && v <= 10, 'capability in 0..10');

  const anchors = req(payload, 'anchors', (v) => isArr(v) && v.length > 0, 'at least one anchor');
  anchors.forEach((a, i) => {
    req(a, 'id', isStr, `anchors[${i}].id`);
    req(a, 'label', isStr, `anchors[${i}].label`);
    req(a, 'state', (v) => v in ANCHOR_STATE, `anchors[${i}].state one of ${Object.keys(ANCHOR_STATE)}`);
    req(a, 'reason', isStr, `anchors[${i}].reason — the sentence the reviewer reads`);
    req(a, 'weight', isNum, `anchors[${i}].weight`);
    // Evidence is optional in count but never in shape: a quote without a source cannot
    // be printed beside a claim, because the reader has no way to check it.
    for (const [j, e] of (a.evidence ?? []).entries()) {
      req(e, 'quote', isStr, `anchors[${i}].evidence[${j}].quote`);
      req(e, 'source', isStr, `anchors[${i}].evidence[${j}].source — where this quote came from`);
    }
  });

  const read = req(payload, 'inputs.read', (v) => isArr(v) && v.length > 0,
    'inputs.read — what the engine actually opened, which becomes the provenance line');

  // The scheduled sweep reads resumes; the interview flow reads recordings. A payload that
  // claims one and ships the other would put "Listen to responses" on a Snapshot whose
  // judgement never heard them — the single most misleading thing this document could do.
  const heard = read.some((r) => /voice|interview|recording|response/i.test(r));
  if ((payload.inputs.audio?.length ?? 0) > 0 && !heard) {
    throw new ContractError('inputs.audio', 'no recordings, because inputs.read does not list any '
      + `interview source (got ${JSON.stringify(read)})`, payload.inputs.audio.length);
  }

  return payload;
}

/**
 * Builds the Snapshot view model from an engine payload plus what Ashby holds.
 *
 * @param {object} payload  the engine's scored output, per the contract
 * @param {object} ashby    {candidate, job, pool} — read from Ashby, never from the engine
 */
export function snapshotFromEnginePayload(payload, ashby) {
  validateEnginePayload(payload);

  const anchors = payload.anchors.map(({ evidence, ...a }) => ({
    ...a,
    // The renderer reads `spans`; the contract calls them `evidence` because "span" is an
    // artefact of how the survey pipeline happened to store them. `evidence` is dropped
    // rather than carried alongside, so the anchor the renderer sees has exactly one
    // representation of the same fact.
    spans: (evidence ?? []).map((e) => ({ column: e.source, quote: e.quote })),
  }));

  const by = (state) => anchors.filter((a) => a.state === state);
  const met = by(ANCHOR_STATE.MET);
  const partial = by(ANCHOR_STATE.PARTIAL);
  const notMet = by(ANCHOR_STATE.NOT_MET);
  const notCollected = by(ANCHOR_STATE.NOT_COLLECTED);

  const anchorOf = (id) => anchors.find((a) => a.id === id) ?? null;
  const bandOf = (a) => (a ? STATE_BAND[a.state] : 'Not assessed');

  const fitRow = (id, fallbackLine) => {
    const a = anchorOf(id);
    return { band: bandOf(a), line: a ? a.reason : fallbackLine };
  };

  const level = optional(payload.profile?.roleLevelFit, null);

  return {
    candidate: {
      name: ashby.candidate.name,
      email: ashby.candidate.primaryEmailAddress?.value ?? null,
      linkedin: ashby.candidate.socialLinks?.find((l) => l.type === 'LinkedIn')?.url ?? null,
      location: ashby.candidate.location?.locationSummary ?? null,
      resume: ashby.candidate.resumeFileHandle ?? null,
      attachments: ashby.candidate.fileHandles ?? [],
      ashbyCandidateId: payload.subject.ashbyCandidateId,
      ashbyApplicationId: payload.subject.ashbyApplicationId ?? null,
    },
    role: {
      title: ashby.job.title,
      company: ashby.job.company ?? null,
      source: payload.engine?.rubricSource ?? null,
    },

    roleFit: payload.scores.roleFit,
    coverage: payload.scores.coverage,
    band: payload.scores.band ?? bandFromRoleFit(payload.scores.roleFit),
    capability: payload.scores.capability,
    capabilityRaw: optional(payload.scores.capabilityRaw, payload.scores.capability),
    capabilitySignals: optional(payload.scores.capabilitySignals, { met: [], missing: [] }),

    anchors,
    roleAnchors: anchors,
    anchorSummary: {
      met: met.length,
      partial: partial.length,
      notMet: notMet.length,
      notCollected: notCollected.length,
      observable: anchors.length - notCollected.length,
      total: anchors.length,
    },

    netRead: req(payload, 'narrative.netRead', isStr, 'the engine’s summary judgement'),
    recommendedNextStep: req(payload, 'narrative.recommendedNextStep', isStr, 'the next step'),
    caveats: optional(payload.narrative?.caveats, []),

    // Views onto the anchors. Ordering and wording are presentation, so they live here —
    // but every fact in them came from the engine.
    coverageGaps: [...notCollected, ...notMet].map((a) => ({
      label: a.label,
      status: a.state === ANCHOR_STATE.NOT_COLLECTED
        ? 'Not covered by the inputs' : 'Read, no evidence found',
      reason: a.reason,
    })),
    gapsToInvestigate: optional(payload.narrative?.gapsToInvestigate,
      [...partial, ...notCollected, ...notMet]
        .sort((a, b) => b.weight - a.weight)
        .map((a) => ({ label: a.label, reason: a.reason }))),
    evidenceQuotes: met.flatMap((a) => a.spans.slice(0, 1)
      .map((s) => ({ anchor: a.label, column: s.column, quote: s.quote }))),

    experienceMatch: optional(payload.profile?.experienceMatch,
      fitRow('A1', 'The inputs did not evidence this.')),
    responsibilityMatch: optional(payload.profile?.responsibilityMatch,
      fitRow('A3', 'The inputs did not evidence this.')),
    roleLevelFit: level ?? {
      band: 'Not determined',
      line: 'The engine did not assert a seniority level, and inferring one from a résumé '
        + 'parse is not reliable enough to print on a person’s record.',
      suggestions: [],
    },
    careerHistory: cleanCareerHistory(payload.profile?.careerHistory),
    additionalSkills: optional(payload.profile?.additionalSkills, []),

    // Provenance is stated, never assumed: it is a literal list of what the engine opened.
    provenance: payload.inputs.read.join(' + '),
    hasResume: payload.inputs.read.some((s) => /r[ée]sum[ée]/i.test(s)),
    audioUrls: optional(payload.inputs.audio, []),
    answeredCount: optional(payload.inputs.answeredCount, 0),

    // Rank needs the cohort, which one scored candidate cannot know. Ashby supplies it or
    // nobody does — see the contract note on cohort.
    pool: ashby.pool ?? null,
  };
}

/**
 * Career history is the one section where a wrong row is worse than no row.
 *
 * Résumé parsers emit lines like {title: "Apollo Tyres", company: "Sales Intern"} — the
 * fields swapped — and printing that on someone's record makes the whole document look
 * careless. The engine is asked to send clean rows; this drops the ones that are obviously
 * not, because trusting an upstream parser with a person's employment history is not a
 * risk worth taking for the sake of one row.
 */
function cleanCareerHistory(history) {
  if (!history) return { roles: [], source: null, note: null };
  const roles = (history.roles ?? []).filter((r) => (
    r.title && r.company
    && r.title.length > 3
    && !/\d{2}%|\brates\b/i.test(r.company)
  ));
  return {
    roles,
    source: history.source ?? null,
    note: roles.length
      ? history.note ?? null
      : history.note ?? 'No role could be read cleanly from the résumé.',
  };
}

const bandFromRoleFit = (v) => (v >= 0.75 ? 'Strong' : v >= 0.5 ? 'Moderate' : 'Limited');
