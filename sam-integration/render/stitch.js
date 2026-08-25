/**
 * One attachment instead of two.
 *
 * Sam's Snapshot is a judgement, and a judgement is worth less when the evidence it was
 * drawn from sits in a different file. Ashby's Files list gives no ordering guarantee and
 * no way to say "read this one first", so two documents on a record is two documents a
 * reviewer has to relate to each other themselves.
 *
 * So the Snapshot ships with the candidate's own resume bound in behind it, separated by
 * a divider page that says where Sam stops and the source begins. The reviewer opens one
 * file and reads the grade with the evidence directly underneath it.
 *
 * Three outcomes, and the divider page states which one honestly:
 *
 *   merged        the resume was a PDF — copied page for page, their layout intact
 *   typeset       it was a Word document — pdf-lib cannot render .docx, so we set the
 *                 extracted text ourselves and say so rather than implying fidelity
 *   snapshot-only no resume on file, or it would not open — the Snapshot ships alone
 *
 * Never throws. A resume that fails to load costs the reviewer a convenience; a stitcher
 * that throws costs the candidate their entire delivery.
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { readFileSync } from 'node:fs';
import { resumeFileForResponse } from '../ingest/resume.js';
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

/** What the divider page tells the reviewer, per mode. */
const DIVIDER_NOTE = {
  [STITCH_MODE.merged]:
    'The pages that follow are the candidate’s own resume, reproduced exactly as they '
    + 'submitted it. Sam did not alter, reformat or re-order them.',
  [STITCH_MODE.typeset]:
    'The candidate submitted a Word document. The pages that follow are its text, set by '
    + 'Sam — the original formatting is not preserved. Treat the wording as theirs and the '
    + 'layout as ours.',
};

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
 * The page that separates Sam's judgement from the candidate's evidence.
 * It exists so nobody mistakes the resume for something Sam produced.
 */
function addDivider(doc, { name, mode, bold, reg }) {
  const page = doc.addPage(PAGE);
  const top = PAGE[1] - 250;

  page.drawRectangle({ x: 0, y: top + 74, width: PAGE[0], height: 4, color: BRAND });

  page.drawText('SOURCE DOCUMENT', {
    x: M, y: top + 34, size: 22, font: bold, color: INK,
  });
  page.drawText(toWinAnsi(`${name} - submitted with their application`), {
    x: M, y: top + 12, size: 11, font: reg, color: SOFT,
  });

  page.drawLine({
    start: { x: M, y: top - 8 }, end: { x: PAGE[0] - M, y: top - 8 },
    thickness: 0.75, color: RULE,
  });

  let y = top - 34;
  for (const line of wrap(DIVIDER_NOTE[mode], reg, 10.5, WIDTH)) {
    page.drawText(line, { x: M, y, size: 10.5, font: reg, color: INK });
    y -= 15;
  }

  page.drawText('Everything above this page is Sam’s.', {
    x: M, y: y - 22, size: 10, font: bold, color: ACCENT,
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
 * @param {object} args
 * @param {Buffer} args.snapshotBytes  the rendered Snapshot PDF
 * @param {object} args.response       the survey response, for the resume lookup
 * @param {string} [args.cacheDir]
 * @returns {Promise<{bytes: Buffer, mode: string, pages: number, snapshotPages: number,
 *                    resumePages: number, detail: string}>}
 */
export async function stitchSnapshotWithResume({ snapshotBytes, response, cacheDir }) {
  const doc = await PDFDocument.load(snapshotBytes);
  const snapshotPages = doc.getPageCount();
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const only = (detail) => ({
    bytes: Buffer.from(snapshotBytes),
    mode: STITCH_MODE.snapshotOnly,
    pages: snapshotPages,
    snapshotPages,
    resumePages: 0,
    detail,
  });

  const found = cacheDir
    ? resumeFileForResponse(response, cacheDir)
    : resumeFileForResponse(response);
  if (!found) return only('no resume on file — Snapshot ships alone');

  let source;
  try {
    source = readFileSync(found.path);
  } catch (err) {
    return only(`resume unreadable (${err.code ?? 'error'}) — Snapshot ships alone`);
  }

  const name = response?.name ?? 'Candidate';

  if (found.ext === 'pdf') {
    try {
      // ignoreEncryption: a resume with owner-password permissions set still reads fine,
      // and refusing it would cost the reviewer their evidence for no security gain.
      const src = await PDFDocument.load(source, { ignoreEncryption: true });
      const indices = src.getPageIndices();
      if (!indices.length) return only('resume PDF has no pages — Snapshot ships alone');

      addDivider(doc, { name, mode: STITCH_MODE.merged, bold, reg });
      const copied = await doc.copyPages(src, indices);
      for (const page of copied) doc.addPage(page);

      return {
        bytes: Buffer.from(await doc.save()),
        mode: STITCH_MODE.merged,
        pages: doc.getPageCount(),
        snapshotPages,
        resumePages: indices.length,
        detail: `${indices.length}-page resume merged, layout intact`,
      };
    } catch (err) {
      return only(`resume PDF would not open (${err.message.slice(0, 60)}) — Snapshot ships alone`);
    }
  }

  try {
    const text = extractDocxText(source);
    if (!text || !text.trim()) return only('resume text was empty — Snapshot ships alone');

    addDivider(doc, { name, mode: STITCH_MODE.typeset, bold, reg });
    const before = doc.getPageCount();
    addTypesetPages(doc, text, { bold, reg });

    return {
      bytes: Buffer.from(await doc.save()),
      mode: STITCH_MODE.typeset,
      pages: doc.getPageCount(),
      snapshotPages,
      resumePages: doc.getPageCount() - before,
      detail: 'Word document — text typeset by Sam, original layout not preserved',
    };
  } catch (err) {
    return only(`resume text could not be extracted (${err.message.slice(0, 60)}) — Snapshot ships alone`);
  }
}
