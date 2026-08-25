/**
 * Two-axis scoring.
 *
 *   Role Fit   — evidence against this JD's anchors, over the OBSERVABLE denominator.
 *   Capability — role-independent craft, from structural properties of the answers.
 *
 * A percentage is never emitted without its coverage. Pure function: no clock,
 * no randomness, no network. Same response in, identical result out.
 */
import { ANCHORS, STATE, TOTAL_WEIGHT, softLower } from './rubric.js';

/** Credit split: how many distinct signals were found vs how much evidence backs them. */
const CREDIT_BREADTH = 0.8;
const CREDIT_DEPTH = 0.2;
import { extractAll, signalsPresent } from './evidence.js';

/** Role-independent craft signals behind the Capability Score. */
const CAPABILITY_SIGNALS = [
  { key: 'sequencedProcess',  label: 'Works from an explicit process' },
  { key: 'namedTool',         label: 'Names the tools they operate' },
  { key: 'namedCounterparty', label: 'Sells to named executive buyers' },
  { key: 'objectionHandling', label: 'Handles objections at root cause' },
  { key: 'statedOutcome',     label: 'States outcomes, not just activity' },
  { key: 'quantifiedOutcome', label: 'Quantifies results' },
];

function resolveAnchor(anchor, response, byQuestion) {
  const answered = anchor.evidencedBy.filter(
    (qid) => response.answers.find((a) => a.id === qid)?.answered,
  );

  if (anchor.evidencedBy.length === 0) {
    return { ...anchor, state: STATE.NOT_COLLECTED, reason: 'No survey question maps to this requirement.', spans: [] };
  }
  if (answered.length === 0) {
    return { ...anchor, state: STATE.NOT_COLLECTED, reason: `Question ${anchor.evidencedBy.join('/')} collected no response.`, spans: [] };
  }

  const present = signalsPresent(byQuestion, answered);
  const found = anchor.signals.filter((s) => present.has(s));
  const spans = found.flatMap((s) => present.get(s)).slice(0, 4);
  const ratio = found.length / anchor.signals.length;

  const state = ratio >= 0.66 ? STATE.MET : ratio > 0 ? STATE.PARTIAL : STATE.NOT_MET;
  const missing = anchor.signals.filter((s) => !present.has(s));

  // Continuous credit. Tri-state credit (1 / 0.5 / 0) collapsed 39 of 41 candidates
  // into ties, which made the pool rank written back to Ashby close to arbitrary.
  // Breadth of signals dominates; depth of supporting evidence separates ties.
  const spanCount = found.reduce((n, s) => n + present.get(s).length, 0);
  const density = Math.min(1, spanCount / (anchor.signals.length * 2));
  const credit = ratio === 0 ? 0 : CREDIT_BREADTH * ratio + CREDIT_DEPTH * density;

  const reason = state === STATE.MET
    ? `Evidenced by ${found.join(', ')}.`
    : state === STATE.PARTIAL
      ? `Partial: found ${found.join(', ')}; missing ${missing.join(', ')}.`
      : `Answered, but no supporting evidence found (looked for ${anchor.signals.join(', ')}).`;

  return { ...anchor, state, reason, spans, credit, spanCount, foundSignals: found, missingSignals: missing };
}

export function scoreResponse(response) {
  const byQuestion = extractAll(response);
  const anchors = ANCHORS.map((a) => resolveAnchor(a, response, byQuestion));

  const observable = anchors.filter((a) => a.state !== STATE.NOT_COLLECTED);
  const observableWeight = observable.reduce((s, a) => s + a.weight, 0);
  const earned = observable.reduce((s, a) => s + a.weight * a.credit, 0);

  const roleFit = observableWeight > 0 ? earned / observableWeight : 0;
  const coverage = observableWeight / TOTAL_WEIGHT;

  const allSignals = signalsPresent(byQuestion, Object.keys(byQuestion));
  const capabilityHits = CAPABILITY_SIGNALS.filter((s) => allSignals.has(s.key));
  const capBreadth = capabilityHits.length / CAPABILITY_SIGNALS.length;
  const capSpans = capabilityHits.reduce((n, s) => n + allSignals.get(s.key).length, 0);
  const capDepth = Math.min(1, capSpans / (CAPABILITY_SIGNALS.length * 2));
  const capability = (CREDIT_BREADTH * capBreadth + CREDIT_DEPTH * capDepth) * 10;

  const notCollected = anchors.filter((a) => a.state === STATE.NOT_COLLECTED);
  const band =
    coverage < 0.8 ? `${rawBand(roleFit)} — verify live`
    : rawBand(roleFit);

  return {
    candidate: { name: response.name, email: response.email, rowNumber: response.rowNumber, linkedin: response.linkedin, location: response.location, resume: response.resume, attachments: response.attachments },
    roleFit: round2(roleFit),
    coverage: round2(coverage),
    band,
    capability: Math.round(capability),
    capabilityRaw: round2(capability),
    capabilitySignals: {
      met: capabilityHits.map((s) => s.label),
      missing: CAPABILITY_SIGNALS.filter((s) => !allSignals.has(s.key)).map((s) => s.label),
    },
    anchors,
    anchorSummary: {
      met: anchors.filter((a) => a.state === STATE.MET).length,
      partial: anchors.filter((a) => a.state === STATE.PARTIAL).length,
      notMet: anchors.filter((a) => a.state === STATE.NOT_MET).length,
      notCollected: notCollected.length,
      observable: observable.length,
      total: anchors.length,
    },
    caveats: buildCaveats(allSignals),
    recommendedNextStep: nextStep(notCollected, anchors),
    audioUrls: response.answers.filter((a) => a.audioUrl).map((a) => ({ id: a.id, url: a.audioUrl })),
    answeredCount: response.answeredCount,
  };
}

const round2 = (n) => Math.round(n * 100) / 100;
const rawBand = (f) => (f >= 0.85 ? 'Strong' : f >= 0.6 ? 'Moderate' : f >= 0.35 ? 'Limited' : 'Weak');

function buildCaveats(allSignals) {
  const out = [];
  if (allSignals.has('advancedNotClosed') && !allSignals.has('statedOutcome')) {
    out.push('Deal narrative ends in advancement, not a stated close. Confirm a closed-won example.');
  }
  if (!allSignals.has('quantifiedOutcome') && !allSignals.has('quantifiedVolume')) {
    out.push('No quantified results anywhere in the responses.');
  }
  return out;
}

function nextStep(notCollected, anchors) {
  const hardGaps = anchors.filter((a) => a.state === STATE.NOT_MET).sort((a, b) => b.weight - a.weight);
  const probes = notCollected.sort((a, b) => b.weight - a.weight).map((a) => softLower(a.label));
  if (probes.length && hardGaps.length) {
    return `Move to the AI interview: the survey never captured ${probes.join(' or ')}, and ${softLower(hardGaps[0].label)} is unevidenced.`;
  }
  if (probes.length) return `Move to the AI interview to cover ${probes.join(' and ')}, which this survey never asked.`;
  if (hardGaps.length) return `Confirm ${softLower(hardGaps[0].label)} before advancing.`;
  return 'Evidence is complete across the rubric. Schedule the 1:1.';
}
