/**
 * One attachment instead of several.
 *
 * Sam's Snapshot is a judgement, and a judgement is worth less when the evidence it was
 * drawn from sits in a different file. Ashby's Files list gives no ordering guarantee and
 * no way to say "read this one first", so two documents on a record is two documents a
 * reviewer has to relate to each other themselves.
 *
 * So the Snapshot ships with the candidate's own documents bound in behind it, each behind
 * a divider page that says where Sam stops and the source begins.
 *
 * The divider distinguishes what Sam READ from what the candidate merely SUBMITTED. Sam
 * scores from the resume and the interview answers; a cover letter it never opened cannot
 * sit behind a page captioned "source document" without implying the score was drawn from
 * it. One candidate in this pool attached one, which is how the distinction earned its
 * place rather than being invented for symmetry.
 *
 * Three outcomes, and the divider page states which one honestly:
 *
 *   merged        a PDF — copied page for page, their layout intact
 *   typeset       a Word document — pdf-lib cannot render .docx, so we set the extracted
 *                 text ourselves and say so rather than implying fidelity
 *   skipped       a format we cannot bind, or a document that would not open. Listed in
 *                 the result, never dropped in silence
 *
 * Never throws. A document that fails to load costs the reviewer a convenience; a stitcher
 * that throws costs the candidate their entire delivery.
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { readFileSync } from 'node:fs';
import { candidateFilesForResponse } from '../ingest/resume.js';
import { extractDocxText } from '../ingest/docx.js';
import { SAM, TEAL, INK as INK_RAMP, toRgb } from '../../shared/brand.js';

const hex = (h) => rgb(...toRgb(h));
const INK = hex(SAM.black);
const BRAND = hex(SAM.teal);
const ACCENT = hex(TEAL.deep);
const SOFT = hex(INK_RAMP[500]);
const RULE = hex(INK_RAMP[200]);

const PAGE = [612, 792];
const M = 46;
const WIDTH = PAGE[0] - M * 2;

export const STITCH_MODE = {
  merged: 'merged',
  typeset: 'typeset',
  snapshotOnly: 'snapshot-only',
};

/** What the divider page tells the reviewer, per mode and per whether Sam read it. */
const DIVIDER_NOTE = {
  read: {
    [STITCH_MODE.merged]:
      'The pages that follow are the candidate’s own resume, reproduced exactly as they '
      + 'submitted it. Sam did not alter, reformat or re-order them. This is the document '
      + 'the score above was drawn from, alongside their interview answers.',
    [STITCH_MODE.typeset]:
      'The candidate submitted their resume as a Word document. The pages that follow are '
      + 'its text, set by Sam — the original formatting is not preserved. Treat the wording '
      + 'as theirs and the layout as ours. This is the document the score above was drawn '
      + 'from, alongside their interview answers.',
  },
  unread: {
    [STITCH_MODE.merged]:
      'The candidate submitted this with their application, reproduced here exactly as they '
      + 'sent it. Sam did not read or score it — the judgement above was drawn from their '
      + 'resume and their interview answers only. It is here so you have it, not because it '
      + 'counted.',
    [STITCH_MODE.typeset]:
      'The candidate submitted this with their application as a Word document; the pages '
      + 'that follow are its text, set by Sam. Sam did not read or score it — the judgement '
      + 'above was drawn from their resume and their interview answers only. It is here so '
      + 'you have it, not because it counted.',
  },
};

/** How many pages of candidate documents one attachment will carry before we stop. */
export const MAX_BOUND_PAGES = 40;

/**
 * The standard PDF fonts encode WinAnsi and nothing else, and real resumes are full of
 * characters it has never heard of — bullet glyphs, en dashes, curly quotes, the
 * occasional emoji. pdf-lib throws on the first one it cannot encode, which would take
 * down the whole delivery over a typographic bullet.
 *
 * So we transliterate what has an obvious ASCII equivalent and drop what does not. The
 * wording stays the candidate's; only the glyphs change.
 */
const TRANSLITERATE = new Map(Object.entries({
  '\u2022': '-', '\u25cf': '-', '\u25aa': '-', '\u25a0': '-', '\u2023': '-',
  '\u2043': '-', '\u00b7': '-', '\u25e6': '-', '\u2219': '-', '\u2756': '-',
  '\u2013': '-', '\u2014': '-', '\u2015': '-', '\u2212': '-',
  '\u2018': "'", '\u2019': "'", '\u201a': "'", '\u201b': "'", '\u2032': "'",
  '\u201c': '"', '\u201d': '"', '\u201e': '"', '\u201f': '"', '\u2033': '"',
  '\u2026': '...', '\u2192': '->', '\u2190': '<-', '\u21d2': '=>',
  '\u00a0': ' ', '\u2009': ' ', '\u200a': ' ', '\u202f': ' ', '\u2007': ' ',
  '\u200b': '', '\u200c': '', '\u200d': '', '\ufeff': '',
  '\u2044': '/', '\u2264': '<=', '\u2265': '>=', '\u00d7': 'x',
  '\u0152': 'OE', '\u0153': 'oe', '\u2122': '(TM)', '\u2117': '(P)',
}));

/** WinAnsi is Latin-1 plus a scattering of typographic glyphs in 0x80-0x9F. */
const ENCODABLE = /[\x20-\x7e\xa1-\xff]/;

export function toWinAnsi(text) {
  let out = '';
  for (const ch of String(text)) {
    const mapped = TRANSLITERATE.get(ch);
    if (mapped !== undefined) { out += mapped; continue; }
    if (ch === '\n' || ch === '\t') { out += ch; continue; }
    out += ENCODABLE.test(ch) ? ch : '';
  }
  return out;
}

/** Greedy wrap; returns the lines that fit `width` at `size`. */
function wrap(text, font, size, width) {
  const out = [];
  for (const para of toWinAnsi(text).split(/\n/)) {
    if (!para.trim()) { out.push(''); continue; }
    let line = '';
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > width && line) { out.push(line); line = word; }
      else line = next;
    }
    if (line) out.push(line);
  }
  return out;
}

/**
 * The page that separates Sam's judgement from the candidate's documents.
 * It exists so nobody mistakes their document for something Sam produced — or, for a
 * document Sam never opened, mistakes it for something Sam scored.
 */
function addDivider(doc, { label, mode, read, bold, reg }) {
  const page = doc.addPage(PAGE);
  const top = PAGE[1] - 250;

  page.drawRectangle({ x: 0, y: top + 74, width: PAGE[0], height: 4, color: read ? BRAND : RULE });

  page.drawText(read ? 'SOURCE DOCUMENT' : 'ALSO SUBMITTED', {
    x: M, y: top + 34, size: 22, font: bold, color: INK,
  });
  page.drawText(toWinAnsi(label), {
    x: M, y: top + 12, size: 11, font: reg, color: SOFT,
  });

  page.drawLine({
    start: { x: M, y: top - 8 }, end: { x: PAGE[0] - M, y: top - 8 },
    thickness: 0.75, color: RULE,
  });

  let y = top - 34;
  for (const line of wrap(DIVIDER_NOTE[read ? 'read' : 'unread'][mode], reg, 10.5, WIDTH)) {
    page.drawText(line, { x: M, y, size: 10.5, font: reg, color: INK });
    y -= 15;
  }

  page.drawText(read ? 'Everything above this page is Sam’s.' : 'Sam did not score this document.', {
    x: M, y: y - 22, size: 10, font: bold, color: read ? ACCENT : SOFT,
  });
  return page;
}

/** Sets extracted text across as many pages as it needs. */
function addTypesetPages(doc, text, { bold, reg }) {
  const lines = wrap(text, reg, 9.5, WIDTH);
  let page = doc.addPage(PAGE);
  let y = PAGE[1] - M;
  page.drawText('RESUME — TEXT EXTRACT', { x: M, y, size: 9, font: bold, color: SOFT });
  y -= 22;

  for (const line of lines) {
    if (y < M + 20) { page = doc.addPage(PAGE); y = PAGE[1] - M; }
    if (line) page.drawText(line, { x: M, y, size: 9.5, font: reg, color: INK });
    y -= 13;
  }
}

/**
 * Binds one candidate document onto an open PDFDocument.
 * Returns what it contributed, or a reason it could not.
 */
async function bindOne(doc, source, fonts) {
  let bytes;
  try {
    bytes = readFileSync(source.path);
  } catch (err) {
    return { skipped: { label: source.label, reason: `unreadable (${err.code ?? 'error'})` } };
  }

  if (source.ext === 'pdf') {
    try {
      // ignoreEncryption: a document with owner-password permissions set still reads fine,
      // and refusing it would cost the reviewer their evidence for no security gain.
      const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
      const indices = src.getPageIndices();
      if (!indices.length) return { skipped: { label: source.label, reason: 'no pages' } };

      addDivider(doc, { label: source.label, mode: STITCH_MODE.merged, read: source.read, ...fonts });
      const copied = await doc.copyPages(src, indices);
      for (const page of copied) doc.addPage(page);
      return { bound: { label: source.label, read: source.read, mode: STITCH_MODE.merged, pages: indices.length } };
    } catch (err) {
      return { skipped: { label: source.label, reason: `would not open (${err.message.slice(0, 50)})` } };
    }
  }

  if (source.ext === 'docx') {
    try {
      const text = extractDocxText(bytes);
      if (!text || !text.trim()) return { skipped: { label: source.label, reason: 'no text' } };

      addDivider(doc, { label: source.label, mode: STITCH_MODE.typeset, read: source.read, ...fonts });
      const before = doc.getPageCount();
      addTypesetPages(doc, text, fonts);
      return { bound: { label: source.label, read: source.read, mode: STITCH_MODE.typeset, pages: doc.getPageCount() - before } };
    } catch (err) {
      return { skipped: { label: source.label, reason: `text could not be extracted (${err.message.slice(0, 50)})` } };
    }
  }

  // Images, legacy .doc, spreadsheets, anything else. We could convert some of them, but
  // a stated omission is worth more than a silent one — the reviewer still has the file
  // itself on the record.
  return { skipped: { label: source.label, reason: `.${source.ext} cannot be bound in` } };
}

/**
 * @param {object}   args
 * @param {Buffer}   args.snapshotBytes  the rendered Snapshot PDF
 * @param {object[]} args.sources        candidate documents, resume first, each with
 *                                       `{path, ext, label, read}`. `read` must reflect
 *                                       what the engine actually parsed.
 * @returns {Promise<{bytes: Buffer, pages: number, snapshotPages: number,
 *                    resumePages: number, extraPages: number, mode: string,
 *                    bound: object[], skipped: object[], detail: string}>}
 */
export async function stitchSnapshot({ snapshotBytes, sources = [] }) {
  const doc = await PDFDocument.load(snapshotBytes);
  const snapshotPages = doc.getPageCount();
  const fonts = {
    reg: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };

  const bound = [];
  const skipped = [];
  let budget = MAX_BOUND_PAGES;

  for (const source of sources) {
    if (budget <= 0) {
      skipped.push({ label: source.label, reason: `past the ${MAX_BOUND_PAGES}-page limit` });
      continue;
    }
    const result = await bindOne(doc, source, fonts);
    if (result.bound) { bound.push(result.bound); budget -= result.bound.pages; }
    else skipped.push(result.skipped);
  }

  if (!bound.length) {
    return {
      bytes: Buffer.from(snapshotBytes),
      pages: snapshotPages,
      snapshotPages,
      resumePages: 0,
      extraPages: 0,
      mode: STITCH_MODE.snapshotOnly,
      bound,
      skipped,
      detail: skipped.length
        ? `nothing could be bound in (${skipped.map((x) => x.reason).join('; ')}) — Snapshot ships alone`
        : 'no documents on file — Snapshot ships alone',
    };
  }

  const read = bound.find((b) => b.read) ?? null;
  const extras = bound.filter((b) => !b.read);
  const parts = [
    read
      ? (read.mode === STITCH_MODE.typeset
        ? 'resume typeset from a Word document, original layout not preserved'
        : `${read.pages}-page resume merged, layout intact`)
      : 'resume not bound in',
    extras.length ? `plus ${extras.length} document${extras.length === 1 ? '' : 's'} they also submitted, unscored` : '',
    skipped.length ? `${skipped.length} left out (${skipped.map((x) => x.reason).join('; ')})` : '',
  ].filter(Boolean);

  return {
    bytes: Buffer.from(await doc.save()),
    pages: doc.getPageCount(),
    snapshotPages,
    resumePages: read?.pages ?? 0,
    extraPages: extras.reduce((n, b) => n + b.pages, 0),
    mode: read?.mode ?? STITCH_MODE.merged,
    bound,
    skipped,
    detail: parts.join(' · '),
  };
}

/**
 * Every document a candidate supplied, bound in behind the Snapshot.
 * The resume is the one Sam read; anything else is marked as merely submitted.
 */
export async function stitchSnapshotWithResume({ snapshotBytes, response, cacheDir }) {
  const sources = cacheDir
    ? candidateFilesForResponse(response, cacheDir)
    : candidateFilesForResponse(response);
  return stitchSnapshot({ snapshotBytes, sources });
}
