/**
 * How Sam's read reaches an Ashby reviewer.
 *
 * TWO DISPLAY VERSIONS, separated by who does the rendering:
 *
 *   A · NOTE      we hand Ashby the content, Ashby draws it in its own house style.
 *                 One call. Read inline, no click. We give up every visual decision.
 *
 *   B · DOCUMENT  we hand Ashby a finished PDF, Ashby only displays the file.
 *                 Three calls. Every pixel of the design survives, behind a click.
 *
 * That is the whole trade-off, and it is why both exist: neither is strictly better.
 *
 * The third entry is not a display of the Snapshot at all — it is the score as typed
 * DATA, which is what makes a scored candidate sortable and filterable in the pipeline.
 * Kept distinct because comparing its fidelity against the two displays is a category
 * error: four numbers were never trying to carry the Snapshot.
 */
import { fidelityScore, lostFields } from './fields.js';
import { ENDPOINTS } from '../../shared/ashby-contract.js';

const PLACEMENTS = [
  {
    id: 'fields',
    kind: 'data',
    order: 3,
    name: 'Scores in Ashby’s own fields',
    endpoint: ENDPOINTS.setCustomFields,
    tab: 'Summary',
    appearsOn: 'Custom-field rows on the Summary tab; searchable and filterable',
    verified: {
      summaryTab: true,          // "candidate custom fields appear on the summary tab"
      searchFilter: true,        // Candidate Search filters on custom field values
      reports: true,             // Custom Fields KB: usable "in searches and reports"
      projectColumns: true,      // the one confirmed column surface
      pipelineColumn: false,     // NOT documented anywhere — see the questions list
      sortByValue: false,        // NOT documented for records, only for field options
    },
    job: 'Triage the list',
    survives: ['identity', 'matchScore', 'band', 'poolRank', 'coverage', 'capability'],
    caveat:
      'The only write Ashby can search and report on, which is what makes a graded candidate '
      + 'findable rather than just annotated. Filtering by a custom field value is confirmed; '
      + 'showing one as a sortable PIPELINE COLUMN is not — Ashby documents custom-field '
      + 'columns for Projects only, and the sole documented column on Application Review is '
      + 'their own AI criteria percentage. Treat the sortable-column view as unverified. It is '
      + 'also the most dangerous surface regardless, because numbers arrive with no evidence '
      + 'attached — which is why coverage ships as its own field.',
  },
  {
    id: 'note',
    kind: 'display',
    renderedBy: 'Ashby',
    order: 1,
    name: 'Rich note in the feed',
    endpoint: ENDPOINTS.createNote,
    tab: 'Feed',
    appearsOn: 'Inline in the activity feed — the default tab, read without a click',
    job: 'Read one candidate',
    survives: [
      'identity', 'matchScore', 'band', 'poolRank', 'coverage', 'nextStep',
      'capability', 'traits', 'anchors', 'evidence', 'coverageGaps', 'netRead', 'gaps',
      'interactive',
    ],
    caveat:
      'The version most likely to actually be read, because the feed is where a reviewer '
      + 'already is and nothing needs opening. Ashby renders embedded tables natively, so '
      + 'the anchors, the quoted evidence and the coverage gaps all survive as real tables '
      + '— this carries the reasoning, not just the score. What is lost is presentation: '
      + 'no CSS, no layout, no brand.',
  },
  {
    id: 'document',
    kind: 'display',
    renderedBy: 'Sam',
    order: 2,
    name: 'Snapshot as a document',
    endpoint: ENDPOINTS.uploadFile,
    tab: 'Files',
    appearsOn: 'The candidate’s Files list, opened in Ashby’s document viewer',
    job: 'Go deep on the evidence',
    // The reviewer opens one file and gets the judgement with the evidence underneath it.
    // Ashby's Files list has no ordering and no way to say "read this one first", so two
    // separate documents would leave the reviewer to relate them for themselves.
    binds: 'every document the candidate supplied, each behind its own divider page',
    survives: [
      'identity', 'matchScore', 'band', 'poolRank', 'coverage', 'nextStep',
      'experience', 'responsibility', 'roleLevel', 'careerHistory', 'capability',
      'traits', 'anchors', 'evidence', 'coverageGaps', 'skills', 'netRead', 'gaps',
      'layout', 'brand',
    ],
    caveat:
      'Everything designed survives, inside Ashby, with the quoted evidence behind every '
      + 'anchor, and the candidate’s own resume bound in behind a divider page so the '
      + 'judgement travels with its source. It is a frozen document: re-scoring against a '
      + 'changed rubric means a second file rather than an update, and Ashby keeps both. '
      + 'A resume sent as a Word document is typeset rather than reproduced — the divider '
      + 'page says so rather than implying a fidelity it does not have. Anything else they '
      + 'submitted binds in too, behind a divider that says plainly Sam did not score it: '
      + 'the engine reads the resume and the interview answers, and a document sitting '
      + 'behind a page captioned “source” would imply evidence the score never used.',
  },
];

/**
 * The one surface we deliberately do not write to.
 *
 * `candidate.uploadResume` targets the resume slot, which holds the document the candidate
 * uploaded themselves. CONFIRMED: that write FORCEFULLY REPLACES the primary document in
 * the central PDF viewer — it does not append. `candidate.uploadFile` puts the same PDF in
 * the Files tab instead, so there is nothing to trade away by refusing.
 */
export const REFUSED = {
  endpoint: ENDPOINTS.uploadResume,
  name: 'The resume slot',
  reason:
    'It is the best-looking placement in Ashby and we will not use it. Ashby confirms this '
    + 'write forcefully replaces the candidate’s own resume in the main viewer, and no score '
    + 'is worth overwriting a document they uploaded themselves.',
};

export const PLACEMENT_VERSIONS = PLACEMENTS
  .map((p) => ({
    ...p,
    fidelity: fidelityScore(p.survives),
    lost: lostFields(p.survives).map((f) => f.label),
  }))
  .sort((a, b) => a.order - b.order);

export const placementById = (id) => PLACEMENT_VERSIONS.find((p) => p.id === id) ?? null;

/** The two versions that actually display the Snapshot, in the order we present them. */
export const DISPLAY_VERSIONS = PLACEMENT_VERSIONS.filter((p) => p.kind === 'display');

/** The score as typed data. Not a display, and not comparable to one. */
export const DATA_VERSION = PLACEMENT_VERSIONS.find((p) => p.kind === 'data');

/** Fields that no surface carries — the honest floor of this integration. */
export function fieldsNoPlacementCarries() {
  const covered = new Set(PLACEMENT_VERSIONS.flatMap((p) => p.survives));
  return lostFields([...covered]).map((f) => f.label);
}

/** Fields carried by exactly one surface, so losing it loses them. */
export function singlePointFields() {
  const count = new Map();
  for (const p of PLACEMENT_VERSIONS) for (const f of p.survives) count.set(f, (count.get(f) ?? 0) + 1);
  return [...count.entries()].filter(([, n]) => n === 1).map(([f]) => f);
}
