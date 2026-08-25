/**
 * Rubric compiled from "Sales Account Executive.pdf".
 *
 * Each anchor declares which survey questions could evidence it. Anchors with no
 * mapped question — or whose mapped questions collected no answers — resolve to
 * NOT_COLLECTED and are excluded from the score denominator rather than counted
 * as failures. That distinction is the point of the whole engine.
 */

export const STATE = {
  MET: 'MET',
  PARTIAL: 'PARTIAL',
  NOT_MET: 'NOT_MET',
  NOT_COLLECTED: 'NOT_COLLECTED',
};

/** Credit awarded per state. NOT_COLLECTED is excluded from both numerator and denominator. */
export const STATE_CREDIT = { MET: 1, PARTIAL: 0.5, NOT_MET: 0 };

export const ROLE = {
  title: 'Sales Account Executive',
  company: 'Agree',
  source: 'data/Sales Account Executive.pdf',
};

export const ANCHORS = [
  {
    id: 'A4',
    label: '$5M+ annualized invoice volume',
    detail: 'Consistently carried and hit $5M+ in Annualized Invoice Volume; closed multiple six-figure AIV deals.',
    weight: 0.25,
    evidencedBy: ['Q4'],
    signals: ['quantifiedVolume'],
  },
  {
    id: 'A2',
    label: 'Self-sourced outbound pipeline',
    detail: 'Generates pipeline through outbound and strategic prospecting rather than waiting for it.',
    weight: 0.20,
    evidencedBy: ['Q3', 'Q5'],
    signals: ['sequencedProcess', 'namedTool', 'statedOutcome'],
  },
  {
    id: 'A1',
    label: 'Full-cycle ownership through close',
    detail: 'Owns the full sales cycle from outbound prospecting through signed contract and expansion.',
    weight: 0.15,
    evidencedBy: ['Q1', 'Q2'],
    signals: ['fullCycle', 'statedOutcome'],
  },
  {
    id: 'A3',
    label: 'Finance and executive stakeholders',
    detail: 'Runs structured discovery and multi-stakeholder conversations with Finance and executive buyers.',
    weight: 0.15,
    evidencedBy: ['Q2', 'Q6'],
    signals: ['namedCounterparty', 'objectionHandling'],
  },
  {
    id: 'A5',
    label: 'Fintech and payments domain',
    detail: 'Background at Brex, Ramp, Plaid, Mercury, Flex or similar; sells payments/invoicing products.',
    weight: 0.15,
    evidencedBy: ['Q1'],
    signals: ['fintechEmployer', 'paymentsDomain'],
  },
  {
    id: 'A6',
    label: 'Competitive displacement',
    detail: 'Demonstrated ability to win competitive deals and displace incumbents.',
    weight: 0.10,
    evidencedBy: [], // No survey question maps to this anchor.
    signals: ['competitiveWin'],
  },
];

/** Core Skills from the JD, rendered as the Snapshot's Additional Skills chips. */
export const CORE_SKILL_TOOLS = {
  crm: ['HubSpot', 'Salesforce', 'Close'],
  sequencing: ['Apollo', 'Clay', 'Instantly', 'Outreach'],
};

export const TOTAL_WEIGHT = ANCHORS.reduce((sum, a) => sum + a.weight, 0);

/** Lowercases a label for sentence flow while preserving figures and acronyms ($5M+, AIV, CRM). */
export const softLower = (label) =>
  label.split(' ').map((w) => (/\d/.test(w) || /[A-Z]{2,}/.test(w) ? w : w.toLowerCase())).join(' ');
