/**
 * Dependency-free PDF text extraction.
 *
 * Built on node:zlib rather than a PDF library because the build brief forbids new
 * dependencies, and the only PDF package already present (pdf-lib) writes documents
 * rather than reading them.
 *
 * The approach is deliberately forgiving: scan for content streams, inflate the ones
 * that inflate, and pull text out of the text-showing operators. Font programs and
 * images will fail to decode or contain no text — those are skipped rather than
 * treated as errors, because a resume that yields most of its text is far more useful
 * than an exception.
 */
import { inflateSync, inflateRawSync } from 'node:zlib';

/** A TJ kerning offset more negative than this reads as a word space. */
const SPACE_KERN = -100;

/** Inflates a stream, tolerating both zlib and raw deflate framing. */
function inflate(buf) {
  try { return inflateSync(buf); } catch { /* fall through to raw */ }
  try { return inflateRawSync(buf); } catch { return null; }
}

/** Yields the raw bytes of every stream in the file, paired with its object dictionary. */
function* streams(buf) {
  let at = 0;
  for (;;) {
    const start = buf.indexOf('stream', at);
    if (start === -1) return;

    // Only a real `stream` keyword counts, not the tail of `endstream`.
    if (start >= 3 && buf.slice(start - 3, start).toString('latin1') === 'end') {
      at = start + 6;
      continue;
    }

    const dictStart = buf.lastIndexOf('<<', start);
    const dict = dictStart === -1 ? '' : buf.slice(dictStart, start).toString('latin1');

    // Skip the end-of-line after the keyword: CRLF or LF.
    let dataStart = start + 6;
    if (buf[dataStart] === 0x0d) dataStart += 1;
    if (buf[dataStart] === 0x0a) dataStart += 1;

    const end = buf.indexOf('endstream', dataStart);
    if (end === -1) return;

    yield { dict, data: buf.slice(dataStart, end) };
    at = end + 9;
  }
}

const OCTAL = /\\([0-7]{1,3})/g;
const ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };

/** Decodes a PDF literal string body, resolving escapes and octal codes. */
function decodeLiteral(body) {
  return body
    .replace(/\\\n/g, '')
    .replace(OCTAL, (_, o) => String.fromCharCode(Number.parseInt(o, 8)))
    .replace(/\\([nrtbf()\\])/g, (_, ch) => ESCAPES[ch] ?? ch);
}

/** Decodes a PDF hex string, handling UTF-16BE where the byte-order mark says so. */
function decodeHex(body, cmap) {
  const hex = body.replace(/[^0-9a-fA-F]/g, '');
  const pairs = hex.length % 2 ? `${hex}0` : hex;
  const bytes = Buffer.from(pairs, 'hex');

  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return bytes.subarray(2).swap16().toString('utf16le');
  }

  // Subset-embedded fonts write glyph IDs, not characters. Without the font's
  // ToUnicode map those bytes decode to control characters — the mojibake that made
  // an earlier version of this extractor look like it was working when it was not.
  if (cmap && cmap.size) {
    let out = '';
    let mapped = 0;
    let codes = 0;
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const code = (bytes[i] << 8) | bytes[i + 1];
      const ch = cmap.get(code);
      codes += 1;
      if (ch !== undefined) { out += ch; mapped += 1; } else out += ' ';
    }
    // Only trust the map when it explains most of the string. Documents that already
    // use a standard encoding will match a stray code or two by coincidence, and
    // taking the mapped path for those replaces good text with blanks.
    if (codes > 0 && mapped / codes >= 0.7) return out;
  }
  return bytes.toString('latin1');
}

const surrogatesToString = (hex) => {
  const units = [];
  for (let i = 0; i + 3 < hex.length + 1; i += 4) units.push(Number.parseInt(hex.slice(i, i + 4), 16));
  return String.fromCharCode(...units.filter(Number.isFinite));
};

/**
 * Builds a glyph-code to text map from every ToUnicode CMap in the document.
 *
 * Codes are unioned across fonts rather than tracked per font. Subset fonts in a
 * single resume almost always agree where they overlap, and the alternative —
 * resolving /Resources /Font indirect references per content stream — is a large
 * amount of machinery for a small accuracy gain on this corpus.
 */
function buildToUnicodeMap(buf) {
  const map = new Map();

  for (const { data } of streams(buf)) {
    const raw = inflate(data) ?? data;
    const text = raw.toString('latin1');
    if (!text.includes('beginbfchar') && !text.includes('beginbfrange')) continue;

    for (const block of text.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
      for (const m of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        map.set(Number.parseInt(m[1], 16), surrogatesToString(m[2]));
      }
    }

    for (const block of text.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? []) {
      // <lo> <hi> <dstStart>
      for (const m of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        const lo = Number.parseInt(m[1], 16);
        const hi = Number.parseInt(m[2], 16);
        const dst = Number.parseInt(m[3], 16);
        if (hi - lo > 0xffff) continue;
        for (let c = lo; c <= hi; c += 1) map.set(c, String.fromCharCode(dst + (c - lo)));
      }
      // <lo> <hi> [ <a> <b> ... ]
      for (const m of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g)) {
        const lo = Number.parseInt(m[1], 16);
        const items = [...m[3].matchAll(/<([0-9A-Fa-f]+)>/g)].map((x) => surrogatesToString(x[1]));
        items.forEach((v, i) => map.set(lo + i, v));
      }
    }
  }
  return map;
}

/**
 * Rejects output that decoded to glyph codes rather than characters.
 * Returning nothing is more useful than returning convincing-looking garbage.
 */
/**
 * Per-stream quality check. A document can mix one stream that decoded cleanly with
 * another whose font had no usable ToUnicode map; keeping only the streams that read
 * as text rescues documents that a whole-document check would throw away entirely.
 */
function streamLooksLikeText(lines) {
  const joined = lines.join(' ');
  const solid = joined.replace(/\s/g, '');
  if (solid.length < 24) return false;
  const words = joined.match(/[A-Za-z]{3,}/g) ?? [];
  const inWords = words.reduce((n, w) => n + w.length, 0);
  return inWords / solid.length >= 0.4;
}

function isReadable(text) {
  const solid = text.replace(/\s/g, '');
  if (solid.length < 120) return false;

  // Real prose is made of words. A document whose glyph codes failed to map produces
  // plenty of letters but almost no alphabetic runs long enough to be words, which
  // separates genuine text from convincing-looking noise far better than a letter
  // count does.
  const words = text.match(/[A-Za-z]{3,}/g) ?? [];
  if (words.length < 40) return false;
  const inWords = words.reduce((n, w) => n + w.length, 0);
  return inWords / solid.length >= 0.45;
}

/**
 * Inside a TJ array a number more negative than SPACE_KERN separates two words that
 * would otherwise be glued together, so it is rewritten as an explicit space string
 * before the main pass runs.
 */
function applyKerningSpaces(content) {
  return content.replace(/\[((?:\\.|[^\]\\])*)\]\s*TJ/g, (whole, inner) => {
    // Walk the array token by token. Numbers BETWEEN strings are kerning; digits
    // INSIDE a string are content, and rewriting those was silently deleting every
    // number from the extracted text — phone numbers, dates, GPAs, quota figures.
    let out = '';
    let i = 0;
    while (i < inner.length) {
      const ch = inner[i];
      if (ch === '(') {
        let depth = 1;
        let j = i + 1;
        for (; j < inner.length && depth > 0; j += 1) {
          if (inner[j] === '\\') { j += 1; continue; }
          if (inner[j] === '(') depth += 1;
          else if (inner[j] === ')') depth -= 1;
        }
        out += inner.slice(i, j);
        i = j;
        continue;
      }
      const num = /^-?\d+(?:\.\d+)?/.exec(inner.slice(i));
      if (num) {
        if (Number.parseFloat(num[0]) < SPACE_KERN) out += '( )';
        i += num[0].length;
        continue;
      }
      out += ch;
      i += 1;
    }
    return `${out} TJ`;
  });
}

/**
 * Removes inline dictionaries before text parsing.
 *
 * Marked-content operators carry property dictionaries such as
 * `/Span <</Lang (en-US)>> BDC`, whose string values are metadata, not page text.
 * Left in, every tagged span injects a stray "en-US" into the output.
 */
function stripInlineDicts(content) {
  return content.replace(/<<[\s\S]*?>>/g, ' ');
}

/**
 * Walks one content stream and reassembles its text.
 * Text-positioning operators become line breaks so lines do not run together.
 */
function textFromContent(content, cmap) {
  const out = [];
  let line = '';
  let lastY = null;

  const flush = () => {
    const t = line.replace(/[ \t]+/g, ' ').trim();
    if (t) out.push(t);
    line = '';
  };

  /**
   * A new output line is only started when the text cursor actually moves down the
   * page. Breaking on every Td instead puts each glyph on its own line, which is what
   * a naive reading of the operators produces for kerned, per-glyph-positioned PDFs.
   */
  const moveTo = (y) => {
    if (lastY !== null && Math.abs(y - lastY) > 1.5) flush();
    lastY = y;
  };

  const TOKEN = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]*>|-?\d+(?:\.\d+)?|Td|TD|Tm|T\*|TJ|Tj|BT|ET|'|"/g;
  let nums = [];
  let m;

  while ((m = TOKEN.exec(content)) !== null) {
    const tok = m[0];

    if (tok[0] === '(') { line += decodeLiteral(tok.slice(1, -1)); continue; }
    if (tok[0] === '<') { line += decodeHex(tok.slice(1, -1), cmap); continue; }
    if (/^-?\d/.test(tok)) { nums.push(Number.parseFloat(tok)); continue; }

    switch (tok) {
      case 'Td':
      case 'TD': {
        // operands are (tx, ty), relative to the previous line's origin
        // Word gaps already arrive from TJ kerning and from literal spaces in the
        // strings themselves. Adding another space per horizontal move puts one
        // between every glyph in a per-glyph-positioned PDF.
        const ty = nums.length >= 2 ? nums[nums.length - 1] : 0;
        if (lastY === null) lastY = 0;
        if (Math.abs(ty) > 1.5) flush();
        lastY += ty;
        break;
      }
      case 'Tm': {
        // operands are a b c d e f; f is the absolute Y translation
        const y = nums.length >= 6 ? nums[nums.length - 1] : null;
        if (y !== null) moveTo(y);
        break;
      }
      case 'T*':
      case "'":
      case '"':
        flush();
        break;
      case 'ET':
        flush();
        lastY = null;
        break;
      default:
        break;
    }
    nums = [];
  }
  flush();
  return out;
}

/**
 * Extracts readable plain text from a PDF buffer.
 * Never throws — returns whatever was recovered, or an empty string if nothing was.
 */
export function extractPdfText(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const cmap = buildToUnicodeMap(buf);
  const lines = [];

  for (const { dict, data } of streams(buf)) {
    // Only Flate-compressed streams, and never images or embedded font programs.
    if (!/FlateDecode/.test(dict)) continue;
    if (/\/Subtype\s*\/Image|\/FontFile/.test(dict)) continue;

    const raw = inflate(data);
    if (!raw) continue;

    const content = raw.toString('latin1');
    if (!/TJ|Tj/.test(content)) continue; // no text-showing operators in this stream

    try {
      const got = textFromContent(applyKerningSpaces(stripInlineDicts(content)), cmap)
        .map((l) => l.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim())
        .filter(Boolean);
      if (streamLooksLikeText(got)) lines.push(...got);
    } catch { /* a malformed stream must not sink the whole document */ }
  }

  const text = lines
    .join('\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/\u00ad/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return isReadable(text) ? text : '';
}

/** Counts pages by their /Type /Page objects, ignoring the /Pages tree node. */
export function pdfPageCount(buffer) {
  const s = Buffer.isBuffer(buffer) ? buffer.toString('latin1') : String(buffer);
  return (s.match(/\/Type\s*\/Page(?![s])/g) ?? []).length;
}
