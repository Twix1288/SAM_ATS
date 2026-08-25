/**
 * Pool calibration.
 *
 * The Snapshot design renders "Top 3% of pool · 128 applicants", which is only
 * honest if every candidate is scored. This module is why the engine can never
 * score one person in isolation.
 */
import { scoreResponse } from './score.js';

export function scorePool(pool) {
  const scored = pool.map((r) => ({ response: r, score: scoreResponse(r) }));
  const rank = (key) => [...scored].sort((a, b) => b.score[key] - a.score[key]);

  const byRoleFit = rank('roleFit');
  const byCapability = rank('capability');

  const positionIn = (list, rowNumber) =>
    list.findIndex((s) => s.response.rowNumber === rowNumber) + 1;

  for (const entry of scored) {
    const n = scored.length;
    const rfRank = positionIn(byRoleFit, entry.response.rowNumber);
    const capRank = positionIn(byCapability, entry.response.rowNumber);
    entry.score.pool = {
      size: n,
      roleFitRank: rfRank,
      capabilityRank: capRank,
      roleFitPercentile: Math.round(((n - rfRank + 1) / n) * 100),
      topPercent: Math.max(1, Math.round((rfRank / n) * 100)),
    };
  }
  return scored;
}

export function poolReportCsv(scored) {
  const head = 'row,name,role_fit,coverage,band,capability,anchors_met,anchors_observable,role_fit_rank';
  const lines = scored
    .sort((a, b) => b.score.roleFit - a.score.roleFit)
    .map(({ response: r, score: s }) =>
      [r.rowNumber, `"${r.name.replace(/"/g, '""')}"`, s.roleFit, s.coverage, `"${s.band}"`,
       s.capability, s.anchorSummary.met, s.anchorSummary.observable, s.pool.roleFitRank].join(','));
  return [head, ...lines].join('\n');
}
