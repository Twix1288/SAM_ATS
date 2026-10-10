/**
 * The candidate's activity feed, used as a conversation.
 *
 * Sam always has open questions — the things a résumé cannot show. They were printed once,
 * in a note nobody could answer, and then nothing ever closed them. Meanwhile the recruiter
 * DOES find out, in the screen, and that answer went into their head and never back onto the
 * record.
 *
 * Ashby's feed is already a two-way channel and nobody was using it as one: `candidate.
 * createNote` writes into it and `candidate.listNotes` reads it back WITH THE AUTHOR of every
 * note. So Sam can ask, a person can answer in the product they already have open, and the
 * next pass can read the answer. No new surface, no portal, no app to install.
 *
 * THREE THINGS THIS HAS TO GET RIGHT, because the failure modes are all silent:
 *
 *   1. A REPLY MUST BE TIED TO A QUESTION. "The next note after ours" is wrong the moment two
 *      recruiters are talking to each other about the candidate — and they will be. Every
 *      question carries a short reference, and only a note quoting it is read as an answer.
 *
 *   2. OUR OWN NOTES ARE NOT REPLIES. The integration posts as an API user with a name and an
 *      id like anybody else. Without excluding ourselves, Sam answers its own question on the
 *      next pass and marks everything confirmed.
 *
 *   3. AMBIGUITY IS NOT A YES. A reply that does not clearly answer is left open and said so.
 *      Guessing in the "confirmed" direction publishes a claim nobody made, onto a hiring
 *      record, attributed to a person by name.
 */
import { ENDPOINTS } from '../../shared/ashby-contract.js';
import { post } from '../endpoints/client.js';
import { createHash } from 'node:crypto';
import { ASK_LIMIT } from '../endpoints/candidate.createNote.js';

/** Short, stable, and derived — so the same question always carries the same reference. */
export const refFor = (candidateId, jobId) =>
  `sam:${createHash('sha256').update(`${candidateId}:${jobId}`).digest('hex').slice(0, 6)}`;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * The question Sam asks once a candidate has been graded.
 *
 * Numbered, because the answer format depends on it. Ordered lists render natively in Ashby,
 * so the numbers a person replies with are the numbers they can see.
 */
export function composeFollowUpHtml({ candidateName, openItems, ref }) {
  if (!openItems.length) return null;

  const items = openItems
    .map((g) => `<li><b>${esc(g.label)}</b>${g.reason ? ` — ${esc(g.reason)}` : ''}</li>`)
    .join('');

  return [
    `<p><b>Sam · still open on ${esc(candidateName)}</b></p>`,
    `<p>${openItems.length === 1 ? 'One thing' : `${openItems.length} things`} the résumé could not show. `
      + 'If you have since found out, reply on this note and I will put it on the record.</p>',
    `<ol>${items}</ol>`,
    `<p>Reply <b>Y</b> or <b>N</b> per item — <code>1Y 2N</code> — or just <b>Y</b> if they all check out. `
      + `<code>${esc(ref)}</code></p>`,
  ].join('');
}

/**
 * Finds a person's answer to one question.
 *
 * @param {object[]} notes     candidate.listNotes results, any order
 * @param {string}   ref       the reference the question carried
 * @param {number}   itemCount how many numbered items were asked about
 * @param {string}   [selfId]  our own Ashby user id, so we never read our own notes
 * @returns {{answers: Map<number, boolean>, blanket: boolean|null, by: object, at: string}|null}
 */
export function readReply(notes, ref, itemCount, selfId = null, { after = null } = {}) {
  const ordered = [...(notes ?? [])].sort((a, b) =>
    String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));

  // `after` is when the CURRENT set of questions was asked, and without it this reads the
  // wrong conversation. The reference is derived from the candidate and the job, so it is
  // the same string for every asking that has ever happened on this pairing — September's
  // questions and today's carry an identical ref. Anchoring on the first note that contains
  // it means a reply somebody left weeks ago, to a different set of questions, is the first
  // thing found after it, and those answers get applied to today's items and written to the
  // record under that person's name.
  //
  // Observed live: a reply from 2 October sat above a question set posted on 10 October.
  const inScope = after
    ? ordered.filter((n) => String(n.createdAt ?? '') >= String(after))
    : ordered;

  const question = inScope.find((n) => contentOf(n).includes(ref));
  if (!question) return null;

  const candidates = inScope.filter((n) =>
    String(n.createdAt ?? '') > String(question.createdAt ?? '')
    // Never our own note. Matched on id where we know it, and on the question's author
    // otherwise — the integration posts the question, so the question's author IS us.
    && n.author?.id !== (selfId ?? question.author?.id)
    // AND never a note carrying the reference, whoever appears to have written it.
    //
    // The scorecard tells the reader "Reply 1Y 2N on this note", and `parseAnswer` reads
    // that sentence as confirming item 1 and denying item 2 — verified, it returns
    // {1:true, 2:false} on our own hint. Author matching was the only thing standing
    // between that and a recruiter's name against a claim they never made, and it is one
    // null author or one second API user away from failing silently in the direction that
    // does damage. Every note we write carries the ref; a person typing `1Y 2N` does not.
    && !contentOf(n).includes(ref));

  for (const note of candidates) {
    const parsed = parseAnswer(contentOf(note), itemCount);
    if (parsed) return { ...parsed, by: note.author ?? null, at: note.createdAt ?? null, noteId: note.id };
  }
  return null;
}

const contentOf = (n) => (typeof n?.content === 'string' ? n.content : n?.content?.value ?? '');

/**
 * Reads Y/N out of something a human typed.
 *
 * Deliberately narrow. `1Y 2N`, `1 yes 2 no`, a bare `Y`, a bare `no` — and nothing else.
 * Prose containing the word "yes" somewhere is NOT an answer: "yes, I'll ask them in the
 * screen" means the opposite of confirmed, and a looser parser reads it as agreement.
 */
export function parseAnswer(text, itemCount) {
  const body = String(text ?? '').replace(/<[^>]+>/g, ' ').trim();
  if (!body) return null;

  const answers = new Map();
  for (const m of body.matchAll(/\b(\d{1,2})\s*[.:)\-]?\s*(y|n|yes|no)\b/gi)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= itemCount) answers.set(n, /^y/i.test(m[2]));
  }
  if (answers.size) return { answers, blanket: null };

  // A bare answer applies to everything — but only if that is ALL the note says. Anything
  // longer is a sentence, and a sentence is a conversation, not a form.
  const bare = /^(y|n|yes|no|confirmed|all good)\s*[.!]?$/i.exec(body);
  if (bare) return { answers: new Map(), blanket: /^(y|yes|confirmed|all good)/i.test(bare[1]) };

  return null;
}

/** Posts the question. Never throws — an unasked question must not fail a delivery. */
export async function askFollowUp({ candidateId, candidateName, openItems, ref }) {
  const html = composeFollowUpHtml({ candidateName, openItems, ref });
  if (!html) return { ok: false, skipped: true, detail: 'nothing open to ask about' };
  try {
    await post(ENDPOINTS.createNote, {
      candidateId,
      note: { type: 'text/html', value: html },
      sendNotifications: false,
    });
    return { ok: true, asked: openItems.length, ref };
  } catch (err) {
    return { ok: false, skipped: false, detail: err.message };
  }
}

/**
 * Reads the feed back and returns the answer, if a person has given one.
 *
 * `itemCount` is capped at what the note actually SHOWED. The scorecard prints the first
 * ASK_LIMIT open items, so those are the only ones a reviewer could have read and the only
 * ones a bare "Y" can be taken to cover.
 */
export async function collectReply({ candidateId, jobId, itemCount, selfId, after = null }) {
  const notes = await post(ENDPOINTS.listNotes, { candidateId });
  return readReply(notes, refFor(candidateId, jobId), Math.min(itemCount, ASK_LIMIT), selfId, { after });
}

/**
 * What Sam writes back once somebody has answered.
 *
 * Names who said it and when. An item on a hiring record that reads "confirmed" with no
 * attribution is worse than an open one: nobody can tell whether it came from an interview,
 * a guess, or a machine.
 */
export function composeAcknowledgementHtml({ candidateName, openItems, reply }) {
  const who = [reply.by?.firstName, reply.by?.lastName].filter(Boolean).join(' ') || 'A reviewer';
  const resolved = openItems.map((item, i) => {
    const n = i + 1;
    const answer = reply.answers.has(n) ? reply.answers.get(n) : reply.blanket;
    if (answer === null || answer === undefined) return null;
    return `<li>${answer ? '✅' : '❌'} <b>${esc(item.label)}</b> — ${answer ? 'confirmed' : 'still not evidenced'}</li>`;
  }).filter(Boolean).join('');

  if (!resolved) return null;
  return [
    `<p><b>Sam · updated from ${esc(who)}</b></p>`,
    `<ul>${resolved}</ul>`,
    `<p><i>Recorded against ${esc(candidateName)}'s grading.</i></p>`,
  ].join('');
}
