/**
 * Ashby candidate.createNote — DELIVERABLE 2, the rich note.
 *
 * Note the endpoint name: `candidate.createNote`. The original plan called this
 * `candidateNote.create`, which does not exist.
 *
 * `note` accepts either a bare string or { type, value } where type is 'text/plain' or
 * 'text/html'. Rich formatting renders natively in the activity feed — bold, italic,
 * monospace, clickable links and real bulleted lists all survive — so this is the version
 * a reviewer actually reads, and it carries structure rather than prose.
 *
 * TABLES DO NOT SURVIVE. This file used to ship the anchors, the evidence and the coverage
 * gaps as HTML tables on the strength of a documentation reading. Posting one to a real org
 * showed Ashby flattens every cell together with no separator. See composeNoteHtml for the
 * verified tag list and what replaced them.
 *
 * Still no CSS and no images: no styling contract is published, and a note that depended
 * on one would degrade invisibly.
 */
import { ENDPOINTS } from '../../shared/ashby-contract.js';
import { post } from './client.js';
import { askOf, impactOf } from '../delivery/openQuestions.js';

const pct = (n) => `${Math.round(n * 100)}%`;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Anchor states carry meaning, so each gets a mark that survives plain text. */
const MARK = { MET: '✓', MET_EQUIVALENT: '≈', PARTIAL: '~', NOT_MET: '✕', NOT_COLLECTED: '–' };

const STATE_WORD = {
  MET: 'met',
  MET_EQUIVALENT: 'met by equivalence',
  PARTIAL: 'partial',
  NOT_MET: 'not met',
  NOT_COLLECTED: 'never asked',
};

/**
 * "Matched to <role>" — with the company only when there is one.
 *
 * The seed data always carried a company, so `${title} · ${company}` was safe. A job read
 * from Ashby often has none, and the template then rendered a trailing "·" with nothing
 * after it — the first thing anyone notices in a demo.
 */
/**
 * The opening sentence of a longer passage.
 *
 * Sam's net read runs five or six sentences — the judgement, then the pattern behind it,
 * then the gap, then the handoff to the interview. All of it belongs in the Snapshot and
 * the first sentence is the one that answers "what do you make of them". The rest reads as
 * a wall in a feed, which is exactly what pushes everything below it under Ashby's
 * "Show more".
 *
 * Split on a full stop followed by a capital, so "$6M." and "Inc." do not cut it short.
 */
function firstSentence(text, max = 240) {
  const t = String(text ?? '').trim();
  if (!t) return '';
  const m = /^(.+?[.!?])(\s+[A-Z]|$)/.exec(t);
  const head = (m ? m[1] : t).trim();
  if (head.length <= max) return head;
  const cut = head.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(' ')) || cut}…`;
}

/** A supporting line, short enough to scan. The full version is in the Snapshot. */
function clamp(text, max = 110) {
  const t = String(text ?? '').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(' ')) || cut}…`;
}

const matchedTo = (s) => [s.role?.title, s.role?.company].filter(Boolean).join(' · ');

/**
 * The one-line headline. Role Fit is never written without its coverage — a bare
 * percentage implies the whole rubric was observable, and here it was not.
 *
 * Below the coverage floor it is not written at all. The note is the surface a reviewer
 * reads without clicking, so it is the last place to put a number the document itself
 * refuses to print.
 */
/**
 * The headline, built from what Sam actually sends.
 *
 * It used to read "Role Fit 94% at 72% evidence coverage". Sam has no coverage figure, so
 * against a real payload that rendered **"94% at 0% evidence coverage"** — a number that is
 * not merely missing but actively wrong, on a hiring manager's screen, with no way to
 * correct it once the note is posted.
 *
 * The denominator is now the one Sam does send: how many of the role's anchors were met, out
 * of how many there are. It answers the same question — "94% of what?" — with a fact rather
 * than an invention.
 */
const headline = (s) => {
  const rank = s.pool
    ? ` · ${s.pool.position ?? `rank ${s.pool.roleFitRank} of ${s.pool.size}`}`
    : '';
  const anchors = s.anchorSummary?.total
    ? ` · ${s.anchorSummary.met + (s.anchorSummary.metEquivalent ?? 0)} of ${s.anchorSummary.total} anchors met`
    : '';
  const cap = s.capability == null ? '' : ` · Capability ${s.capability}/10`;

  if (s.scoreIsPublishable === false) {
    // Sam capped it. Its own reason is already in the caveats, so this line does not repeat
    // it — it just refuses to show a number Sam has said should not stand alone.
    return `Not scored — the evidence does not support a match percentage${anchors}${cap}${rank}`;
  }

  // Coverage still prints when we have one: the local demo path produces it, and where it
  // exists it is the better denominator.
  const observable = Number.isFinite(s.coverage) ? ` at ${pct(s.coverage)} evidence coverage` : '';
  return `Role Fit ${pct(s.roleFit)}${observable}${anchors}${cap}${rank}`;
};

/** Plain-text note. The floor: what survives if HTML is rejected entirely. */
/**
 * What the note is allowed to claim about the attachment.
 *
 * The pipeline only passes page counts when the resume actually bound in, so a note can
 * never advertise evidence the document does not carry. If the stitch fell back, the
 * sentence falls back with it.
 */
function attachmentSuffix(attachment) {
  if (!attachment?.resumePages) return ', attached to this candidate';
  const how = attachment.mode === 'typeset' ? ' as text' : '';
  const extras = attachment.extras
    ? `, and ${attachment.extras} they also submitted but Sam did not score`
    : '';
  return `, ${attachment.pages} pages with their own resume bound in behind it${how}${extras}`;
}

export function composeNote(snapshot, dossierUrl, attachment = null) {
  const s = snapshot;
  const lines = [
    `Sam Snapshot — ${s.candidate.name}`,
    `Matched to ${matchedTo(s)}`,
    '',
    headline(s),
    `Band: ${s.band}`,
    '',
    `Recommended next step: ${s.recommendedNextStep}`,
    '',
    `Role anchors (${s.anchorSummary.met} met of ${s.anchorSummary.observable} observable):`,
    ...s.roleAnchors.map((a) => `  ${MARK[a.state]} ${a.label} — ${STATE_WORD[a.state]}`),
    '',
    s.netRead,
    '',
    'Gaps to investigate:',
    ...s.gapsToInvestigate.map((g) => `  - ${g.label} — ${g.reason}`),
  ];

  if (s.caveats?.length) lines.push('', 'Caveats:', ...s.caveats.map((c) => `  - ${c}`));

  lines.push('');
  if (attachment) lines.push(`Full Snapshot attached to this candidate: ${attachment.filename}${attachmentSuffix(attachment)}`);
  lines.push(`Evidence, interview audio and the original resume: ${dossierUrl}`);
  return lines.join('\n');
}

/**
 * Rich-text note — the version a reviewer actually reads, because the feed is the default
 * tab and nothing needs opening.
 *
 * WHAT ASHBY ACTUALLY RENDERS, verified against a live org on 2026-09-10 by posting a
 * probe note and reading the result in the product UI:
 *
 *   RENDER WITH FORMATTING   <b> <strong> <i> <em> <code> <u> <a href> <ul>/<li>
 *                            <ol>/<li> (real numbering) <br> <p> — and nested <ul>
 *                            keeps its indentation
 *   RENDER AS PLAIN TEXT     <h1>-<h6>, <blockquote>, <pre> — the tag is accepted but
 *                            carries no visual weight, so it buys nothing over <p><b>
 *   DROPPED ENTIRELY         <hr>
 *   CATASTROPHIC             <table> and every child. Ashby flattens the cells with NO
 *                            separator at all, so a three-column anchor row arrives as
 *                            "…named territorymetCarried a named territory…" — the state
 *                            fused to both the label and the reason. Unreadable.
 *
 * That last one is why this function no longer emits a single table. The information is
 * identical; only the container changed. `<b>` label plus a nested list carries a
 * two-column relationship perfectly well, and it is the one shape that cannot collapse.
 *
 * NOTE: candidate.listNotes returns a FLATTENED PLAIN-TEXT rendition of the note, so the
 * API response cannot be used to check formatting — only the product UI shows the truth.
 * Do not "verify" a change to this function by reading listNotes back.
 */
/**
 * The note: a briefing, not a report.
 *
 * THE DIVISION OF LABOUR. This note and the attached Snapshot carry the same judgement at
 * two different depths, and for a while the note tried to carry both. It ran to five
 * thousand characters — career history, every anchor with its full reasoning, quoted
 * evidence, coverage gaps, capability signals, the three fit rows — all of which the PDF
 * already presents better, on a page designed for it, with room to breathe.
 *
 * A feed is not a page. It is read between two other events by somebody deciding in about
 * four seconds whether this person is worth a conversation, and Ashby clamps a long note
 * behind a "Show more" that most people never click. Every line below the fold is a line
 * written for nobody.
 *
 * So the note answers four questions and stops:
 *
 *   who and how well      the headline
 *   should I act          the recommended step
 *   on what basis         the anchors, as a scannable list
 *   what is still open    what to confirm
 *
 * Everything else — the evidence quotes, the career history, the per-anchor reasoning, the
 * skills, the capability signals — lives in the attached Snapshot, and the note says where.
 */
/**
 * A scorecard a recruiter can read in four seconds, then act on.
 *
 * SHAPE. Four blocks, in the order someone actually needs them:
 *
 *   the numbers      a fixed-width bar per measure, so relative strength is visible
 *                    without reading a single digit
 *   STRENGTHS        what the candidate demonstrably has
 *   WATCH            what they do not, or what is worth a second look
 *   ASK IN INTERVIEW numbered questions, written to be read aloud
 *
 * WHY BARS, AND WHY ONLY THREE. A bar is a comparison, and a comparison is only honest
 * between things measured the same way. Sam returns three genuinely numeric measures — the
 * match percentage, capability out of ten, and how many requirements were met — and three
 * RATINGS (Strong / Partial / Exceeds) for experience, responsibility and level. Drawing a
 * bar for a rating would mean inventing a position on a scale Sam never gave, so the ratings
 * are printed as words and only the numbers get bars.
 *
 * ALIGNMENT. The bars only line up in a monospaced font, which in Ashby means `<code>`.
 * Verified against a live org: `<code>` renders monospaced, `<pre>` is accepted but carries
 * no visual weight, and `<table>` flattens into an unreadable run-on. So each row is its own
 * `<code>` element separated by `<br>` — the one construction that keeps both the font and
 * the line break.
 */
/** How many open items the note shows — and therefore how many a reply can answer. */
export const ASK_LIMIT = 3;

export function composeNoteHtml(snapshot, dossierUrl, attachment = null, ref = null, questions = null) {
  const s = snapshot;

  // ── the numbers ──────────────────────────────────────────────────────────
  const rows = [];
  if (Number.isFinite(s.roleFit)) rows.push(['Role fit', s.roleFit, `${Math.round(s.roleFit * 100)}%`]);
  // Coverage, WHERE IT EXISTS, sits directly under the match it qualifies. Sam sends none,
  // but the local path computes one, and a match percentage printed without the share of the
  // role it was drawn from is the exact misreading every surface here exists to prevent.
  if (Number.isFinite(s.coverage)) rows.push(['Evidence coverage', s.coverage, `${Math.round(s.coverage * 100)}%`]);
  if (Number.isFinite(s.capability)) rows.push(['Capability', s.capability / 10, `${s.capability}/10`]);
  if (s.anchorSummary?.total) {
    const met = (s.anchorSummary.met ?? 0) + (s.anchorSummary.metEquivalent ?? 0);
    rows.push(['Requirements', met / s.anchorSummary.total, `${met} of ${s.anchorSummary.total}`]);
  }

  // The ratings share the same column as the bars, so their labels have to be measured
  // alongside them. Computing the width from the numeric rows alone printed
  // "ResponsibilityStrong" — the longest label in the block was not in the block being
  // measured.
  const ratingRows = [
    ['Experience', s.experienceMatch],
    ['Responsibility', s.responsibilityMatch],
    ['Level', s.roleLevelFit],
  ].filter(([, r]) => r?.band && r.band !== 'Not determined');

  // Labels and values are padded to a fixed width so the bars start and end in the same
  // column on every row. Non-breaking spaces: Ashby collapses runs of ordinary ones.
  const LABEL = Math.max(12, ...rows.map((r) => r[0].length), ...ratingRows.map((r) => r[0].length)) + 2;
  const pad = (text, width) => String(text).padEnd(width, ' ').replace(/ /g, '\u00a0');
  const bar = (fraction) => {
    const filled = Math.max(0, Math.min(10, Math.round(fraction * 10)));
    return '█'.repeat(filled) + '░'.repeat(10 - filled);
  };

  const scorecard = rows.length
    ? rows.map((r) => `<code>${pad(r[0], LABEL)}${bar(r[1])}${pad('', 2)}${esc(r[2])}</code>`).join('<br>')
    : '';

  // The verdict line. Sam's own band, never a recommendation we invented.
  const verdict = s.scoreIsPublishable === false
    ? `<code>${pad('Overall', LABEL)}not scored — the evidence does not support a match</code>`
    : `<code>${pad('Overall', LABEL)}${esc(s.band ?? '')}</code>`;

  // ── strengths ────────────────────────────────────────────────────────────
  // A requirement Sam judged met, with its reasoning trimmed to the line that says why.
  // Met-by-equivalence is included and marked: it IS a pass, and a reviewer should know an
  // inference was made rather than discovering it in the PDF.
  const strengths = (s.roleAnchors ?? [])
    .filter((a) => a.state === 'MET' || a.state === 'MET_EQUIVALENT')
    .slice(0, 4)
    .map((a) => `<li>${esc(a.label)}${a.state === 'MET_EQUIVALENT' ? ' <i>(by equivalence)</i>' : ''}`
      + `${a.reason ? `<br>${esc(clamp(a.reason, 120))}` : ''}</li>`)
    .join('');

  // ── what is being asked ──────────────────────────────────────────────────
  // Computed before WATCH, because WATCH has to know what it is: once a requirement is a
  // numbered question at the bottom of the note, repeating it as a bullet halfway up says
  // the same sentence twice. Observed on Jamar Herzog — his three unmet requirements filled
  // WATCH and then filled ASK, identically.
  //
  // ASK_LIMIT is shared with whatever reads the reply, and it has to be: the note shows the
  // first three open items, a reply numbers THOSE, and a bare "Y" means "all of the ones I
  // can see". Reading that reply against the full list would mark items confirmed that the
  // person was never shown — a claim nobody made, on a hiring record, under their name.
  //
  // `questions` is the set the caller RECORDED as asked, already ranked and already filtered
  // to what nobody has answered yet. The fallback keeps the composer usable on its own.
  const asking = (questions ?? (s.gapsToInvestigate ?? []).map((g) => ({ ...g, source: 'confirm' })))
    .slice(0, ASK_LIMIT);
  // Only ANCHOR-sourced questions suppress a WATCH line. A `what_to_confirm` item can share
  // wording with a requirement without being the same claim, and dropping the requirement on
  // that basis would silently delete the one line carrying its state word.
  const beingAsked = new Set(asking
    .filter((q) => q.source === 'anchor')
    .map((q) => String(q.label ?? '').toLowerCase().trim()));

  // ── watch ────────────────────────────────────────────────────────────────
  // What a reviewer should know and is NOT being asked to resolve: the remaining unmet
  // requirements, anything Sam could not assess, and Sam's own caveats including the
  // AI-authorship flag.
  const watch = [
    // The state word is not decoration. "Never asked" means a résumé cannot show this and it
    // is not held against the candidate; "not met" means we looked and it was not there.
    // Collapsing them turns an unanswerable question into a failure on somebody's record.
    ...(s.roleAnchors ?? [])
      .filter((a) => a.state === 'NOT_MET' || a.state === 'NOT_COLLECTED')
      .filter((a) => !beingAsked.has(String(a.label ?? '').toLowerCase().trim()))
      .slice(0, 3)
      .map((a) => `<li>${esc(a.label)} — <i>${esc(STATE_WORD[a.state])}</i>`
        + `${a.reason ? `<br>${esc(clamp(a.reason, 110))}` : ''}</li>`),
    ...(s.caveats ?? []).slice(0, 2).map((c) => `<li>${esc(clamp(c, 140))}</li>`),
  ].join('');

  // ── ask in interview ─────────────────────────────────────────────────────

  const ask = asking
    .map((q) => {
      // The state word travels WITH the question. A requirement moved down here is no
      // longer in WATCH, and "never asked" versus "not met" is the distinction the whole
      // product rests on — a question that drops it turns something a résumé cannot show
      // into a failure on somebody's record.
      const state = q.source === 'anchor' && q.state ? STATE_WORD[q.state] : null;
      const impact = impactOf(q);
      const footnote = [state, impact].filter(Boolean).join(' · ');
      return `<li>${esc(askOf(q))}`
        + `${q.reason ? ` — ${esc(clamp(q.reason, 120))}` : ''}`
        + `${footnote ? `<br><i>${esc(footnote)}</i>` : ''}</li>`;
    })
    .join('');

  // ── fit ratings, as words ────────────────────────────────────────────────
  const ratings = ratingRows
    .map(([label, r]) => `<code>${pad(label, LABEL)}${esc(r.band)}</code>`)
    .join('<br>');

  const heading = (text) => `<p><b>${esc(text)}</b></p>`;

  return [
    `<p><b>${esc(s.candidate.name)}</b><br>${esc(matchedTo(s))}`
      + `${s.provenance ? ` · <i>scored from ${esc(s.provenance)}</i>` : ''}</p>`,

    scorecard ? `<p>${scorecard}<br>${ratings ? `${ratings}<br>` : ''}${verdict}</p>` : '',

    s.recommendedNextStep ? `<p><b>Next step.</b> ${esc(s.recommendedNextStep)}</p>` : '',

    strengths ? heading('✓ STRENGTHS') + `<ul>${strengths}</ul>` : '',
    watch ? heading('△ WATCH') + `<ul>${watch}</ul>` : '',
    // The same numbered list, made answerable.
    //
    // The conversation was built, tested and then never connected to a delivery, so Sam
    // asked nothing and nobody could answer: `followUp.js` posted its own note and the
    // pipeline never called it. A SECOND note was the wrong shape anyway — this list is
    // already numbered and already the open items, so the reply instruction belongs on it.
    // One note per grading, and the numbers a recruiter answers are the numbers they read.
    ask ? heading('? ASK IN INTERVIEW') + `<ol>${ask}</ol>`
      + (ref ? `<p><i>Found out since? Reply <b>1Y 2N</b> on this note and Sam puts it on `
        + `the record.</i> <code>${esc(ref)}</code></p>` : '') : '',

    // Provenance and the route to everything this note left out.
    `<p><i>Graded by Sam against the job description.</i>`
      + `${attachment ? ` Full report: <b>${esc(attachment.filename)}</b>.` : ''}`
      + `${dossierUrl ? ` <a href="${esc(dossierUrl)}">Open on Sam →</a>` : ''}</p>`,
  ].filter(Boolean).join('');
}

export async function createSnapshotNote({
  candidateId, snapshot, dossierUrl, deliveryId, attachment = null, format = 'html', ref = null,
  questions = null,
}) {
  const html = composeNoteHtml(snapshot, dossierUrl, attachment, ref, questions);
  const plain = composeNote(snapshot, dossierUrl, attachment);

  // Built from the BODY WE ARE ABOUT TO POST, not from a separately composed headline.
  // The headline version silently never matched an HTML note — see `noteFingerprint`.
  // Recomputed per format so the plain-text fallback checks against its own body.
  const alreadyPosted = (body) => () => noteAlreadyExists(candidateId, noteFingerprint(body));

  if (format === 'html') {
    try {
      await post(ENDPOINTS.createNote, {
        candidateId,
        note: { type: 'text/html', value: html },
        sendNotifications: false,
      }, { idempotencyKey: `${deliveryId}:note`, verify: alreadyPosted(html) });
      return { format: 'text/html', body: html, plain, referencesAttachment: Boolean(attachment) };
    } catch (err) {
      if (!(err?.status >= 400 && err.status < 500)) throw err;
    }
  }

  await post(ENDPOINTS.createNote, {
    candidateId,
    note: { type: 'text/plain', value: plain },
    sendNotifications: false,
  }, { idempotencyKey: `${deliveryId}:note`, verify: alreadyPosted(plain) });
  return { format: 'text/plain', body: plain, plain, referencesAttachment: Boolean(attachment) };
}

/**
 * Asks Ashby whether this exact note is already on the candidate.
 *
 * candidate.createNote appends rather than upserts, so this is what stands between a
 * retried delivery and two identical tables in the activity feed.
 */
export async function noteAlreadyExists(candidateId, fingerprint) {
  if (!fingerprint) return null;
  const notes = await post(ENDPOINTS.listNotes, { candidateId });
  const hit = (notes ?? []).find((n) => normaliseNoteText(noteText(n)).includes(fingerprint));
  return hit ? { id: hit.id, createdAt: hit.createdAt, deduplicated: true } : null;
}

/**
 * The part of a note that can be matched against what Ashby stored.
 *
 * ASHBY DOES NOT GIVE BACK WHAT WE SENT. A note posted as text/html comes back as plain
 * text: tags stripped, `<p>` and `<br>` turned into newlines, and every `<li>` prefixed
 * with "- ". So the old fingerprint — a `Role Fit 94% · 6 of 6 anchors met` line built for
 * the PLAIN-TEXT note — never appeared in an HTML one, `noteAlreadyExists` never matched,
 * and the HTML note had no deduplication at all. A delivery whose response was lost posted
 * a second scorecard onto the record, every time.
 *
 * Matching the whole body does not work either, because of those "- " bullets. Everything
 * BEFORE the first list does survive verbatim — the name, the role, the score bars, the
 * ratings and the next step — and that region already differs between any two gradings
 * worth telling apart. So it is the fingerprint.
 */
export function noteFingerprint(body) {
  return normaliseNoteText(String(body ?? '').split(/<(?:ul|ol)\b/i)[0]);
}

const ENTITIES = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
};

const normaliseNoteText = (text) => String(text ?? '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;/g, (e) => ENTITIES[e])
  .replace(/[\s\u00a0]+/g, ' ')
  .trim();

/**
 * The text of a note, however Ashby chose to shape it.
 *
 * VERIFIED against a live org: candidate.listNotes returns `content` as a PLAIN STRING —
 * a flattened text rendition of whatever HTML was posted — not the { type, value } object
 * the write side sends. Reading `content.value` therefore yielded undefined on every note,
 * so the fingerprint never matched and this guard silently never fired. That is the guard
 * standing between an Ashby retry and a second copy of the whole Snapshot in the feed.
 *
 * Both shapes are accepted because the write side still sends { type, value } and the
 * simulator echoes it back that way.
 */
const noteText = (n) => {
  const c = n?.content;
  if (typeof c === 'string') return c;
  return String(c?.value ?? '');
};
