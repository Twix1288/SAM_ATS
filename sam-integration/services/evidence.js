/**
 * Evidence extraction over transcript text.
 *
 * Every signal resolves to a quotable span with its source column and character
 * offsets. If a claim cannot be quoted, it cannot be scored.
 *
 * Employer matching is deliberately context-gated: a bare token scan for the JD's
 * named employers returns a false positive on the phrase "I ramp quickly", which
 * appears in this very pool.
 */
import { CORE_SKILL_TOOLS } from './rubric.js';

const FINTECH_EMPLOYERS = ['Brex', 'Ramp', 'Plaid', 'Mercury', 'Flex', 'Stripe', 'Bill.com', 'Melio', 'Tipalti', 'Marqeta', 'Adyen', 'Square'];

/** Employment context required before an employer token counts as an employer. */
const EMPLOYMENT_LEAD = /\b(?:at|for|with|joined|worked\s+(?:at|for|with)|employed\s+by|company\s+called)\s+$/i;

const QUOTE_PAD = 90;

/** Windows a quote around the match, snapping to word boundaries so it never clips mid-word. */
function extractQuote(text, index, length) {
  let start = Math.max(0, index - QUOTE_PAD);
  let end = Math.min(text.length, index + length + QUOTE_PAD);
  if (start > 0) {
    const space = text.indexOf(' ', start);
    if (space !== -1 && space < index) start = space + 1;
  }
  if (end < text.length) {
    const space = text.lastIndexOf(' ', end);
    if (space > index + length) end = space;
  }
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
}

const span = (answer, index, length, note) => ({
  questionId: answer.id,
  column: answer.column,
  start: index,
  end: index + length,
  quote: extractQuote(answer.text, index, length),
  note,
});

function matchAllSpans(answer, regex, note, gate) {
  const out = [];
  for (const m of answer.text.matchAll(regex)) {
    if (gate && !gate(m, answer.text)) continue;
    out.push(span(answer, m.index, m[0].length, note));
  }
  return out;
}

/** Extracts every craft/domain signal present in one answer. */
export function extractSignals(answer) {
  if (!answer.answered) return {};
  const text = answer.text;
  const signals = {};
  const add = (key, spans) => { if (spans.length) signals[key] = [...(signals[key] ?? []), ...spans]; };

  // Named employer from the JD's list, only when preceded by employment context.
  add('fintechEmployer', matchAllSpans(
    answer,
    new RegExp(`\\b(${FINTECH_EMPLOYERS.map((e) => e.replace('.', '\\.')).join('|')})\\b`, 'g'),
    'JD-named fintech employer',
    (m, full) => {
      if (m[0] !== m[0][0].toUpperCase() + m[0].slice(1)) return false; // must be capitalised
      return EMPLOYMENT_LEAD.test(full.slice(Math.max(0, m.index - 40), m.index));
    },
  ));

  add('paymentsDomain', matchAllSpans(answer, /\b(payments?|invoic\w+|fintech|merchant\s+services|payment\s+processing|underwriting|billing\s+platform)\b/gi, 'payments/invoicing domain language'));

  // A currency or volume figure attached to revenue language.
  add('quantifiedVolume', matchAllSpans(answer, /\$\s?\d[\d,.]*\s?(?:k|m|mm|million|billion)?\b|\b\d+(?:\.\d+)?\s?(?:million|billion)\b/gi, 'currency or volume figure'));
  add('quotaLanguage', matchAllSpans(answer, /\b(quota|ARR|AIV|annualized invoice volume|invoiced volume|book of business)\b/gi, 'quota or volume terminology'));

  // Any quantified outcome, not necessarily monetary.
  add('quantifiedOutcome', matchAllSpans(answer, /\b\d+(?:\.\d+)?\s?(?:%|percent|hours?|days?|weeks?|months?|deals?|meetings?|accounts?|clients?|x)\b/gi, 'quantified result'));

  add('namedTool', matchAllSpans(
    answer,
    new RegExp(`\\b(${[...CORE_SKILL_TOOLS.crm, ...CORE_SKILL_TOOLS.sequencing].join('|')})\\b`, 'gi'),
    'JD Core Skills tool',
    (m) => !(m[0].toLowerCase() === 'close' && !/\bClose\b/.test(m[0])), // "close" the verb is not the CRM
  ));

  add('namedCounterparty', matchAllSpans(answer, /\b(?:Director|VP|Vice President|Head|Chief|C[FTEO]O|Controller|Manager|Founder|Owner|Partner)\s+of\s+[A-Z][a-z]+|\b(?:CFO|CTO|COO|CEO|RevOps|Rev Ops|Finance leader|Controller)\b/g, 'named executive counterparty'));

  add('sequencedProcess', matchAllSpans(answer, /\b(?:three|four|five|two)\s+(?:pillars|steps|stages|phases|parts|buckets)\b|\bfirst[,\s][\s\S]{0,80}?\bthen\b|\bI\s+start\s+by\b|\bstructure\s+my\b/gi, 'explicitly sequenced process'));

  add('statedOutcome', matchAllSpans(answer, /\b(closed(?:\s+won)?|signed|won\s+the\s+(?:deal|account)|converted|booked|landed|brought\s+on)\b/gi, 'stated result'));

  add('advancedNotClosed', matchAllSpans(answer, /\bmoved?\s+(?:the\s+)?(?:opportunity|deal)\s+forward\b|\bmoving\s+forward\b|\bkept\s+it\s+alive\b/gi, 'deal advanced but no close stated'));

  add('objectionHandling', matchAllSpans(answer, /\bobjection|\bpush\s*back\b|\broot\s+cause\b|\bget\s+curious\b|\bwhat\s+is\s+actually\b|\breframe\w*\b/gi, 'objection / root-cause handling'));

  add('fullCycle', matchAllSpans(answer, /\bfull[-\s]cycle\b|\bend[-\s]to[-\s]end\b|\bown(?:ed|ing)?\s+(?:the\s+)?(?:entire\s+)?(?:sales\s+)?(?:cycle|pipeline|process)\b/gi, 'full-cycle ownership claim'));

  add('competitiveWin', matchAllSpans(answer, /\bdisplac\w+|\bincumbent\b|\bcompetitor\b|\bswitch\w+\s+from\b|\brip\s+(?:and\s+)?replace\b/gi, 'competitive displacement'));

  return signals;
}

/** Extracts signals for every answered question, keyed by question id. */
export function extractAll(response) {
  const byQuestion = {};
  for (const answer of response.answers) {
    if (answer.answered) byQuestion[answer.id] = extractSignals(answer);
  }
  return byQuestion;
}

/** Flattens the per-question signal map into a single set of signal names present. */
export function signalsPresent(byQuestion, questionIds) {
  const present = new Map();
  for (const qid of questionIds) {
    for (const [name, spans] of Object.entries(byQuestion[qid] ?? {})) {
      present.set(name, [...(present.get(name) ?? []), ...spans]);
    }
  }
  return present;
}
