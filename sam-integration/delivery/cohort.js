/**
 * Where a candidate sits among everyone else Sam has graded for the same job.
 *
 * WHY THIS CAN EXIST NOW. Rank used to be cleared on every delivery, and the reasoning was
 * sound: "a scheduled sweep scores one person and has no cohort", and "1 of 1, top 100%" is
 * worse than saying nothing. But that was true because the ledger lived in memory and every
 * pass started blank. A durable ledger IS the cohort — it holds every score this system has
 * ever published, keyed by job — so the fourth field stops being permanently null.
 *
 * WHAT THIS IS NOT. It does not score anybody. It orders numbers the engine already decided,
 * which is presentation, not judgement. No candidate's rank changes any candidate's score.
 *
 * THREE RULES, each of which exists because the honest version is less flattering:
 *
 *   1. COMPARE LIKE WITH LIKE. Role Fit is coverage-denominated — it answers "of what we
 *      could observe, how much is met". Someone evidenced on two anchors out of six can
 *      score higher than someone evidenced on all six, so ranking them together produces a
 *      confident lie. Only candidates at or above the publishable coverage floor are ranked,
 *      and everyone else is told they are unranked rather than given a flattering position.
 *
 *   2. A COHORT OF ONE IS NOT A COHORT. Below MIN_COHORT the rank is withheld entirely.
 *      "Top 100% of 1" is the most misleading true statement this system could publish.
 *
 *   3. TIES SHARE A RANK. Two candidates on the same Role Fit are both "3rd", and the next
 *      is 5th. Breaking a tie arbitrarily invents a distinction the evidence does not
 *      support, and whichever name sorted first would look better for no reason.
 */
import { MIN_SCOREABLE_COVERAGE } from '../ingest/enginePayload.js';

/**
 * Below this many ranked candidates, a position says more about the sample than the person.
 * Four is the point where "top 25%" starts describing the pool rather than rounding noise.
 */
export const MIN_COHORT = Number(process.env.SAM_MIN_COHORT ?? 4);

/**
 * @param {object[]} entries ledger rows for one job: {candidateId, snapshot:{roleFit, coverage}}
 * @returns {{size: number, ranked: Map<string, {rank, size, topPercent}>}}
 */
export function cohortFor(entries) {
  /**
   * Who may be ranked against whom.
   *
   * The original rule was "coverage at or above the floor", because a coverage-denominated
   * score is only comparable between candidates who were assessed to a similar depth. Sam
   * sends no coverage figure, so that rule excluded EVERYBODY — a cohort of three scored
   * candidates reported "0 comparable".
   *
   * The equivalent test against Sam's data is its own publishability: a capped score is one
   * Sam has said should not stand on its evidence, and ranking it beside an uncapped one
   * would do exactly the damage the coverage floor existed to prevent. Where a coverage
   * figure IS present — the local demo path — it is still honoured.
   */
  const comparable = entries
    .filter((e) => Number.isFinite(e?.snapshot?.roleFit))
    .filter((e) => e.snapshot.scoreIsPublishable !== false)
    .filter((e) => !Number.isFinite(e.snapshot.coverage) || e.snapshot.coverage >= MIN_SCOREABLE_COVERAGE);

  const ranked = new Map();
  if (comparable.length < MIN_COHORT) return { size: comparable.length, ranked };

  const sorted = [...comparable].sort((a, b) => b.snapshot.roleFit - a.snapshot.roleFit);

  let rank = 0;
  let lastFit = null;
  sorted.forEach((entry, i) => {
    // Standard competition ranking: equal scores share a position, and the next one skips.
    if (entry.snapshot.roleFit !== lastFit) { rank = i + 1; lastFit = entry.snapshot.roleFit; }
    ranked.set(entry.candidateId, {
      rank,
      size: sorted.length,
      // Rounded UP so a claim is never better than the truth: 3rd of 12 is "top 25%", and a
      // fractional advantage never rounds into a stronger-sounding bracket.
      topPercent: Math.ceil((rank / sorted.length) * 100),
    });
  });

  return { size: sorted.length, ranked };
}

/**
 * The job-level summary written back onto the requisition.
 *
 * Median rather than mean: one outstanding candidate should not make a whole pipeline look
 * strong, and one unscoreable one should not sink it.
 */
export function jobSummary(entries) {
  const delivered = entries.filter((e) => e?.snapshot && !e.failed);
  const fits = delivered
    .map((e) => e.snapshot.roleFit)
    .filter((f) => Number.isFinite(f))
    .sort((a, b) => a - b);

  const median = fits.length
    ? (fits.length % 2
      ? fits[(fits.length - 1) / 2]
      : (fits[fits.length / 2 - 1] + fits[fits.length / 2]) / 2)
    : null;

  return {
    graded: delivered.length,
    medianRoleFit: median === null ? null : Math.round(median * 100),
    // Published only when it means something — see rule 2.
    rankedCohort: cohortFor(entries).size,
  };
}
