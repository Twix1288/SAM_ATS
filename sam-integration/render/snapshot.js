/**
 * Renders the Snapshot view model to a PDF, following Sam_Resume_Snapshot_Design.pdf.
 *
 * Colours come from the shared brand module rather than local literals, so the PDF,
 * the hosted page and the mockup screens cannot drift apart. The brief fixes the
 * palette at teal 4EC8C2 on black 0D0D0D.
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { SAM, TEAL, INK as INK_RAMP, STATE_COLOR, toRgb } from '../../shared/brand.js';

const hex = (h) => rgb(...toRgb(h));

const INK = hex(SAM.black);
const SOFT = hex(INK_RAMP[500]);
const ACCENT = hex(TEAL.deep);      // teal darkened for body-text contrast
const BRAND = hex(SAM.teal);        // the brand teal itself, for fills and rules
const MET = hex(STATE_COLOR.MET.fg);
const MISS = hex(STATE_COLOR.NOT_MET.fg);
const UNCOLL = hex(STATE_COLOR.NOT_COLLECTED.fg);
const PART = hex(STATE_COLOR.PARTIAL.fg);
const RULE = hex(INK_RAMP[200]);

const PAGE = [612, 792];
const M = 46;
const WIDTH = PAGE[0] - M * 2;

/** Bands share the anchor palette so one colour language runs through the page. */
const bandColor = (band) => ({
  Strong: MET, Partial: rgb(0.17, 0.35, 0.54), 'Not shown': MISS,
  'Not asked': UNCOLL, 'Not determined': UNCOLL, 'Not assessed': SOFT,
}[band] ?? SOFT);

const STATE_STYLE = {
  MET: { color: MET, label: 'MET' },
  PARTIAL: { color: PART, label: 'PARTIAL' },
  NOT_MET: { color: MISS, label: 'NOT MET' },
  NOT_COLLECTED: { color: UNCOLL, label: 'NOT COLLECTED' },
};

export async function renderSnapshotPdf(s) {
  const doc = await PDFDocument.create();
  doc.setTitle(`Sam Snapshot — ${s.candidate.name}`);
  doc.setSubject(s.scoreIsPublishable === false
    ? `${s.role.title} · not scored — only ${Math.round(s.coverage * 100)}% of the rubric was observable`
    : `${s.role.title} · Role Fit ${Math.round(s.roleFit * 100)}% at ${Math.round(s.coverage * 100)}% coverage`);
  doc.setProducer('Sam');

  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const oblq = await doc.embedFont(StandardFonts.HelveticaOblique);

  let page = doc.addPage(PAGE);
  let y = PAGE[1];

  const nextPage = () => { page = doc.addPage(PAGE); y = PAGE[1] - M; };
  const room = (n) => { if (y - n < M + 24) nextPage(); };

  const text = (str, { x = M, size = 10, font = reg, color = INK, dy = 0 } = {}) => {
    page.drawText(String(str), { x, y: y - dy, size, font, color });
  };

  const wrap = (str, size, font, maxWidth) => {
    const words = String(str).split(/\s+/);
    const lines = [];
    let line = '';
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(test, size) > maxWidth && line) { lines.push(line); line = w; }
      else line = test;
    }
    if (line) lines.push(line);
    return lines;
  };

  const para = (str, { size = 9.5, font = reg, color = SOFT, x = M, width = WIDTH, lead = 13 } = {}) => {
    for (const line of wrap(str, size, font, width)) {
      room(lead); page.drawText(line, { x, y, size, font, color }); y -= lead;
    }
  };

  const rule = (pad = 8) => { y -= pad; page.drawLine({ start: { x: M, y }, end: { x: M + WIDTH, y }, thickness: 0.6, color: RULE }); y -= pad + 2; };

  const heading = (label) => {
    room(30); y -= 12;
    text(label.toUpperCase(), { size: 7.5, font: bold, color: ACCENT });
    y -= 5; page.drawLine({ start: { x: M, y }, end: { x: M + WIDTH, y }, thickness: 1, color: BRAND }); y -= 13;
  };

  // ── header band ─────────────────────────────────────────────
  page.drawRectangle({ x: 0, y: PAGE[1] - 104, width: PAGE[0], height: 104, color: INK });
  page.drawRectangle({ x: 0, y: PAGE[1] - 108, width: PAGE[0], height: 4, color: BRAND });
  page.drawText(s.candidate.name, { x: M, y: PAGE[1] - 46, size: 21, font: bold, color: hex(INK_RAMP[0]) });
  page.drawText(`Matched to ${s.role.title} · ${s.role.company}`, { x: M, y: PAGE[1] - 64, size: 9.5, font: reg, color: hex(INK_RAMP[300]) });
  // A scheduled sweep scores one person at a time and has no cohort to rank them in.
  // "Top 100% of pool · 1 applicant" is worse than saying nothing.
  const standing = s.pool
    ? `Top ${s.pool.topPercent}% of pool · ${s.pool.size} applicants · scored from ${s.provenance}`
    : `Scored from ${s.provenance}`;
  page.drawText(standing, { x: M, y: PAGE[1] - 80, size: 8, font: reg, color: BRAND });

  // Below the coverage floor the number is withheld rather than shown with a caveat —
  // the headline is the one thing every reader takes away, caveat or not.
  const pctStr = s.scoreIsPublishable === false ? '—' : `${Math.round(s.roleFit * 100)}%`;
  const pw = bold.widthOfTextAtSize(pctStr, 30);
  page.drawText(pctStr, { x: PAGE[0] - M - pw, y: PAGE[1] - 50, size: 30, font: bold, color: hex(INK_RAMP[0]) });
  const lbl = 'ROLE FIT';
  page.drawText(lbl, { x: PAGE[0] - M - reg.widthOfTextAtSize(lbl, 7), y: PAGE[1] - 62, size: 7, font: reg, color: hex(INK_RAMP[300]) });
  const cov = `${Math.round(s.coverage * 100)}% COVERAGE`;
  page.drawText(cov, { x: PAGE[0] - M - reg.widthOfTextAtSize(cov, 7), y: PAGE[1] - 74, size: 7, font: bold, color: hex(STATE_COLOR.NOT_COLLECTED.bg) });
  const bandW = reg.widthOfTextAtSize(s.band, 8);
  page.drawText(s.band, { x: PAGE[0] - M - bandW, y: PAGE[1] - 88, size: 8, font: bold, color: BRAND });

  y = PAGE[1] - 128;

  // ── recommended next step ───────────────────────────────────
  text('RECOMMENDED NEXT STEP', { size: 7.5, font: bold, color: ACCENT }); y -= 13;
  para(s.recommendedNextStep, { size: 10, color: INK, lead: 14 });
  rule();

  // ── the design's three fit rows ─────────────────────────────
  // Each states a band and the evidence behind it, so a reviewer can argue with the band
  // rather than only with the number.
  const fitRow = (label, band, line) => {
    room(28);
    text(label, { size: 7.5, font: bold, color: ACCENT });
    const w = bold.widthOfTextAtSize(band, 8);
    page.drawText(band, { x: M + WIDTH - w, y, size: 8, font: bold, color: bandColor(band) });
    y -= 11;
    para(line, { size: 8.5, lead: 11 });
    y -= 3;
  };
  fitRow('EXPERIENCE MATCH', s.experienceMatch.band, s.experienceMatch.line);
  fitRow('RESPONSIBILITY MATCH', s.responsibilityMatch.band, s.responsibilityMatch.line);
  fitRow('ROLE LEVEL FIT', s.roleLevelFit.band, s.roleLevelFit.line);
  for (const sug of s.roleLevelFit.suggestions) para(`• ${sug}`, { size: 8, x: M + 10, lead: 10.5 });
  rule();

  // ── career history, from their own resume ───────────────────
  heading('Career history');
  if (s.careerHistory.roles.length) {
    para(`From ${s.careerHistory.source}`, { size: 7.5, font: oblq });
    y -= 2;
    for (const r of s.careerHistory.roles) {
      room(22);
      text(r.title, { size: 9.5, font: bold, color: INK });
      const span = [r.start, r.end].filter(Boolean).join(' – ') || '';
      if (span) page.drawText(span, { x: M + WIDTH - reg.widthOfTextAtSize(span, 8), y, size: 8, font: reg, color: SOFT });
      y -= 11;
      para(r.company, { size: 8.5, lead: 11 });
      y -= 2;
    }
  } else {
    para(s.careerHistory.note ?? 'No resume on file.', { size: 8.5, font: oblq });
    para('Left blank rather than reconstructed from the interview — the transcripts name '
      + 'employers inconsistently, and a garbled job title on someone’s record is worse than '
      + 'an absent one.', { size: 8, lead: 10.5 });
  }

  // ── scores ──────────────────────────────────────────────────
  rule();
  text(`CAPABILITY ${s.capability}/10`, { size: 9, font: bold, color: INK });
  text(`ANCHORS ${s.anchorSummary.met} MET · ${s.anchorSummary.observable} OF ${s.anchorSummary.total} OBSERVABLE`, { x: M + 150, size: 9, font: bold, color: INK });
  y -= 14;
  para(`How they work: ${s.capabilitySignals.met.join(' · ')}.`, { size: 8.5 });
  if (s.capabilitySignals.missing.length) para(`Not evidenced: ${s.capabilitySignals.missing.join(' · ')}.`, { size: 8.5, font: oblq });

  // ── role anchors ────────────────────────────────────────────
  heading('Role anchors');
  for (const a of s.roleAnchors) {
    const st = STATE_STYLE[a.state];
    room(30);
    page.drawRectangle({ x: M, y: y - 2, width: 3, height: 11, color: st.color });
    text(a.label, { x: M + 10, size: 9.5, font: bold, color: INK });
    const w = bold.widthOfTextAtSize(st.label, 7);
    page.drawText(st.label, { x: M + WIDTH - w, y, size: 7, font: bold, color: st.color });
    y -= 12;
    para(a.reason, { size: 8.5, x: M + 10, width: WIDTH - 20, lead: 11 });
    y -= 3;
  }

  // ── evidence ────────────────────────────────────────────────
  if (s.evidenceQuotes.length) {
    heading('Evidence');
    for (const q of s.evidenceQuotes) {
      room(34);
      text(`${q.anchor}  ·  column ${q.column}`, { size: 7.5, font: bold, color: SOFT }); y -= 11;
      para(`"${q.quote}"`, { size: 8.5, font: oblq, x: M + 8, width: WIDTH - 16, lead: 11 });
      y -= 4;
    }
  }

  // ── coverage gaps ───────────────────────────────────────────
  heading('Coverage gaps');
  for (const g of s.coverageGaps) {
    room(26);
    text(g.label, { size: 9, font: bold, color: INK });
    const w = reg.widthOfTextAtSize(g.status, 7.5);
    page.drawText(g.status, { x: M + WIDTH - w, y, size: 7.5, font: reg, color: UNCOLL });
    y -= 11;
    para(g.reason, { size: 8.5, lead: 11 });
    y -= 3;
  }

  // ── additional skills ───────────────────────────────────────
  if (s.additionalSkills?.length) {
    heading('Additional skills');
    para(s.additionalSkills.join('  ·  '), { size: 8.5, lead: 11.5 });
  }

  // ── net read ────────────────────────────────────────────────
  heading('Net read');
  para(s.netRead, { size: 9.5, color: INK, lead: 13 });

  if (s.caveats.length) {
    y -= 6;
    room(30); // keep the heading with its first caveat
    text('CAVEATS', { size: 7.5, font: bold, color: MISS }); y -= 12;
    for (const c of s.caveats) para(`• ${c}`, { size: 8.5, lead: 11 });
  }

  // ── gaps to investigate ─────────────────────────────────────
  heading('Gaps to investigate');
  for (const g of s.gapsToInvestigate) {
    room(24);
    text(`• ${g.label}`, { size: 9, font: bold, color: INK }); y -= 11;
    para(g.reason, { size: 8.5, x: M + 10, width: WIDTH - 20, lead: 11 });
    y -= 2;
  }

  // ── responses (replaces "View Resume") ──────────────────────
  if (s.audioUrls.length) {
    heading('Listen to responses');
    // The line has to follow the actual provenance. Claiming there is no resume while the
    // header says the score used one is the kind of contradiction a reviewer spots first.
    para(s.hasResume
      ? `${s.audioUrls.length} recorded answers, alongside the resume on file. The recordings carry how they work; the resume carries where they have worked.`
      : `${s.audioUrls.length} recorded answers. No resume on file for this candidate — these are the primary evidence.`,
    { size: 8.5 });
    for (const a of s.audioUrls) { room(11); para(`${a.id}  ${a.url}`, { size: 7, lead: 9.5 }); }

    if (s.candidate.resume) {
      y -= 4;
      para(`Resume  ${s.candidate.resume.name}`, { size: 7.5, lead: 10 });
      for (const d of s.candidate.attachments ?? []) para(`Also    ${d.name}`, { size: 7.5, lead: 10 });
    }
  }

  // ── footer on every page ────────────────────────────────────
  for (const p of doc.getPages()) {
    p.drawLine({ start: { x: M, y: 40 }, end: { x: M + WIDTH, y: 40 }, thickness: 0.6, color: RULE });
    p.drawText(`Powered by Sam for ${s.role.company}`, { x: M, y: 28, size: 7.5, font: reg, color: SOFT });
    const stamp = s.scoreIsPublishable === false
      ? `Not scored · only ${Math.round(s.coverage * 100)}% of the rubric was observable · evidence-bound`
      : `Role Fit ${Math.round(s.roleFit * 100)}% at ${Math.round(s.coverage * 100)}% coverage · evidence-bound`;
    p.drawText(stamp, { x: M + WIDTH - reg.widthOfTextAtSize(stamp, 7.5), y: 28, size: 7.5, font: reg, color: SOFT });
  }

  return Buffer.from(await doc.save());
}
