/**
 * The seed data both halves are built from.
 *
 * Lives in shared/ rather than inside Sam because Ashby needs it too: the simulator seeds
 * its candidate store from the same spreadsheet, reading only identity and the uploaded
 * resume. If this sat under sam-integration/, the stand-in could not be pulled out and
 * replaced with the real Ashby without dragging Sam's parser along with it.
 *
 * Sam reads the whole record; Ashby reads only what it would legitimately know at
 * apply-time.
 */
import { readFileSync } from 'node:fs';
import { readSheet } from './xlsx.js';

/** Each competency question occupies five columns: answer, sentiment, score, keywords, audio. */
export const QUESTIONS = [
  { id: 'Q1', topic: 'startups_payments',    cols: { answer: 'M',  sentiment: 'N',  score: 'O',  keywords: 'P',  audio: 'Q'  } },
  { id: 'Q2', topic: 'ops_finance_deal',     cols: { answer: 'R',  sentiment: 'S',  score: 'T',  keywords: 'U',  audio: 'V'  } },
  { id: 'Q3', topic: 'outbound_relationship',cols: { answer: 'W',  sentiment: 'X',  score: 'Y',  keywords: 'Z',  audio: 'AA' } },
  { id: 'Q4', topic: 'invoiced_volume',      cols: { answer: 'AB', sentiment: 'AC', score: 'AD', keywords: 'AE', audio: 'AF' } },
  { id: 'Q5', topic: 'outbound_structure',   cols: { answer: 'AG', sentiment: 'AH', score: 'AI', keywords: 'AJ', audio: 'AK' } },
  { id: 'Q6', topic: 'objection_handling',   cols: { answer: 'AL', sentiment: 'AM', score: 'AN', keywords: 'AO', audio: 'AP' } },
];

const IDENTITY = { name: 'E', altName: 'H', email: 'I', altEmail: 'D', linkedin: 'J', location: 'L', resume: 'K', responseHash: 'C' };

const clean = (v) => (typeof v === 'string' ? v.replace(/^Answer:\s*/i, '').trim() : '');

const fileLabel = (url) => {
  const tail = decodeURIComponent(url.split('/').pop() ?? '');
  // Voiceform prefixes uploads with a uuid: "<uuid>_james_hare_resume.pdf".
  return tail.replace(/^[0-9a-f-]{36}_/i, '') || url;
};

/**
 * Resolves the uploaded documents for a row.
 *
 * Almost every resume cell is a HYPERLINK() formula, so the target comes from the
 * cell's link. One row instead holds several bare URLs in a single text cell
 * (a resume plus a cover letter), so both shapes are handled.
 */
function documentsFor(cells, link) {
  const raw = cells[IDENTITY.resume];
  if (link?.href) {
    return { resume: { url: link.href, name: link.label || fileLabel(link.href) }, attachments: [] };
  }
  const urls = typeof raw === 'string' ? raw.match(/https?:\/\/\S+/g) ?? [] : [];
  if (!urls.length) return { resume: null, attachments: [] };
  const [first, ...rest] = urls;
  return {
    resume: { url: first, name: fileLabel(first) },
    attachments: rest.map((url) => ({ url, name: fileLabel(url) })),
  };
}

function toResponse(rowNumber, cells, link) {
  const answers = QUESTIONS.map((q) => {
    const text = clean(cells[q.cols.answer]);
    const rawScore = cells[q.cols.score];
    return {
      id: q.id,
      topic: q.topic,
      column: q.cols.answer,
      answered: text.length > 0,
      text,
      wordCount: text ? text.split(/\s+/).length : 0,
      sentiment: cells[q.cols.sentiment] ?? null,
      sentimentScore: rawScore === undefined ? null : Number.parseFloat(rawScore),
      keywords: (cells[q.cols.keywords] ?? '').split(',').map((k) => k.trim()).filter(Boolean),
      audioUrl: cells[q.cols.audio] ?? null,
    };
  });

  return {
    rowNumber,
    responseHash: cells[IDENTITY.responseHash] ?? `row-${rowNumber}`,
    name: (cells[IDENTITY.name] ?? cells[IDENTITY.altName] ?? `Row ${rowNumber}`).trim(),
    email: cells[IDENTITY.email] ?? cells[IDENTITY.altEmail] ?? null,
    linkedin: cells[IDENTITY.linkedin] ?? null,
    location: cells[IDENTITY.location] ?? null,
    ...documentsFor(cells, link),
    answers,
    answeredCount: answers.filter((a) => a.answered).length,
  };
}

/** Loads every response in the workbook. The engine always scores the whole pool. */
export function loadPool(path) {
  const { rows, links } = readSheet(readFileSync(path));
  const pool = [];
  for (const [rowNumber, cells] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
    if (rowNumber === 1) continue; // header
    pool.push(toResponse(rowNumber, cells, links.get(`${IDENTITY.resume}${rowNumber}`)));
  }
  return pool;
}

export function findByRow(pool, rowNumber) {
  return pool.find((r) => r.rowNumber === rowNumber) ?? null;
}
