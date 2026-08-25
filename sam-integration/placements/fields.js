/**
 * The Snapshot's field inventory, taken from Sam_Resume_Snapshot_Design.pdf.
 *
 * This list is the measuring stick for the whole build. Every placement surface
 * declares which of these fields it can actually carry, which is how we answer the
 * brief's central question — "be honest about what is lost at each level".
 */

export const SNAPSHOT_FIELDS = [
  { id: 'identity',      label: 'Name, role, company',        group: 'header',   weight: 1 },
  { id: 'matchScore',    label: 'Match percentage',           group: 'header',   weight: 3 },
  { id: 'band',          label: 'Band (Strong / Moderate)',   group: 'header',   weight: 2 },
  { id: 'poolRank',      label: 'Top N% of pool',             group: 'header',   weight: 2 },
  { id: 'coverage',      label: 'Evidence coverage',          group: 'header',   weight: 3 },
  { id: 'nextStep',      label: 'Recommended next step',      group: 'summary',  weight: 3 },
  { id: 'experience',    label: 'Experience match',           group: 'fit',      weight: 2 },
  { id: 'responsibility',label: 'Responsibility match',       group: 'fit',      weight: 2 },
  { id: 'roleLevel',     label: 'Role level fit + suggestions',group: 'fit',     weight: 2 },
  { id: 'careerHistory', label: 'Career history',             group: 'body',     weight: 3 },
  { id: 'capability',    label: 'Capability score',           group: 'body',     weight: 3 },
  { id: 'traits',        label: 'How they work (traits)',     group: 'body',     weight: 2 },
  { id: 'anchors',       label: 'Role anchors met',           group: 'body',     weight: 3 },
  { id: 'evidence',      label: 'Quoted evidence spans',      group: 'body',     weight: 3 },
  { id: 'coverageGaps',  label: 'Coverage gaps table',        group: 'body',     weight: 2 },
  { id: 'skills',        label: 'Additional skills',          group: 'body',     weight: 1 },
  { id: 'netRead',       label: 'Net read',                   group: 'summary',  weight: 3 },
  { id: 'gaps',          label: 'Gaps to investigate',        group: 'summary',  weight: 3 },
  { id: 'audio',         label: 'Interview audio playback',   group: 'media',    weight: 2 },
  { id: 'resumeLink',    label: 'Original resume',            group: 'media',    weight: 1 },
  { id: 'layout',        label: 'Visual layout and hierarchy',group: 'design',   weight: 3 },
  { id: 'brand',         label: 'Sam brand identity',         group: 'design',   weight: 1 },
  { id: 'interactive',   label: 'Interactivity (links, tabs)',group: 'design',   weight: 2 },
];

export const FIELD_BY_ID = new Map(SNAPSHOT_FIELDS.map((f) => [f.id, f]));
export const TOTAL_FIELD_WEIGHT = SNAPSHOT_FIELDS.reduce((n, f) => n + f.weight, 0);

/** Weighted share of the Snapshot that a given set of surviving field ids preserves. */
export function fidelityScore(survivingIds) {
  const kept = new Set(survivingIds);
  const earned = SNAPSHOT_FIELDS.reduce((n, f) => n + (kept.has(f.id) ? f.weight : 0), 0);
  return Math.round((earned / TOTAL_FIELD_WEIGHT) * 100);
}

/** The fields a placement drops, derived rather than hand-maintained alongside the keeps. */
export function lostFields(survivingIds) {
  const kept = new Set(survivingIds);
  return SNAPSHOT_FIELDS.filter((f) => !kept.has(f.id));
}
