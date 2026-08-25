/**
 * Builds the Snapshot view model from a score.
 *
 * Fields the design fills from a resume are omitted rather than inferred: 40 of
 * 41 respondents have no resume on file, so "Resume Match" becomes "Role Fit"
 * and "Not shown on resume" becomes "Not covered in responses".
 */
import { STATE, ROLE, CORE_SKILL_TOOLS, softLower } from '../services/rubric.js';
import { resumeForResponse } from '../ingest/resume.js';

/** Bands used by the design's EXPERIENCE / RESPONSIBILITY / ROLE LEVEL rows. */
const bandFor = (anchor) => {
  if (!anchor) return 'Not assessed';
  return { MET: 'Strong', PARTIAL: 'Partial', NOT_MET: 'Not shown', NOT_COLLECTED: 'Not asked' }[anchor.state];
};

/**
 * CAREER HISTORY, from the candidate's own resume rather than the interview.
 *
 * Transcripts name employers inconsistently — one candidate's employer appears as
 * "Krasen Consulting" in one answer and "Crassant" in another, while their resume spells
 * it "Krasan Consulting Services" once. Rows that parse without a plausible title AND
 * company are dropped rather than printed, because a garbled job title on a person's
 * record is worse than an absent one.
 */
function careerHistoryFor(response) {
  const parsed = resumeForResponse(response);
  if (!parsed) return { roles: [], source: null, note: 'No resume text could be extracted.' };
  const roles = parsed.roles
    .filter((r) => r.title && r.company && r.title.length > 3 && !/\d{2}%|\brates\b/i.test(r.company))
    .map((r) => ({
      title: r.title.trim(),
      company: r.company.replace(/;.*$/, '').trim(),
      start: r.start ?? null,
      end: r.current ? 'Present' : (r.end ?? null),
    }));
  return {
    roles,
    source: response.resume?.name ?? null,
    note: roles.length ? null : 'The resume was read but no clean role could be parsed from it.',
  };
}

export function buildSnapshot(score, response) {
  const met = score.anchors.filter((a) => a.state === STATE.MET);
  const notMet = score.anchors.filter((a) => a.state === STATE.NOT_MET);
  const partial = score.anchors.filter((a) => a.state === STATE.PARTIAL);
  const notCollected = score.anchors.filter((a) => a.state === STATE.NOT_COLLECTED);

  const skills = [...new Set(
    response.answers.flatMap((a) => a.keywords)
      .concat([...CORE_SKILL_TOOLS.crm, ...CORE_SKILL_TOOLS.sequencing]
        .filter((tool) => response.answers.some((a) => new RegExp(`\\b${tool}\\b`, 'i').test(a.text)))),
  )].slice(0, 10);

  const a1 = score.anchors.find((a) => a.id === 'A1');   // full-cycle ownership
  const a3 = score.anchors.find((a) => a.id === 'A3');   // finance & exec stakeholders

  return {
    ...score,
    role: ROLE,

    // The design's three fit rows. Each states its band and the evidence behind it, so a
    // reviewer can disagree with the band rather than just the number.
    experienceMatch: {
      band: bandFor(a1),
      line: a1 ? a1.reason : 'No mapped question could evidence this.',
    },
    responsibilityMatch: {
      band: bandFor(a3),
      line: a3 ? a3.reason : 'No mapped question could evidence this.',
    },
    /**
     * Deliberately not inferred. Seniority needs titles and tenure; the interview never
     * asks, and the resume parse is too unreliable to assert a level from. Printing a
     * guess here would be the least defensible thing in the document.
     */
    roleLevelFit: {
      band: 'Not determined',
      line: 'Seniority is not derivable from the interview responses, and the resume parse '
        + 'is not reliable enough to assert a level from.',
      suggestions: [
        'Confirm current scope and team size in the 1:1',
        'Ask what they owned end to end versus contributed to',
      ],
    },
    careerHistory: careerHistoryFor(response),
    // Provenance: transcripts, not a resume.
    provenance: response.resume ? 'resume + voice responses' : 'voice responses',
    hasResume: Boolean(response.resume),
    netRead: composeNetRead(score, met, notMet, notCollected),
    roleAnchors: score.anchors,
    coverageGaps: [...notCollected, ...notMet].map((a) => ({
      label: a.label,
      status: a.state === STATE.NOT_COLLECTED ? 'Not covered in responses' : 'Answered, no evidence found',
      reason: a.reason,
    })),
    gapsToInvestigate: [...partial, ...notCollected, ...notMet]
      .sort((a, b) => b.weight - a.weight)
      .map((a) => ({ label: a.label, reason: a.reason })),
    additionalSkills: skills,
    evidenceQuotes: met.flatMap((a) => a.spans.slice(0, 1).map((s) => ({ anchor: a.label, column: s.column, quote: s.quote }))),
  };
}

function composeNetRead(score, met, notMet, notCollected) {
  const name = score.candidate.name.split(' ')[0];
  const parts = [];

  parts.push(met.length
    ? `${name} evidences ${listOf(met.map((a) => softLower(a.label)))} directly in their responses.`
    : `${name} does not evidence any of this role's anchors in their responses.`);

  if (notMet.length) {
    parts.push(`They were asked about ${listOf(notMet.map((a) => softLower(a.label)))} and the evidence is not there.`);
  }
  if (notCollected.length) {
    parts.push(`${notCollected.length === 1 ? 'One anchor' : `${notCollected.length} anchors`} — ${listOf(notCollected.map((a) => softLower(a.label)))} — ${notCollected.length === 1 ? 'was' : 'were'} never asked by this survey, so ${notCollected.length === 1 ? 'it is' : 'they are'} excluded from the score rather than counted against them.`);
  }
  parts.push(`Score reflects ${Math.round(score.coverage * 100)}% of the rubric.`);
  return parts.join(' ');
}

const listOf = (items) =>
  items.length <= 1 ? (items[0] ?? '') :
  `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
