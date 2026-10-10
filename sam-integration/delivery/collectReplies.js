/**
 * Reads the answers people left in Ashby, and records them.
 *
 * Lives here rather than in the script because it has to run from TWO places, and the second
 * one is the one that matters: a scheduled pass that grades new applicants must also collect
 * replies, or the loop only closes when somebody remembers to run a command by hand.
 *
 * WHERE THIS HAS TO RUN IN A PASS. Before the gate, and before any early exit. A pipeline in
 * steady state has nobody new to score — every applicant is already delivered and the run
 * stops at "nobody new". That is exactly the state a real client sits in most days, and it
 * is precisely when replies are arriving. Collecting after the gate means the answers are
 * read on the days they are least likely to exist.
 *
 * SAFE TO RUN REPEATEDLY, which is what makes it schedulable:
 *   · a reply already written back about is skipped, by note id
 *   · answers are keyed by question id, so re-reading one changes nothing
 *   · a reply that does not parse is left open and reported, never guessed at
 */
import { ENDPOINTS } from '../../shared/ashby-contract.js';
import { post as defaultPost } from '../endpoints/client.js';
import { readReply, refFor } from './followUp.js';
import { openQuestionsFor } from './openQuestions.js';
import {
  conversationFor, recordAnswer, recordAcknowledged, wasAcknowledged,
  resolvePositions, unansweredFrom,
} from './conversation.js';
import { composeAcknowledgement, writeConfirmedField } from './acknowledge.js';

/** What happened to one candidate on one pass. */
export const REPLY = {
  notAsked: 'not-asked',
  waiting: 'waiting',
  alreadyRecorded: 'already-recorded',
  unparseable: 'unparseable',
  recorded: 'recorded',
  read: 'read',
};

/**
 * @param {object[]} rows      ledger entries, each {candidateId, jobId, applicationId, snapshot}
 * @param {boolean}  write     false reads and reports without touching the record
 * @param {function} onResult  called per candidate so a caller can print its own way
 */
export async function collectReplies({ rows, write = false, post = defaultPost, onResult = () => {} }) {
  const summary = { recorded: 0, waiting: 0, unparseable: 0, read: 0 };

  for (const row of rows) {
    const { candidateId, jobId, applicationId } = row;
    const name = row.snapshot?.candidate?.name ?? String(candidateId).slice(0, 8);
    const convo = conversationFor(candidateId, jobId);
    const emit = (outcome, extra = {}) => onResult({ outcome, name, candidateId, jobId, ...extra });

    if (!convo.asked.length) { emit(REPLY.notAsked); continue; }

    const notes = await post(ENDPOINTS.listNotes, { candidateId });

    // Scoped to the CURRENT asking. The reference is derived from the candidate and the job,
    // so every set of questions ever put on this pairing carries the same one — without
    // `after`, a reply from a previous round is read as an answer to today's items.
    const reply = readReply(
      notes, convo.ref ?? refFor(candidateId, jobId), convo.asked.length, null,
      { after: convo.askedAt },
    );

    if (!reply) { summary.waiting += 1; emit(REPLY.waiting); continue; }
    if (wasAcknowledged(candidateId, jobId, reply.noteId)) { emit(REPLY.alreadyRecorded); continue; }

    const resolved = resolvePositions(candidateId, jobId, reply.answers, reply.blanket);
    if (!resolved.length) { summary.unparseable += 1; emit(REPLY.unparseable, { reply }); continue; }

    if (!write) { summary.read += 1; emit(REPLY.read, { reply, resolved, asked: convo.asked.length }); continue; }

    for (const r of resolved) {
      recordAnswer({
        candidateId, jobId, questionId: r.questionId, confirmed: r.confirmed,
        by: reply.by, at: reply.at, noteId: reply.noteId,
      });
    }

    const stillOpen = unansweredFrom(openQuestionsFor(row.snapshot, jobId), candidateId, jobId);
    const html = composeAcknowledgement({ candidateName: name, resolved, reply, stillOpen });

    await post(ENDPOINTS.createNote, {
      candidateId, note: { type: 'text/html', value: html }, sendNotifications: false,
    });

    // Written only after the note is actually on the record. Marking it acknowledged first
    // would lose the reply permanently if the post failed — the next pass would skip it.
    recordAcknowledged({ candidateId, jobId, noteId: reply.noteId });

    const field = await writeConfirmedField({ applicationId, candidateId, jobId });
    summary.recorded += 1;
    emit(REPLY.recorded, { reply, resolved, stillOpen, field, asked: convo.asked.length });
  }

  return summary;
}

/** The ledger rows worth asking about — the ones carrying a snapshot. */
export const replyCandidatesFrom = (ledgerText) => ledgerText.trim().split('\n')
  .filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((r) => r?.snapshot && r?.candidateId && r?.jobId);
