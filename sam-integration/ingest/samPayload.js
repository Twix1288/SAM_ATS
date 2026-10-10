/**
 * Sam's live payload → the Snapshot view model.
 *
 * Sam's shape is its own, and mapping it is not mechanical. Three differences change what
 * the document can honestly say, and each is handled deliberately below rather than papered
 * over. All three are worth raising with Sam; none of them blocks shipping.
 *
 *   1. THERE IS NO COVERAGE FIGURE. Every surface here was built around a second number —
 *      how much of the rubric Sam could actually ASSESS — because a fit score denominated by
 *      coverage is a different claim from one denominated by the whole job. Sam's payload has
 *      `met_count / total` (a met-rate) and `coverage_gaps` (what is missing), but nothing
 *      that says "this requirement was unassessable from what we were given".
 *
 *      So the coverage gate cannot run on Sam's data, and inventing a number to feed it would
 *      be worse than not having one. Instead we defer to Sam's OWN guard —
 *      `match.cap_applied` and `core_anchor_missing` — which is their considered judgement
 *      about whether this score should stand. See `publishableFrom`.
 *
 *   2. THERE IS NO "NEVER ASKED" STATE. Sam has met_directly / met_by_equivalent / not_met.
 *      The distinction this product is built on — between "we looked and it was not there"
 *      and "a résumé cannot show this" — does not survive the trip. `not_met` is therefore
 *      mapped to NOT_MET and nothing is mapped to NOT_COLLECTED, because guessing which
 *      not_mets were really unassessable would put words in Sam's mouth.
 *
 *   3. EVIDENCE IS A SUMMARY, NOT A QUOTE. Sam's `evidence` reads "Ran operations across
 *      multiple sites simultaneously" — a paraphrase, not the candidate's own words with a
 *      page number. The Snapshot's evidence block was designed so a reviewer could go and
 *      check a claim; a paraphrase cannot be checked. It is rendered, labelled as Sam's
 *      reading rather than as a quotation, and the locator is dropped rather than faked.
 */
import { ANCHOR_STATE } from './enginePayload.js';

export class SamPayloadError extends Error {
  constructor(path, expected, got) {
    super(`Sam payload ${path}: expected ${expected}, got ${got === undefined ? 'missing' : JSON.stringify(got)}`);
    this.name = 'SamPayloadError';
    this.path = path;
  }
}

/**
 * met_by_equivalent is PARTIAL, not MET.
 *
 * Sam met it by transfer — retention through service delivery standing in for retention
 * through account management — and says so in `assumption`. That is a real finding and a
 * weaker one than direct evidence, and collapsing it into MET would hide the inference from
 * the person deciding whether to interview. The assumption travels into the reason so the
 * reviewer can judge the transfer themselves.
 */
const STATE_OF = {
  met_directly: ANCHOR_STATE.MET,
  met_by_equivalent: ANCHOR_STATE.MET_EQUIVALENT,
  not_met: ANCHOR_STATE.NOT_MET,
};

/** `core` carries more than `supporting`; the renderer orders on it. */
const WEIGHT_OF = { core: 0.25, supporting: 0.1 };

/**
 * Whether the fit number may be published.
 *
 * With no coverage figure we cannot apply our own floor, so we use Sam's: a capped score is
 * one Sam has itself marked as not standing on its own evidence. `cap_note` explains why and
 * is carried into the caveats, so a withheld number always arrives with its reason.
 */
const publishableFrom = (match) => match?.cap_applied !== true;

function requireField(payload, path, value, expected) {
  if (value === undefined || value === null) throw new SamPayloadError(path, expected, value);
  return value;
}

/**
 * @param {object} sam    Sam's per-applicant object
 * @param {object} ashby  {candidate, job} — identity ALWAYS comes from Ashby, never from Sam.
 *                        Sam sends person_name and person_email; they are ignored. If the two
 *                        ever disagree the ATS is right, and a Snapshot showing a name that
 *                        does not match the record it sits on is the most alarming possible
 *                        way to find that out.
 */
export function snapshotFromSamPayload(sam, ashby) {
  requireField(sam, 'match.percent', sam?.match?.percent, 'a number 0-100');
  requireField(sam, 'role_anchors.items', sam?.role_anchors?.items, 'an array of anchors');
  requireField(sam, 'net_read', sam?.net_read, 'a paragraph');

  const match = sam.match;
  const publishable = publishableFrom(match);

  const anchors = (sam.role_anchors.items ?? []).map((item) => {
    const state = STATE_OF[item.status];
    if (!state) throw new SamPayloadError(`role_anchors.items[].status`, Object.keys(STATE_OF).join(' | '), item.status);

    // Duration and recency are Sam's, and they are genuinely useful on a hiring decision —
    // "7 years, current" says something "met" does not. Folded into the reason rather than
    // given their own column, because the note cannot render columns at all.
    const when = [item.duration, item.recency && `${item.recency}`].filter(Boolean).join(' · ');
    const transfer = item.status === 'met_by_equivalent' && item.assumption
      ? ` Counted by equivalence to ${item.equivalent_to ?? 'a related requirement'} — ${item.assumption}`
      : '';

    return {
      id: item.anchor,
      label: item.anchor,
      detail: item.anchor,
      weight: WEIGHT_OF[item.weight] ?? 0.1,
      core: item.weight === 'core',
      state,
      reason: `${item.evidence ?? ''}${when ? ` (${when})` : ''}${transfer}`.trim(),
      // Sam's evidence is a paraphrase, so it is NOT presented as a quotation. The source
      // reads "Sam's reading of the résumé" rather than a page number we do not have.
      spans: item.evidence ? [{ column: 'Sam’s reading of the résumé', quote: item.evidence }] : [],
    };
  });

  const count = (st) => anchors.filter((a) => a.state === st).length;
  const met = count(ANCHOR_STATE.MET);
  const metEquivalent = count(ANCHOR_STATE.MET_EQUIVALENT);
  const notMet = count(ANCHOR_STATE.NOT_MET);

  const caveats = [
    // Sam's own reason for capping, surfaced rather than swallowed.
    match.cap_applied && match.cap_note ? match.cap_note : null,
    match.core_anchor_missing && !match.cap_applied && match.cap_note ? match.cap_note : null,
    // The integrity signal. Only shown when it fires — a "no AI detected" line on every
    // document would train reviewers to ignore it on the one where it matters.
    sam.integrity?.ai_authorship_flag
      ? `Integrity: this résumé shows signs of AI authorship.${sam.integrity.notes ? ` ${sam.integrity.notes}` : ''}`
      : null,
  ].filter(Boolean);

  return {
    candidate: {
      name: ashby.candidate.name,
      email: ashby.candidate.primaryEmailAddress?.value ?? null,
      linkedin: ashby.candidate.socialLinks?.find((l) => l.type === 'LinkedIn')?.url ?? null,
      location: ashby.candidate.location?.locationSummary ?? null,
      resume: ashby.candidate.resumeFileHandle ?? null,
      attachments: ashby.candidate.fileHandles ?? [],
      ashbyCandidateId: ashby.candidate.id,
      ashbyApplicationId: ashby.applicationId ?? null,
    },
    role: { title: ashby.job.title, company: ashby.job.company ?? null, source: `Sam job ${sam.job_id}` },

    roleFit: match.percent / 100,
    // Honestly absent rather than invented. Every renderer already handles a null here by
    // printing nothing, because the alternative — a fabricated denominator — would make a
    // score look better evidenced than it is.
    coverage: null,
    scoreIsPublishable: publishable,
    band: match.strength ? titleCase(match.strength) : 'Not determined',

    capability: sam.capability?.score ?? null,
    capabilityRaw: sam.capability?.score ?? null,
    capabilitySignals: {
      met: (sam.capability?.traits ?? []).map((t) => t.label),
      missing: [],
    },
    // Sam's traits carry a sentence each, which is richer than our met/missing labels and
    // has nowhere else to go.
    capabilityTraits: sam.capability?.traits ?? [],

    roleAnchors: anchors,
    anchorSummary: {
      met,
      metEquivalent,
      partial: 0,
      notMet,
      notCollected: 0,
      observable: anchors.length,
      total: sam.role_anchors.total ?? anchors.length,
    },

    // Both kinds of pass carry their reading, including the ones met by transfer — the
    // assumption behind an equivalence is exactly what a reviewer wants to see.
    evidenceQuotes: anchors
      .filter((a) => (a.state === ANCHOR_STATE.MET || a.state === ANCHOR_STATE.MET_EQUIVALENT) && a.spans.length)
      .map((a) => ({ anchor: a.label, quote: a.spans[0].quote, column: a.spans[0].column })),

    coverageGaps: (sam.coverage_gaps ?? []).map((g) => ({
      label: g.anchor,
      status: g.related_experience ? `Closest: ${g.related_experience}` : (g.note ?? 'Not shown'),
    })),

    netRead: sam.net_read,
    recommendedNextStep: sam.recommended_next_step ?? 'Not determined',
    caveats,
    gapsToInvestigate: (sam.what_to_confirm ?? []).map((w) => ({ label: w.label, reason: w.note ?? '' })),

    experienceMatch: dimension(sam.dimensions?.experience_match),
    responsibilityMatch: dimension(sam.dimensions?.responsibility_match),
    roleLevelFit: sam.dimensions?.role_level_fit
      ? {
        band: sam.dimensions.role_level_fit.rating ?? 'Not determined',
        line: sam.dimensions.role_level_fit.statement ?? sam.dimensions.role_level_fit.evidence ?? '',
        suggestions: sam.dimensions.role_level_fit.suggestions ?? [],
      }
      : null,

    careerHistory: {
      // Both lists, in order: the roles Sam matched to this job first, then the rest. The
      // second list is thinner by design and prints without a summary line.
      roles: [
        ...(sam.career_history?.matched_to_role ?? []).map((r) => ({
          title: r.title, company: r.company, start: null, end: r.tenure ?? null, summary: r.summary ?? null,
        })),
        ...(sam.career_history?.additional_experience ?? []).map((r) => ({
          title: r.title, company: r.company, start: null, end: r.tenure ?? null, summary: null,
        })),
      ],
      source: 'résumé, as read by Sam',
      note: null,
    },
    additionalSkills: sam.additional_skills ?? [],

    /**
     * DELIBERATELY NULL. The rank is filled in later, from our own ledger.
     *
     * Sam does rank the cohort, and its pool is the better one — it sees everyone it has
     * scored for the job. But the rank is computed AT SCORE TIME and never revisited.
     * Observed submitting three applicants to one job in sequence:
     *
     *   Creed Fraudster   rank null, cohort null   (first in, nothing to compare)
     *   Jim Halpert       rank 1 of 2              (true then; there are three now)
     *   Jamar Herzog      rank 1 of 3              (true, until the fourth applies)
     *
     * Writing that into a filterable Ashby column means every candidate but the most recent
     * carries a stale position, and the first one carries none at all — on a live
     * requisition, that is almost everybody. The ledger holds every score we have published
     * for the job, so `cohort.js` can recompute the ordering on every pass and keep it
     * current. Sam's percentages stay the source of truth; only the ordering is ours.
     */
    pool: null,

    /** Sam's own rank, kept for reference and for the note's provenance. Not published. */
    samRank: Number.isFinite(match.rank)
      ? { rank: match.rank, size: match.cohort_size, position: match.cohort_position ?? null }
      : null,

    provenance: 'résumé',
    hasResume: Boolean(ashby.candidate.resumeFileHandle),
    audioUrls: [],
    answeredCount: null,

    samUrl: sam.assets?.snapshot_url ?? null,
    /** Sam's own rendering. Preferred over ours — see fetchSnapshotPdf. */
    samPdfUrl: sam.assets?.snapshot_pdf_url ?? null,
    // Job-level, not candidate-level: a finding about the whole applicant pool. Carried so
    // the caller can put it on the JOB page, where it belongs, rather than repeating it on
    // every candidate's record.
    cohortFindings: sam.cohort_findings ?? [],
  };
}

const dimension = (d) => (d ? { band: d.rating ?? 'Not determined', line: d.evidence ?? d.statement ?? '' } : null);

/**
 * Sam's strengths are SCREAMING_SNAKE — STRONG, PARTIAL, NOT_A_MATCH. Rendered naively that
 * last one reaches a candidate's record as "Not_a_match", which is the kind of detail that
 * makes a whole document look unfinished.
 */
const titleCase = (s) => {
  const words = String(s).toLowerCase().split(/[_\s]+/).filter(Boolean);
  if (!words.length) return 'Not determined';
  return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ');
};

/** Prefer Sam's own words; fall back to arithmetic only if they are absent. */
function percentFrom(position, rank, size) {
  const stated = /(\d+)\s*%/.exec(String(position ?? ''));
  if (stated) return Number(stated[1]);
  return size > 0 ? Math.ceil((rank / size) * 100) : null;
}
