/**
 * Every place the Ashby documentation did not answer the question and we had to assume.
 *
 * The build brief asks for exactly this: "Note every place you had to guess because the
 * documentation did not say. Those are the questions we take to Ashby."
 *
 * ONE FILTER, applied hard: a question earns its place only if Ashby is the only party who
 * can answer it. Anything a careful read of the public documentation settles, and anything
 * a trial account would settle in five minutes, is our work rather than theirs — asking it
 * wastes their partner team's time and reads as not having done the reading.
 *
 * That is what `whyAshby` is for. If a question cannot state plainly why it cannot be
 * answered anywhere else, it does not belong on the list. A test enforces it.
 *
 * Ordered by blast radius: what changes about what we build if the answer goes the other way.
 */

export const OPEN_QUESTIONS = [
  {
    topic: 'Custom fields as sortable columns',
    risk: 'high',
    question:
      'Can a custom field be added as a column in the candidate pipeline or on Application '
      + 'Review, and can candidates be sorted by its value?',
    assumption:
      'That they can — our mockup shows Sam Role Fit as a sortable column. Your own knowledge '
      + 'base points the other way: custom-field columns are documented for PROJECTS only, the '
      + 'Candidate Pipeline page never mentions columns at all, and the sole documented '
      + '"add column" option on Application Review is Ashby’s own AI criteria percentage. '
      + 'Filtering by a custom field in Candidate Search IS documented, and so is using them '
      + 'in reports — so we know what works, we do not know where it stops.',
    whyAshby:
      'The documentation is silent rather than negative, and silence is not an answer we can '
      + 'act on. Only you know whether this is unsupported, undocumented, or planned.',
    consequence:
      'This is the whole triage story. If a Sam score cannot be a sortable column, a graded '
      + 'pool does not arrive ranked — it arrives filterable, which is materially weaker and '
      + 'changes what we tell customers the product does.',
  },
  {
    topic: 'Projects as the ranked-triage pattern',
    risk: 'high',
    question:
      'If pipeline columns are not possible, is moving graded candidates into a Project the '
      + 'pattern you intend for a partner who wants ranked triage — or is there a better one '
      + 'we have not found?',
    assumption:
      'That Projects are the workaround, because they are the one surface where custom-field '
      + 'columns are confirmed in your documentation. We did not build it: it moves candidates '
      + 'into a parallel list rather than improving the record they already have, and that is '
      + 'a workflow change we would rather agree with you than impose on a customer.',
    whyAshby:
      'This is a question about intended product usage, not about capability. The docs '
      + 'describe what Projects do; only you can say whether this is the road you want '
      + 'partners on.',
    consequence:
      'It is the difference between a supported pattern and a clever workaround we support '
      + 'forever. If Projects are the answer we will build it properly; if they are not, we '
      + 'need to know what is.',
  },
  {
    topic: 'Assessments Partner framework',
    risk: 'high',
    question:
      'Is the Assessments Partner framework open to us, and is `partnerId` something you '
      + 'issue? If it is not available, is the take-home flow '
      + '(takeHomeAssignmentSubmitted → takeHomeAssignment.info → applicationFeedback.submit) '
      + 'the route you would point us at instead?',
    assumption:
      'That it exists, that you issue the credential, and that it is not open to us today. '
      + 'We built the request shape from the documentation and have never been able to run it.',
    whyAshby:
      'Access is granted by you. No amount of reading or testing tells us whether we are '
      + 'eligible.',
    consequence:
      'This is probably the surface you designed for a product like Sam — a native card of '
      + 'typed, labelled values in Ashby’s own style. If it is reachable it likely becomes the '
      + 'primary placement and everything else becomes a fallback. If it is not, our best '
      + 'in-product option stays a PDF. This is the question the account decision turns on.',
  },
  {
    topic: 'What a candidateMerge carries',
    risk: 'high',
    question:
      'When two candidates are merged, do third-party custom field values, uploaded files and '
      + 'notes move to the surviving record, or are they dropped?',
    assumption:
      'That they are dropped — ATS merges routinely discard third-party custom fields rather '
      + 'than reconcile a schema they do not own. So Sam handles candidateMerge with an '
      + 'idempotent re-sync: re-point our ledger to the surviving id, then re-assert the '
      + 'scores and the note against it.',
    whyAshby:
      'Merge behaviour for third-party data is not documented, and we cannot observe it '
      + 'without two duplicate records in a live account and a merge we are willing to perform.',
    consequence:
      'If you do migrate them, our re-sync is redundant work we can delete. If you do not, it '
      + 'is the only thing standing between a merge and a scored candidate silently losing '
      + 'their score.',
  },
  {
    topic: 'Clearing a custom field value',
    risk: 'high',
    question:
      'How does an integration clear a custom field value it has already written? Is '
      + '`fieldValue: null` accepted by customField.setValues, or is there another way to '
      + 'unset one?',
    assumption:
      'That null clears it. Your per-type table says what to send to SET each field type and '
      + 'is silent on removing a value. We need this because a score is not permanent: a '
      + 'candidate re-scored on thinner evidence has to lose the number we published last '
      + 'time, and setValues merges — skipping the field leaves the old value in place. So '
      + 'we send null, and if you reject it we write the remaining fields on their own and '
      + 'report that the clear did not land, rather than silently losing them too.',
    whyAshby:
      'The documentation covers setting values and not unsetting them, and the only way to '
      + 'find out otherwise is to write a value into a live account and try to remove it.',
    consequence:
      'This is the one that can put wrong data in front of a hiring manager. A stale Role Fit '
      + 'sits in a filterable column attached to a read that no longer supports it, with '
      + 'nothing on the record marking it as old — worse than the misleading number we '
      + 'refused to write in the first place, because at least that one was current.',
  },
  {
    topic: 'Ashby’s own AI Application Review',
    risk: 'medium',
    question:
      'Is a partner write path into AI criteria evaluations planned? And how would you want a '
      + 'product like Sam to sit alongside your own per-criterion review?',
    assumption:
      'That application.listCriteriaEvaluations is read-only and no write path exists today.',
    whyAshby:
      'Roadmap and positioning. Neither is knowable from outside, and getting it wrong means '
      + 'building into a lane you intend to occupy yourselves.',
    consequence:
      'Your AI already ships per-requirement evaluation with outcome plus reasoning, which is '
      + 'structurally close to Sam’s anchor model — but it reads only résumés and '
      + 'application-form answers, and Sam is built on voice interviews. That is either the '
      + 'natural home for our output or a direct overlap, and which one should shape the '
      + 'partner conversation rather than surface after we have built.',
  },
  {
    topic: 'Any embedded surface at all',
    risk: 'medium',
    question:
      'Is there any way — private beta, partner-only, or on the roadmap — for an integration '
      + 'to render its own UI inside the candidate record?',
    assumption:
      'No. We found no documented embedded surface, so the highest-fidelity version we can '
      + 'offer is a link that takes the reviewer off-platform.',
    whyAshby:
      'An unreleased or partner-gated surface is by definition absent from the public docs. '
      + 'Only you know whether one exists.',
    consequence:
      'If a panel or iframe surface exists it changes the product. The Snapshot could render '
      + 'live, interactive and in-brand where the reviewer already is — strictly better than '
      + 'every version we built, and we would rebuild around it.',
  },
  {
    topic: 'Limits outside reporting, and retry safety',
    risk: 'medium',
    question:
      'Your reporting limits are published — 15 generations a minute, 3 concurrent. What '
      + 'applies to ordinary reads and writes? And is an idempotency key honoured on write '
      + 'endpoints, or should we assume retries can double-write?',
    assumption:
      'That six writes per application sits comfortably inside whatever the limit is. Sam '
      + 'retries 5xx with exponential backoff, never retries 4xx, and sends an idempotency key '
      + 'derived from webhookActionId on every write — while assuming you may ignore it.',
    whyAshby:
      'The reporting limits are the only ones published. General limits and idempotency '
      + 'behaviour are not documented anywhere, and probing them in production is exactly the '
      + 'thing we should not do to find out.',
    consequence:
      'A burst of applications could get throttled, and without a number we cannot size a '
      + 'queue or tell a customer how fast scoring keeps up. If writes are not idempotent, a '
      + 'retry after a partial failure produces two notes and two files on one candidate — '
      + 'which is why createNote checks the feed before posting.',
  },
  {
    topic: 'Scorecards from a machine',
    risk: 'medium',
    question:
      'If we submit a percentage to a Number field and leave Score unset, does the submission '
      + 'still count in candidate comparison and scorecard aggregation? And is a submission '
      + 'from an integration visually distinguishable from a human scorecard?',
    assumption:
      'That a Number-only submission is excluded, so we would band our percentage onto the '
      + '1–4 Score scale as well as sending the real number. And that a machine submission is '
      + 'marked as one.',
    whyAshby:
      'Aggregation rules are internal behaviour, and the second half is a product-design '
      + 'question about how you present integration output to a hiring team.',
    consequence:
      'Only bites if the Assessments framework is closed to us and we fall back to feedback. '
      + 'If aggregation excludes a Number-only submission we lose resolution; and if a machine '
      + 'score is not visually distinct it reads as a peer opinion in a comparison view — '
      + 'which we would rather not ship at all.',
  },
  {
    topic: 'file.createFileUploadHandle’s schema',
    risk: 'low',
    question:
      'Your endpoint reference does not publish the request parameter names for '
      + 'file.createFileUploadHandle — can you confirm them?',
    assumption:
      'fileUploadContext, filename, contentType, contentLength — taken from the integration '
      + 'architecture spec rather than the endpoint docs, and isolated in one object in our '
      + 'contract so a correction is a one-line edit.',
    whyAshby:
      'It is a genuine gap in the published reference, not something we skipped. We have it '
      + 'working against our own stand-in, which proves the shape is self-consistent and '
      + 'proves nothing about yours.',
    consequence:
      'Low. The file flow is three calls and this is the first one; if the names differ we '
      + 'change four strings. Worth confirming so we are not depending on a guess in '
      + 'production.',
  },
];

export const HIGH_RISK = OPEN_QUESTIONS.filter((q) => q.risk === 'high');
