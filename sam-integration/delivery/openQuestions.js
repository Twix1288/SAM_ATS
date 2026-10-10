/**
 * What Sam does not know about a candidate, as questions a person can answer.
 *
 * Sam tells us about its own uncertainty in two different places, and they are not the same
 * kind of thing:
 *
 *   NOT_MET / NOT_COLLECTED ANCHORS — requirements of the job that Sam found no evidence
 *     for. These are the ones holding the score down. Jamar Herzog sits at 65% because three
 *     core anchors are NOT_MET; a recruiter who knows he ran committee deals is holding the
 *     single most valuable fact about that grading.
 *
 *   `what_to_confirm` — things Sam DID see but could not verify. A $6M budget listed once, a
 *     title that went backwards, a template placeholder left in the résumé. Lower stakes,
 *     still worth asking, and already phrased as a thing to establish.
 *
 * Both are asked. They are ordered by how much an answer would move the grading, because a
 * reviewer answers the first two or three and stops — so the order decides what we learn.
 *
 * WHY QUESTIONS CARRY AN ID AND NOT JUST A POSITION. A reply is positional: somebody types
 * `1Y 2N`. If the question set is rebuilt between the asking and the answering — a re-score,
 * an edited job description, a new anchor — then position 1 is a different question and the
 * answer lands on the wrong requirement, silently, attributed to a named person. So the set
 * that was ASKED is recorded with stable ids, and a reply is resolved against that record
 * rather than against whatever the questions are now.
 */
import { createHash } from 'node:crypto';

/** Where a question came from. Kept on the question because the two read differently. */
export const SOURCE = {
  /** A requirement of the job Sam found no evidence for. Answering can change the grading. */
  anchor: 'anchor',
  /** Something Sam saw but could not verify. Answering corrects the record. */
  confirm: 'confirm',
};

/**
 * Stable across re-scores, so an answer given today still binds tomorrow.
 *
 * Derived from the job and the requirement rather than from the wording of Sam's reason —
 * the reason is regenerated on every grading and is not stable, the requirement is.
 */
export const questionIdFor = (jobId, label) =>
  `q:${createHash('sha256').update(`${jobId}:${normalise(label)}`).digest('hex').slice(0, 8)}`;

const normalise = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/** States worth asking about. MET and PARTIAL already have evidence behind them. */
const ASKABLE = new Set(['NOT_MET', 'NOT_COLLECTED']);

/**
 * Every open question on a grading, best first.
 *
 * @param {object} snapshot the view model, as delivered
 * @param {string} jobId    the Ashby job — part of every question id
 * @returns {{id, label, reason, source, core, weight}[]}
 */
export function openQuestionsFor(snapshot, jobId) {
  const seen = new Set();
  const out = [];

  const add = (q) => {
    const key = normalise(q.label);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ ...q, id: questionIdFor(jobId, q.label) });
  };

  // 1. The requirements holding the score down, heaviest first. `core` outranks weight
  //    because a missing core anchor is what applies Sam's cap — a non-core anchor at a
  //    higher weight still cannot move the band on its own.
  const anchors = (snapshot?.roleAnchors ?? [])
    .filter((a) => ASKABLE.has(a.state))
    .sort((a, b) => (b.core === true) - (a.core === true) || (b.weight ?? 0) - (a.weight ?? 0));

  for (const a of anchors) {
    add({
      label: a.label ?? a.id,
      reason: a.reason ?? '',
      source: SOURCE.anchor,
      core: a.core === true,
      weight: a.weight ?? 0,
      state: a.state,
    });
  }

  // 2. Then what Sam saw but could not stand behind.
  for (const g of snapshot?.gapsToInvestigate ?? []) {
    add({ label: g.label, reason: g.reason ?? '', source: SOURCE.confirm, core: false, weight: 0 });
  }

  return out;
}

/**
 * How a question is phrased on the record.
 *
 * An anchor is a thing the job asks for that Sam could not find, so it is asked as a yes/no
 * about the person. A `what_to_confirm` item is already written as a thing to establish, so
 * Sam's own wording is kept — rewriting it would lose the specificity that makes it useful.
 */
export const askOf = (q) => (q.source === SOURCE.anchor
  ? `Have they done this? ${q.label}`
  : q.label);

/**
 * What answering would be worth, in words, for the reviewer deciding whether to bother.
 *
 * Only said for the anchors that actually gate the band. Putting "may change the grading" on
 * every line would make it noise, and putting it on a line where it is not true would be a
 * promise the next grading breaks.
 */
export const impactOf = (q) => (q.source === SOURCE.anchor && q.core
  ? 'core requirement'
  : null);
