/**
 * Ashby candidate-record screen specification.
 *
 * The build brief makes Ashby's own screens the canvas: the Snapshot has to be shown
 * "at real size, in the space it would actually occupy, next to whatever else is
 * already on that screen". These are the measurements that mockup is drawn from.
 *
 * PROVENANCE. Region names, the tab list, the action bar and the location of custom
 * fields come from Ashby's own knowledge base and are marked `confirmed: true`. Every
 * PIXEL FIGURE is an estimate reconciled from product screenshots — Ashby publishes no
 * dimensions, and one KB page explicitly declines to describe a strict panel layout.
 * Those estimates are carried into the questions-for-Ashby list rather than presented
 * as fact.
 *
 * Note in particular: there is no evidence of a persistent right rail. Job and
 * application context is reached through a "Considered for jobs" switcher and the
 * Application tab, not a third column.
 */

export const VIEWPORT = { width: 1440, height: 900 };

export const CHROME = {
  /** Ashby's global product navigation, present on every screen. Estimate. */
  globalNavWidth: 224,
  /** The candidate header spans the detail rail and the feed. Estimate. */
  headerHeight: 104,
  /** The candidate detail rail — this is the "Summary" tab. Estimate. */
  detailRailWidth: 336,
  tabBarHeight: 42,
  get feedWidth() {
    return VIEWPORT.width - this.globalNavWidth - this.detailRailWidth;
  },
};

/** Ashby's global navigation. Confirmed from the knowledge base. */
export const GLOBAL_NAV = [
  'Home', 'Candidate Pipeline', 'Jobs', 'Candidates', 'Interviews', 'Analytics',
];

/**
 * Action bar on the candidate header. Confirmed.
 * Ashby archives rather than offering a labelled "Reject" on the profile —
 * Advance/Reject appear only in bulk Application Review.
 */
export const ACTION_BAR = [
  { label: 'New activity', kind: 'default' },
  { label: 'New interview', kind: 'default' },
  { label: 'Email', kind: 'default' },
  { label: 'Change stage', kind: 'primary' },
  { label: 'Archive', kind: 'danger' },
  { label: 'More', kind: 'ghost' },
];

/** Centre-column tabs. Confirmed; Feed is the default landing view. */
export const TABS = [
  'Feed', 'Notes', 'Emails', 'Texts', 'Feedback', 'Referrals', 'Forms', 'Application', 'AI',
];

/**
 * Native attributes Ashby already shows on the Summary tab, before any integration
 * writes anything. Confirmed from the knowledge base.
 */
export const NATIVE_SUMMARY = [
  { label: 'Email', value: (c) => c.email ?? '—' },
  { label: 'Phone', value: () => '—' },
  { label: 'Location', value: (c) => c.location ?? '—' },
  { label: 'LinkedIn', value: (c) => (c.linkedin ? 'View profile' : '—'), link: true },
  { label: 'Source', value: () => 'Job Board' },
  { label: 'Credited to', value: () => '—' },
  { label: 'Applied', value: () => 'Dec 11, 2025' },
];

/**
 * Where each of the three surfaces lands, and how much room it gets there.
 * `heightPx` is the vertical space the placement occupies once rendered.
 */
export const PLACEMENT_SLOTS = {
  document: {
    tab: 'Files',
    label: 'Files list → Ashby document viewer',
    widthPx: CHROME.feedWidth - 48,
    heightPx: 640,
    confirmed: false,
    note: 'Assumes Ashby previews PDFs inline. If it only offers a download, this version collapses to a link.',
  },
  note: {
    tab: 'Feed',
    label: 'Activity feed → note body (HTML)',
    widthPx: CHROME.feedWidth - 48,
    heightPx: 420,
    confirmed: false,
    note: 'Rendered after the sanitiser. The allow-list modelled here is a guess.',
  },
  fields: {
    tab: 'Summary',
    label: 'Summary tab → custom field rows',
    widthPx: CHROME.detailRailWidth - 40,
    heightPx: 140,
    confirmed: true,
    note: 'Confirmed location. About 300px of usable value width, so long values wrap.',
  },
};

/** Everything below is an estimate rather than documented fact. */
export function unconfirmedMeasurements() {
  return Object.entries(PLACEMENT_SLOTS)
    .filter(([, v]) => !v.confirmed)
    .map(([id, v]) => ({ id, label: v.label, note: v.note }));
}
