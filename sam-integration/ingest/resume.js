/**
 * Resume text to the structured CAREER HISTORY the Snapshot design requires.
 *
 * Extraction gives us text in reading order but heavily fragmented — a PDF emits a new
 * line every time the text cursor moves, so a single resume line can arrive as six.
 * The parser therefore reflows first and only then looks for structure.
 *
 * Deterministic by construction: no clock, no randomness. "Present" is resolved
 * against the exported AS_OF constant so the same resume always yields the same
 * tenure, which is what lets the scoring output be golden-filed.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { extname } from 'node:path';
import { extractPdfText } from './pdf.js';
import { extractDocxText } from './docx.js';

/**
 * The date "Present" resolves to. Fixed rather than `new Date()` so scoring stays
 * reproducible — a tenure that grows every day would break every golden file.
 */
export const AS_OF = { year: 2026, month: 8 };

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const SECTIONS = {
  experience: /^(work\s+)?(professional\s+)?(experience|employment|work\s+history|career)\b/i,
  education: /^education\b/i,
  skills: /^(technical\s+)?(skills|competencies|core\s+competencies|tools)\b/i,
  summary: /^(summary|profile|objective|about)\b/i,
  other: /^(certifications?|awards?|projects?|volunteer|interests|references|languages)\b/i,
};

const PRESENT = /\b(present|current|now|to\s*date|ongoing)\b/i;
const BULLET = /^[•▪●·‣⁃*\-–—]\s*/;

/**
 * Reflows fragmented extraction output back into resume-shaped lines.
 *
 * A fragment that is very short, or that ends mid-sentence, almost certainly belongs
 * with the next one. Joining these is what makes "Krasan" + "Consulting Services"
 * resolve to a single employer rather than two.
 */
function reflow(text) {
  const raw = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const out = [];

  for (const line of raw) {
    const prev = out[out.length - 1];
    const joinable = prev
      && !BULLET.test(line)
      && !isSectionHeader(line)
      && !isSectionHeader(prev)
      && (
        // previous fragment ended mid-word or mid-clause
        /[,;&/|(-]$/.test(prev)
        || /^[,;&/|)-]/.test(line)
        // both sides are short enough to be one visual line split by the extractor
        || (prev.length < 45 && line.length < 45 && !/[.!?:]$/.test(prev))
      );

    if (joinable) {
      out[out.length - 1] = `${prev}${/[-/(]$/.test(prev) || /^[)\-/,;]/.test(line) ? '' : ' '}${line}`.replace(/\s+/g, ' ');
    } else {
      out.push(line);
    }
  }
  return out;
}

function isSectionHeader(line) {
  if (line.length > 42) return false;
  return Object.values(SECTIONS).some((re) => re.test(line));
}

function sectionOf(line) {
  for (const [name, re] of Object.entries(SECTIONS)) {
    if (line.length <= 42 && re.test(line)) return name;
  }
  return null;
}

/** Parses "Jan 2020", "01/2020", "2020" into { year, month }. */
function parsePoint(token) {
  const t = token.trim();
  const named = /([A-Za-z]{3,9})\.?\s+(\d{4})/.exec(t);
  if (named && MONTHS[named[1].toLowerCase()]) {
    return { year: Number(named[2]), month: MONTHS[named[1].toLowerCase()] };
  }
  const numeric = /(\d{1,2})\s*[/-]\s*(\d{4})/.exec(t);
  if (numeric) return { year: Number(numeric[2]), month: Number(numeric[1]) };
  const yearOnly = /\b(19|20)(\d{2})\b/.exec(t);
  if (yearOnly) return { year: Number(`${yearOnly[1]}${yearOnly[2]}`), month: 1 };
  return null;
}

const DATE_RANGE = new RegExp(
  '((?:[A-Za-z]{3,9}\\.?\\s+)?(?:\\d{1,2}\\s*[/-]\\s*)?(?:19|20)\\d{2})'
  + '\\s*(?:-|–|—|to|until|through)\\s*'
  + '((?:[A-Za-z]{3,9}\\.?\\s+)?(?:\\d{1,2}\\s*[/-]\\s*)?(?:19|20)\\d{2}|present|current|now|to\\s*date|ongoing)',
  'i',
);

const monthsBetween = (a, b) => Math.max(0, (b.year - a.year) * 12 + (b.month - a.month));

/** Finds a date range anywhere in a line and normalises it. */
function parseRange(line) {
  const m = DATE_RANGE.exec(line);
  if (!m) return null;
  const start = parsePoint(m[1]);
  if (!start) return null;
  const current = PRESENT.test(m[2]);
  const end = current ? AS_OF : parsePoint(m[2]);
  if (!end) return null;
  return {
    start: `${start.year}-${String(start.month).padStart(2, '0')}`,
    end: current ? 'Present' : `${end.year}-${String(end.month).padStart(2, '0')}`,
    current,
    durationMonths: monthsBetween(start, end),
    matched: m[0],
  };
}

const NOISE = /^(resume|curriculum vitae|cv)$/i;

/**
 * Splits the residue of a role line into a title and a company.
 * Handles "Title, Company", "Title | Company", "Company; City, State" and the very
 * common case where the two sit on adjacent lines.
 */
function splitRole(line, neighbour) {
  const cleaned = line.replace(DATE_RANGE, '').replace(/^[,;|\s-]+|[,;|\s-]+$/g, '').trim();
  const parts = cleaned.split(/\s*[|·•]\s*|\s+[-–—]\s+|\s*,\s*(?=[A-Z])/).filter(Boolean);

  // Strip a trailing "; City, ST" location, which otherwise lands in the company.
  const withoutPlace = cleaned.replace(/\s*[;,]\s*[A-Z][A-Za-z .]+,\s*(?:[A-Z]{2}|[A-Z][a-z]+)\s*$/, '').trim();
  const segs = withoutPlace.split(/\s*[|·•]\s*|\s+[-–—]\s+|\s*;\s*/).filter(Boolean);

  const looksLikeTitle = (v) => /\b(manager|director|executive|representative|associate|analyst|lead|head|officer|specialist|consultant|engineer|intern|president|vp|coordinator|agent|advisor|partner|owner|founder|sales|account)\b/i.test(v);

  if (segs.length >= 2) {
    const [a, b] = segs;
    return looksLikeTitle(a) && !looksLikeTitle(b)
      ? { title: a, company: b }
      : { title: looksLikeTitle(b) ? b : a, company: looksLikeTitle(b) ? a : b };
  }

  if (withoutPlace && neighbour) {
    const other = neighbour.replace(DATE_RANGE, '').replace(/^[,;|\s-]+|[,;|\s-]+$/g, '').trim();
    if (other && !BULLET.test(neighbour)) {
      return looksLikeTitle(other)
        ? { title: other, company: withoutPlace }
        : { title: withoutPlace, company: other };
    }
  }
  return looksLikeTitle(withoutPlace)
    ? { title: withoutPlace, company: '' }
    : { title: '', company: withoutPlace };
}

const SKILL_SPLIT = /[,;•|·•]|\s{2,}/;

/**
 * Parses extracted resume text into structured fields.
 * Never throws — an unparseable resume returns empty arrays, not an exception.
 */
export function parseResume(text) {
  const empty = {
    roles: [], skills: [], education: [], totalExperienceMonths: 0,
    emails: [], phones: [], links: [], raw: String(text ?? ''),
  };
  if (!text || typeof text !== 'string') return empty;

  const lines = reflow(text);
  if (!lines.length) return empty;

  const flat = lines.join('\n');
  const emails = [...new Set(flat.match(/[\w.+-]+@[\w-]+\.[\w.]{2,}/g) ?? [])];
  const phones = [...new Set(flat.match(/\+?\d[\d\s().-]{8,}\d/g) ?? [])].map((p) => p.trim());
  const links = [...new Set(flat.match(/(?:https?:\/\/)?(?:www\.)?(?:linkedin\.com|github\.com)\/[\w\-/]+/gi) ?? [])];

  const roles = [];
  const education = [];
  const skills = [];
  let section = 'summary';

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const header = sectionOf(line);
    if (header) { section = header; continue; }
    if (NOISE.test(line)) continue;

    if (section === 'skills') {
      for (const s of line.split(SKILL_SPLIT)) {
        const v = s.trim().replace(/^[-–—•\s]+/, '');
        if (v.length > 1 && v.length < 42 && !/^\d+$/.test(v)) skills.push(v);
      }
      continue;
    }

    if (section === 'education') {
      const range = parseRange(line);
      const year = range?.end?.slice(0, 4) ?? /\b(19|20)\d{2}\b/.exec(line)?.[0] ?? null;
      const inst = line.replace(DATE_RANGE, '').replace(/[;,]\s*$/, '').trim();
      if (inst.length > 3 && !BULLET.test(line)) {
        education.push({ institution: inst, credential: '', year });
      }
      continue;
    }

    // Roles are looked for everywhere except education. Many resumes — LinkedIn
    // exports especially — carry no EXPERIENCE heading at all, and requiring one
    // silently dropped most of this corpus.
    if (section === 'education' || section === 'other') continue;

    if (BULLET.test(line)) {
      const last = roles[roles.length - 1];
      if (last) last.bullets.push(line.replace(BULLET, '').trim());
      continue;
    }

    const range = parseRange(line);
    if (!range) {
      const last = roles[roles.length - 1];
      // An unbulleted continuation line under a role is still describing that role.
      if (last && line.length > 40) last.bullets.push(line);
      continue;
    }

    const { title, company } = splitRole(line, lines[i - 1]);
    roles.push({
      title: title || '(title not stated)',
      company: company || '(employer not stated)',
      start: range.start,
      end: range.end,
      current: range.current,
      durationMonths: range.durationMonths,
      bullets: [],
    });
  }

  // Overlapping roles must not double-count, so total tenure is measured over a union.
  const spans = roles
    .map((r) => [Number(r.start.slice(0, 4)) * 12 + Number(r.start.slice(5, 7)), r.durationMonths])
    .filter(([, d]) => d > 0)
    .map(([s, d]) => [s, s + d])
    .sort((a, b) => a[0] - b[0]);

  let total = 0;
  let cursor = -Infinity;
  for (const [s, e] of spans) {
    const from = Math.max(s, cursor);
    if (e > from) { total += e - from; cursor = e; }
  }

  return {
    roles,
    skills: [...new Set(skills)].slice(0, 30),
    education: education.slice(0, 5),
    totalExperienceMonths: total,
    emails, phones, links,
    raw: text,
  };
}

/** Reads a resume file and returns its plain text, dispatching on extension. */
export function loadResumeText(filePath) {
  const ext = extname(filePath).toLowerCase();
  const buf = readFileSync(filePath);
  if (ext === '.pdf') return extractPdfText(buf);
  if (ext === '.docx') return extractDocxText(buf);
  throw new Error(`Unsupported resume format "${ext}" for ${filePath}. Expected .pdf or .docx.`);
}


/**
 * Finds and parses the cached copy of a candidate's own resume.
 *
 * The Snapshot design's CAREER HISTORY comes from the resume, not the interview — the
 * transcripts name employers inconsistently (one candidate's employer is transcribed
 * three different ways across two answers), while the resume spells it once, correctly.
 *
 * Returns null when the file is not cached or nothing parses, so the renderer can show an
 * honest empty state instead of inventing a work history.
 */
/**
 * Locates the cached resume file itself, rather than its text.
 *
 * The stitcher needs the bytes and the format, not the parse: a PDF resume is merged
 * page-for-page so the candidate's own layout survives, while a Word document can only
 * be typeset from extracted text. Both callers agree on where the file lives because
 * they share this one lookup.
 *
 * @returns {{path: string, ext: string} | null}
 */
export function resumeFileForResponse(response, cacheDir = '.cache/resumes') {
  if (!response?.resume?.name) return null;
  const prefix = String(response.rowNumber).padStart(2, '0');
  let entries;
  try { entries = readdirSync(cacheDir); } catch { return null; }
  const file = entries.find((f) => f.startsWith(`${prefix}_`) && /\.(pdf|docx)$/i.test(f));
  if (!file) return null;
  return { path: `${cacheDir}/${file}`, ext: file.slice(file.lastIndexOf('.') + 1).toLowerCase() };
}

export function resumeForResponse(response, cacheDir = '.cache/resumes') {
  const found = resumeFileForResponse(response, cacheDir);
  if (!found) return null;
  try {
    const parsed = parseResume(loadResumeText(found.path));
    return parsed.roles.length || parsed.skills.length ? parsed : null;
  } catch {
    return null;
  }
}
