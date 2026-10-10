/**
 * What was asked about a candidate, and what a person answered.
 *
 * Append-only JSONL, replayed on load, same shape as the delivery ledger and for the same
 * reason: this is the only thing standing between a restart and asking somebody the same
 * question twice, or recording their answer twice.
 *
 * TWO ROW KINDS, folded together per (candidate, job):
 *
 *   {kind:'asked'}     a numbered set went onto the record, with stable ids per question
 *   {kind:'answered'}  a person resolved one of them — with WHO and WHEN, always
 *
 * WHY THE ASKED SET IS STORED AND NOT RECOMPUTED. A reply is positional: somebody types
 * `1Y 2N` into Ashby. The questions are derived from a grading, and gradings change — Sam
 * re-scores, a job description is edited, an anchor moves from NOT_MET to MET. Recomputing
 * the list at read time and applying `1Y` to whatever is now first would put a person's
 * answer on a requirement they never saw, under their name, on a hiring record. So the set
 * that was actually shown is written down, and a reply is resolved against that.
 *
 * ANSWERS ARE NEVER OVERWRITTEN, ONLY APPENDED. If somebody answers the same question twice
 * the later answer wins on replay, and both remain in the file — because "they said yes and
 * then corrected it to no" is a thing a hiring record should be able to reconstruct.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Read at call time, not at import. A module-level constant bakes in whatever the
// environment was when the file was first imported, which makes this untestable without a
// separate process and silently writes test rows into the real store.
const FILE = () => process.env.SAM_CONVERSATIONS ?? '.sam/conversations.jsonl';

const keyOf = (candidateId, jobId) => `${candidateId}::${jobId}`;
const byCandidateJob = new Map();
let loaded = false;

const blank = () => ({ asked: [], answers: new Map(), acknowledged: [] });

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  if (!existsSync(FILE())) return;
  try {
    for (const line of readFileSync(FILE(), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { fold(JSON.parse(line)); } catch { /* one bad line must not cost the file */ }
    }
  } catch { /* unreadable degrades to in-memory, which the caller notices as re-asking */ }
}

function fold(row) {
  if (!row?.candidateId || !row?.jobId) return;
  const key = keyOf(row.candidateId, row.jobId);
  const state = byCandidateJob.get(key) ?? blank();

  if (row.kind === 'asked') {
    // The latest asking replaces the earlier one: it is what the person is looking at.
    state.asked = row.questions ?? [];
    state.ref = row.ref ?? state.ref;
    state.askedAt = row.at ?? state.askedAt;
  } else if (row.kind === 'answered' && row.questionId) {
    state.answers.set(row.questionId, {
      questionId: row.questionId,
      confirmed: row.confirmed === true,
      by: row.by ?? null,
      at: row.at ?? null,
      noteId: row.noteId ?? null,
    });
  } else if (row.kind === 'acknowledged' && row.noteId) {
    // Which reply we have already written back about, so we never post the same
    // acknowledgement twice when the loop runs on a schedule.
    if (!state.acknowledged.includes(row.noteId)) state.acknowledged.push(row.noteId);
  }

  byCandidateJob.set(key, state);
}

function append(row) {
  ensureLoaded();
  fold(row);
  try {
    mkdirSync(dirname(FILE()), { recursive: true });
    appendFileSync(FILE(), `${JSON.stringify(row)}\n`);
  } catch {
    return { ...row, persisted: false };
  }
  return row;
}

/** @returns {{asked: object[], answers: Map<string, object>, acknowledged: string[], ref?: string}} */
export function conversationFor(candidateId, jobId) {
  ensureLoaded();
  return byCandidateJob.get(keyOf(candidateId, jobId)) ?? blank();
}

/**
 * Records the numbered set that went onto the record.
 *
 * @param {object[]} questions in the order shown, each {id, label, source}
 */
export const recordAsked = ({ candidateId, jobId, ref, questions, at = new Date().toISOString() }) =>
  append({
    kind: 'asked',
    candidateId,
    jobId,
    ref,
    at,
    questions: questions.map((q, i) => ({ n: i + 1, id: q.id, label: q.label, source: q.source })),
  });

/** Records one resolved question. `by` is kept whole — attribution is the point. */
export const recordAnswer = ({ candidateId, jobId, questionId, confirmed, by, at, noteId }) =>
  append({ kind: 'answered', candidateId, jobId, questionId, confirmed, by, at, noteId });

/** Marks a reply as written back about, so a scheduled run does not acknowledge it again. */
export const recordAcknowledged = ({ candidateId, jobId, noteId }) =>
  append({ kind: 'acknowledged', candidateId, jobId, noteId });

/** Has this particular reply already been answered on the record? */
export const wasAcknowledged = (candidateId, jobId, noteId) =>
  conversationFor(candidateId, jobId).acknowledged.includes(noteId);

/** Every question this candidate has a recorded answer to. */
export const answeredIds = (candidateId, jobId) =>
  new Set(conversationFor(candidateId, jobId).answers.keys());

/**
 * The questions still worth asking, in Sam's order of value.
 *
 * Answered ones drop out, which is what makes the conversation move: a second pass asks the
 * NEXT three rather than the same three, so a long tail of open items gets worked through
 * instead of the first three being asked forever.
 */
export function unansweredFrom(questions, candidateId, jobId) {
  const done = answeredIds(candidateId, jobId);
  return questions.filter((q) => !done.has(q.id));
}

/** Resolves a positional reply against the set that was actually shown. */
export function resolvePositions(candidateId, jobId, answersByNumber, blanket) {
  const { asked } = conversationFor(candidateId, jobId);
  const out = [];
  for (const q of asked) {
    const given = answersByNumber?.has(q.n) ? answersByNumber.get(q.n) : blanket;
    if (given === null || given === undefined) continue;
    out.push({ questionId: q.id, label: q.label, confirmed: given, n: q.n });
  }
  return out;
}

/** Only for tests. */
export const resetConversations = ({ reload = false } = {}) => { byCandidateJob.clear(); loaded = !reload; };
export const conversationFile = () => FILE();
