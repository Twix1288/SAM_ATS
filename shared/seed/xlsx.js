/**
 * Minimal read-only .xlsx reader built on node:zlib.
 *
 * Replaces the `xlsx` npm package, which ships two unpatched high-severity
 * advisories (prototype pollution GHSA-4r6h-8v6p-xvw6, ReDoS GHSA-5pgg-2g8v-p4x9)
 * with no registry fix available. We read one known local file, so the whole
 * surface we need is a ZIP reader and two XML shapes.
 */
import { inflateRawSync } from 'node:zlib';

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;

/** Reads a ZIP archive into a Map of entry name -> decompressed Buffer. */
export function readZipEntries(buf) {
  let eocd = -1;
  const floor = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid .xlsx file: no ZIP end-of-central-directory record.');

  const entryCount = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map();

  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(off) !== SIG_CENTRAL) {
      throw new Error(`Corrupt .xlsx: bad central-directory header at entry ${i}.`);
    }
    const method = buf.readUInt16LE(off + 10);
    const compressedSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);

    const localNameLen = buf.readUInt16LE(localOff + 26);
    const localExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);

    if (method !== 0 && method !== 8) {
      throw new Error(`Unsupported compression method ${method} for entry "${name}".`);
    }
    entries.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXmlText(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X'
        ? parseInt(e.slice(2), 16)
        : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

/** Concatenates every <t> run inside an XML fragment (shared strings may be split across runs). */
function joinTextRuns(fragment) {
  let out = '';
  for (const m of fragment.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) out += m[1];
  return decodeXmlText(out);
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => joinTextRuns(m[1]));
}

const columnOf = (ref) => ref.replace(/\d+/g, '');
const rowOf = (ref) => Number.parseInt(ref.replace(/\D+/g, ''), 10);

/** Pulls the target and display text out of a HYPERLINK("url","label") formula. */
export function parseHyperlink(formula) {
  const m = /^\s*HYPERLINK\s*\(\s*"((?:[^"]|"")*)"\s*(?:,\s*"((?:[^"]|"")*)"\s*)?\)\s*$/i.exec(formula);
  if (!m) return null;
  const unquote = (v) => (v === undefined ? '' : v.replace(/""/g, '"'));
  return { href: unquote(m[1]), label: unquote(m[2]) };
}

/**
 * Reads the first worksheet of an .xlsx buffer.
 * Returns { rows, links } — rows maps row number -> { COLUMN: displayText },
 * links maps a cell ref -> { href, label } for HYPERLINK formula cells.
 */
export function readSheet(buf) {
  const entries = readZipEntries(buf);
  const shared = parseSharedStrings(entries.get('xl/sharedStrings.xml')?.toString('utf8'));

  const sheetName = [...entries.keys()]
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort()[0];
  if (!sheetName) throw new Error('No worksheet found inside the .xlsx archive.');

  const xml = entries.get(sheetName).toString('utf8');
  const rows = new Map();
  const links = new Map();

  // Match each <c> element individually. A self-closing <c .../> must not be allowed
  // to swallow the next cell's body, so the two forms are matched as alternatives.
  const CELL = /<c\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;

  for (const cell of xml.matchAll(CELL)) {
    const attrs = cell[1];
    const body = cell[2] ?? '';
    const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1];
    if (!ref) continue;
    const type = /t="([^"]+)"/.exec(attrs)?.[1];

    // A formula cell caches its last computed result in <v>. Excel caches HYPERLINK()
    // as 0, so the real content — both the target and the display text — lives only in
    // <f>. Reading <v> here is what previously turned every resume into the string "0".
    const formula = /<f[^>]*>([\s\S]*?)<\/f>/.exec(body)?.[1];
    if (formula) {
      const link = parseHyperlink(decodeXmlText(formula));
      if (link) {
        const r = rowOf(ref);
        if (!rows.has(r)) rows.set(r, Object.create(null));
        rows.get(r)[columnOf(ref)] = link.label || link.href;
        links.set(ref, link);
        continue;
      }
    }

    let value;
    if (type === 's') {
      const idx = Number.parseInt(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '', 10);
      value = shared[idx] ?? '';
    } else if (type === 'inlineStr') {
      value = joinTextRuns(body);
    } else {
      const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      if (raw === undefined) continue;
      value = decodeXmlText(raw);
    }
    if (value === '') continue;

    const r = rowOf(ref);
    if (!rows.has(r)) rows.set(r, Object.create(null));
    rows.get(r)[columnOf(ref)] = value;
  }
  return { rows, links };
}
