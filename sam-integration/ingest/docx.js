/**
 * Minimal read-only .docx text extractor built on the ZIP reader in ./xlsx.js.
 *
 * Candidate resumes arrive as .pdf or .docx. A .docx is a ZIP of XML parts, so the
 * whole job is: unzip, then walk WordprocessingML for the handful of elements that
 * carry visible text. Reusing readZipEntries() from the .xlsx reader keeps the
 * dependency list at zero — no docx library, no new npm surface to audit.
 *
 * Deliberately narrow: downstream matching wants a flat, readable text stream, not a
 * faithful document model. Formatting, images, comments, field codes (<w:instrText>)
 * and tracked deletions (<w:delText>) are dropped on purpose by only reading <w:t>.
 */
import { readZipEntries } from '../../shared/seed/xlsx.js';

/** Signals a buffer that is not a ZIP container at all, so it cannot be a .docx. */
export class DocxFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DocxFormatError';
  }
}

const MAIN_PART = 'word/document.xml';
const HEADER_FOOTER_PART = /^word\/(?:header|footer)\d*\.xml$/;

// Every ZIP record starts with "PK" plus a two-byte record type. Accepting the
// local-file, central-directory, EOCD, data-descriptor and spanning signatures
// covers real archives, including the empty and split-archive edge cases.
const ZIP_SIGNATURES = new Set([0x04034b50, 0x02014b50, 0x06054b50, 0x08074b50, 0x30304b50]);

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const MAX_CODE_POINT = 0x10ffff;

/**
 * Decodes the five predefined XML entities plus numeric character references.
 *
 * This mirrors the private helper in xlsx.js. The brief forbids editing existing
 * files to export it, and a nine-line pure function is a cheaper duplication than
 * a shared module that both readers would have to be rewired through.
 */
function decodeXmlText(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (match, entity) => {
    if (entity[0] !== '#') return ENTITIES[entity] ?? match;
    const code = entity[1] === 'x' || entity[1] === 'X'
      ? Number.parseInt(entity.slice(2), 16)
      : Number.parseInt(entity.slice(1), 10);
    // String.fromCodePoint throws on NaN, negatives and anything past the Unicode
    // ceiling. A malformed reference must leave the resume readable, not crash it,
    // so an out-of-range reference is left as the literal text the author wrote.
    if (!Number.isInteger(code) || code < 0 || code > MAX_CODE_POINT) return match;
    return String.fromCodePoint(code);
  });
}

/**
 * The elements that carry text or spacing, matched in document order.
 *
 * Alternatives are ordered so <w:t> wins before <w:tab>: they share a prefix, and a
 * self-closing <w:t/> must not be mistaken for a tab. Paragraphs are cut on the
 * closing tag (plus the self-closing empty form) so a run's text is already collected
 * by the time the break is emitted.
 */
const NODE = /<w:t(?<attrs>\s[^>]*)?(?:\/>|>(?<text>[\s\S]*?)<\/w:t>)|<w:(?<ws>tab|br|cr)\b(?<wsAttrs>[^>]*)>|(?<para><w:p(?:\s[^>]*)?\/>|<\/w:p>)/g;

// A <w:tab> carrying w:val/w:pos is a tab-stop *definition* inside <w:tabs> in the
// paragraph properties, not a tab character. Only the bare run-level element is text.
const TAB_STOP = /\bw:(?:val|pos)\s*=/;

const PRESERVE_SPACE = /\bxml:space\s*=\s*"preserve"/;

/**
 * Resolves one run's text.
 *
 * xml:space="preserve" means the spacing inside <w:t> is literal content. Without it
 * the whitespace is incidental markup, so it collapses — that is what keeps a
 * pretty-printed part from injecting newlines into the middle of a sentence.
 */
function runText(body, attrs) {
  const decoded = decodeXmlText(body);
  if (attrs && PRESERVE_SPACE.test(attrs)) return decoded;
  return decoded.replace(/\s+/g, ' ').trim();
}

/** Flattens one WordprocessingML part into raw text with paragraph and line breaks. */
function collectText(xml) {
  // Word writes a text box twice: once under <mc:Choice> for modern readers and again
  // under <mc:Fallback> as VML for old ones. Keeping both duplicates every word in the
  // box, so the fallback copy is dropped before the walk.
  const source = xml.replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, '');

  let out = '';
  for (const node of source.matchAll(NODE)) {
    const { attrs, text, ws, wsAttrs, para } = node.groups;
    if (para !== undefined) {
      out += '\n';
    } else if (ws === 'tab') {
      if (!TAB_STOP.test(wsAttrs)) out += '\t';
    } else if (ws !== undefined) {
      out += '\n'; // <w:br/> and <w:cr/> are line breaks within a paragraph.
    } else if (text !== undefined) {
      out += runText(text, attrs);
    }
  }
  return out;
}

/**
 * Tidies extracted text for downstream keyword and employer matching.
 *
 * Non-breaking spaces are folded to plain spaces because "Senior Engineer" would
 * otherwise miss a plain-text search, and runs of blank lines collapse so a resume's
 * spacer paragraphs do not bury its content.
 */
function normalizeText(raw) {
  return raw
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Reads one archive entry as text, or '' when the part is absent. */
function partText(entries, name) {
  const part = entries.get(name);
  return part ? normalizeText(collectText(part.toString('utf8'))) : '';
}

/**
 * Falls back to the page headers and footers.
 *
 * Some resumes put the whole contact block in a header and leave the body to the
 * template. Word then repeats byte-identical header parts per section, so identical
 * extractions are de-duplicated rather than printed three times.
 */
function headerFooterText(entries) {
  // Headers before footers: a resume that leans on the page header keeps its contact
  // block there, so it must lead the extracted text rather than trail a footer note.
  const rank = (name) => (name.startsWith('word/header') ? 0 : 1);
  const names = [...entries.keys()]
    .filter((n) => HEADER_FOOTER_PART.test(n))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

  const seen = new Set();
  for (const name of names) {
    const text = partText(entries, name);
    if (text) seen.add(text);
  }
  return [...seen].join('\n\n');
}

/** Accepts the Buffer/typed-array shapes readFileSync and fetch responses produce. */
function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new DocxFormatError(`Expected a Buffer or typed array holding a .docx, received ${value === null ? 'null' : typeof value}.`);
}

/**
 * Extracts the visible text of a .docx buffer.
 *
 * Throws DocxFormatError only when the input is not a ZIP container — that is a
 * caller bug (a .pdf routed to the wrong reader) and must be loud. Anything else —
 * a truncated archive, an unsupported compression method, a missing document part —
 * returns '' instead: one damaged resume must not abort an ingest run, and the empty
 * result is checkable by the caller, so nothing fails silently downstream.
 *
 * @param {Buffer|ArrayBuffer|ArrayBufferView} buffer raw bytes of a .docx file
 * @returns {string} paragraph-separated document text, or '' if it cannot be read
 */
export function extractDocxText(buffer) {
  const buf = toBuffer(buffer);
  if (buf.length < 4 || !ZIP_SIGNATURES.has(buf.readUInt32LE(0))) {
    throw new DocxFormatError('Not a .docx file: the buffer does not begin with a ZIP record signature.');
  }

  try {
    const entries = readZipEntries(buf);
    const body = partText(entries, MAIN_PART);
    return body || headerFooterText(entries);
  } catch {
    return '';
  }
}
