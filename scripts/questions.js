/**
 * Every place the Ashby documentation did not answer the question and we had to assume.
 *
 * The build brief asks for exactly this: "Note every place you had to guess because the
 * documentation did not say. Those are the questions we take to Ashby."
 *
 * Ordered by blast radius. Questions the documentation has since answered were removed
 * rather than kept for volume — what is left is genuinely open.
 */

export const OPEN_QUESTIONS = [
  {
    topic: 'Custom fields as pipeline columns',
    risk: 'high',
    question: 'Can a custom field be added as a column in the candidate pipeline or Application Review, and can candidates be sorted by its value?',
    assumption:
      'That they can — our mockup shows Sam Role Fit as a sortable column. Your knowledge '
      + 'base does not support it: custom-field columns are documented for PROJECTS only, the '
      + 'Candidate Pipeline page never mentions columns, and the sole documented "add column" '
      + 'option on Application Review is Ashby’s own AI criteria percentage. Filtering by a '
      + 'custom field in Candidate Search IS documented, and so is using them in reports.',
    consequence:
      'This is the whole triage story. If a Sam score cannot be a sortable column, a graded '
      + 'pool does not arrive ranked — it arrives filterable, which is materially weaker and '
      + 'changes what we tell customers the product does. The alternatives look like Projects '
      + '(where columns are confirmed) or the assessment-partner card.',
  },
  {
    topic: 'Assessments Partner framework',
    risk: 'high',
    question: 'Is the Assessments Partner framework available to us, or should Sam use the take-home flow (takeHomeAssignmentSubmitted → takeHomeAssignment.info → applicationFeedback.submit) instead?',
    assumption:
      'That it exists, that `partnerId` is issued by Ashby, and that it is unavailable to us '
      + 'today. We built the request shape from the documentation but have never run it.',
    consequence:
      'This is probably the surface Ashby designed for a product like Sam — a native card of '
      + 'typed, labelled values rendered in Ashby’s own style. If it is reachable, it likely '
      + 'becomes the primary placement and the other versions become fallbacks. If it is not, '
      + 'our best in-Ashby option stays a PDF, and the partner application should say so.',
  },
  {
    topic: 'candidate.uploadFile',
    risk: 'medium',
    question: 'Does Ashby preview a file uploaded via candidate.uploadFile inline, or only offer a download?',
    assumption:
      'That it lands in the candidate’s Files list and renders in a document viewer without '
      + 'leaving the page. The document version’s 90% fidelity depends on a reviewer actually '
      + 'seeing it in situ.',
    consequence:
      'If it only downloads, the document stops being meaningfully different from the hosted '
      + 'link — both take the reviewer out of Ashby — and the case for generating a PDF at all '
      + 'gets weaker. Note this question no longer covers WHERE to write: the integration spec '
      + 'confirms candidate.uploadResume forcefully replaces the primary resume, which settles '
      + 'why we use uploadFile.',
  },
  {
    topic: 'candidateMerge',
    risk: 'high',
    question: 'Does a merge carry third-party custom fields, files and notes onto the surviving candidate, or drop them?',
    assumption:
      'That they do not transfer — ATS merges routinely drop third-party custom fields rather '
      + 'than reconcile a schema they do not own. Sam now handles candidateMerge with an '
      + 'idempotent re-sync: re-point our ledger to the surviving id, then re-assert the scores '
      + 'and the note against it.',
    consequence:
      'If Ashby does migrate them, our re-sync is redundant work we can delete. If it does not, '
      + 'the re-sync is the only thing standing between a merge and a scored candidate silently '
      + 'losing their score. Either way we would rather know than keep paying three API calls '
      + 'per merge for insurance.',
  },
  {
    topic: 'Embedded UI',
    risk: 'medium',
    question: 'Is there any way — private beta, partner-only, or planned — for an integration to render its own UI inside the candidate record?',
    assumption:
      'No. We found no documented embedded surface, so the highest-fidelity version we can '
      + 'offer is a link that takes the reviewer off-platform.',
    consequence:
      'If a panel or iframe surface exists it changes the product. The Snapshot could render '
      + 'live, interactive and in-brand where the reviewer already is, which is strictly better '
      + 'than all nine versions here, and we would rebuild around it.',
  },
  {
    topic: 'Scorecard semantics',
    risk: 'medium',
    question: 'If we submit a percentage to a Number field and leave Score unset, does the submission still appear in candidate-comparison and scorecard aggregation?',
    assumption:
      'That it does not, so we band our percentage onto Ashby’s 1–4 Score scale as well as '
      + 'sending the real number. We also assume a machine submission is visually '
      + 'distinguishable from a human scorecard.',
    consequence:
      'Aggregation is the entire reason to use this surface. If a Number-only submission is '
      + 'excluded, we are forced to quantise and lose resolution. And if a machine score is '
      + 'not visually distinct from a human one, it reads as a peer opinion in a comparison '
      + 'view — which we would rather not ship at all.',
  },
  {
    topic: 'Ashby AI Application Review',
    risk: 'medium',
    question: 'Is a partner write path into AI criteria evaluations planned, and how should Sam sit alongside Ashby’s own per-criterion AI review?',
    assumption:
      'That application.listCriteriaEvaluations is read-only and there is no write path.',
    consequence:
      'Ashby already ships per-requirement AI evaluation with outcome plus reasoning, which is '
      + 'structurally very close to Sam’s anchor model. That is either the natural home for our '
      + 'output or a direct overlap with the platform, and which one it is should shape the '
      + 'partner conversation rather than surface after we have built.',
  },
  {
    topic: 'Rate limits and idempotency',
    risk: 'medium',
    question: 'Is the idempotency-key header honoured on writes, and what are the limits outside the reporting module?',
    assumption:
      'That six writes per application is comfortably inside them. Sam retries 5xx with '
      + 'exponential backoff, never retries 4xx, and sends an idempotency key derived from '
      + 'webhookActionId on every write.',
    consequence:
      'A burst of applications could get throttled, and without knowing the limit we cannot '
      + 'size the queue or tell a customer how fast scoring keeps up. If writes are not '
      + 'idempotent, a retry after a partial failure could produce two notes and two files on '
      + 'the same candidate.',
  },
];

export const HIGH_RISK = OPEN_QUESTIONS.filter((q) => q.risk === 'high');
