/**
 * HALF 2 — the Sam integration.
 *
 * Receives Ashby's applicationSubmit webhook, scores the candidate against the
 * compiled JD rubric, renders the Snapshot, and writes back to Ashby.
 *
 * Uses node:http rather than a framework so the raw request body stays intact:
 * HMAC verification must run on the exact bytes Ashby signed.
 */
import http from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPool, findByRow } from '../shared/seed/survey.js';
import { scorePool, poolReportCsv } from './services/calibrate.js';
import { ROLE } from './services/rubric.js';
import { rubricForJob, UnknownJobError, registeredJobs } from './services/rubrics.js';
import { buildSnapshot } from './render/model.js';
import { renderSnapshotPdf } from './render/snapshot.js';
import { renderDossier } from './render/dossier.js';
import { verifySignature, parseEnvelope, createDeliveryLog } from './webhooks/applicationSubmit.js';
import { deliverSnapshot, STAGES, OUTCOME } from './delivery/pipeline.js';
import { reconcileMerge, MERGE_OUTCOME } from './delivery/merge.js';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SURVEY = join(HERE, '..', 'data', 'survey_agree.com_business_development_representative.xlsx');
const PORT = Number(process.env.SAM_PORT ?? 3000);
const SECRET = process.env.ASHBY_WEBHOOK_SECRET ?? 'demo_webhook_secret';
const DOSSIER_BASE = process.env.SAM_DOSSIER_BASE ?? `http://localhost:${PORT}/dossier`;

const c = { sam: '\x1b[32m', warn: '\x1b[33m', bad: '\x1b[31m', dim: '\x1b[90m', off: '\x1b[0m', b: '\x1b[1m' };
const log = (m, x = '') => console.log(`${c.sam}[Sam]${c.off} ${m}${x ? ` ${c.dim}${x}${c.off}` : ''}`);
const warn = (m, x = '') => console.log(`${c.warn}[Sam]${c.off} ${m}${x ? ` ${c.dim}${x}${c.off}` : ''}`);
const bad = (m, x = '') => console.log(`${c.bad}[Sam]${c.off} ${m}${x ? ` ${c.dim}${x}${c.off}` : ''}`);

// ── Pool is scored once at boot. A candidate can never be scored in isolation. ──
log(`compiling rubric from "${ROLE.title}"`, ROLE.source);
const pool = loadPool(SURVEY);
const scored = scorePool(pool);
const byRow = new Map(scored.map((s) => [s.response.rowNumber, s]));
log(`pool calibrated`, `${scored.length} responses scored · ${scored[0].score.anchors.length} anchors`);
for (const j of registeredJobs()) log(`rubric registered`, `${j.jobTitle} · job ${j.jobId.slice(0, 8)} · ${j.anchorCount} anchors`);

const notCollected = scored[0].score.anchors.filter((a) => a.state === 'NOT_COLLECTED');
for (const a of notCollected) warn(`anchor ${a.id} (${a.label}) NOT COLLECTED`, a.reason);

writeFileSync(join(HERE, '..', 'ashby-simulator', 'output', 'pool_report.csv'), poolReportCsv(scored));

const deliveries = createDeliveryLog();
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

const readRaw = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', (ch) => {
    size += ch.length;
    if (size > 2 * 1024 * 1024) { reject(new Error('Webhook body exceeds the 2MB limit.')); req.destroy(); return; }
    chunks.push(ch);
  });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

const send = (res, status, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
};

async function processApplication({ webhookActionId, data }) {
  const { application } = data;
  const entry = byRow.get(data.surveyRow);
  if (!entry) throw new Error(`No survey response for row ${data.surveyRow}.`);

  // Which role is this application for? The webhook says, so Sam never has to assume.
  // An unregistered job is refused outright — a score against the wrong job's rubric
  // looks exactly like a real one.
  const rubric = rubricForJob(application.job);
  log(`job matched`, `${rubric.jobTitle} · ${rubric.anchors.length} anchors · rubric from ${rubric.source}`);

  /**
   * Sam ships two surfaces, and the workflow that puts them there is ordered: the
   * attachment lands first so the note can name it. Progress is streamed to the
   * terminal stage by stage, because Friday is a walkthrough, not a report.
   */
  const width = Math.max(...STAGES.map((x) => x.label.length));

  const result = await deliverSnapshot({
    response: entry.response,
    score: entry.score,
    candidateId: application.candidate.id,
    applicationId: application.id,
    deliveryId: webhookActionId,
    dossierBase: DOSSIER_BASE,
    rubric,
    onStage: (step) => {
      const n = String(STAGES.findIndex((x) => x.id === step.id) + 1).padStart(2, '0');
      const mark = step.ok ? `${c.b}✓${c.off}` : `${c.bad ?? ''}✕${c.off}`;
      const line = `  ${n} ${mark} ${step.label.padEnd(width)}`;
      (step.ok ? log : bad)(line, step.detail);
      if (step.produces) console.log(`        ${c.dim}└─ ${step.produces}${c.off}`);
    },
  });

  const banner = result.outcome === OUTCOME.complete ? log
    : result.outcome === OUTCOME.partial ? warn : bad;
  banner(`delivery ${result.outcome}`,
    `${result.delivered.filter((d) => d.ok).length} of ${result.delivered.length} deliverables on the record`);
  log('walk the versions', `http://localhost:${PORT}/canvas/${slug(entry.response.name)}`);

  return {
    received: true,
    outcome: result.outcome,
    complete: result.complete,
    candidate: result.candidate,
    roleFit: result.roleFit,
    coverage: result.coverage,
    capability: result.capability,
    delivered: result.delivered.map(({ id, name, endpoint, ok, detail }) => ({ id, name, endpoint, ok, detail })),
    filename: result.filename,
    canvas: `/canvas/${slug(entry.response.name)}`,
    dossier: `/dossier/${slug(entry.response.name)}`,
  };
}

const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, `http://localhost:${PORT}`).pathname;

  // The deep link Sam writes into the Ashby note resolves here. This is the hosted
  // page placement — the only version that keeps the audio and stays live.
  if (req.method === 'GET' && path.startsWith('/dossier/')) {
    const wanted = decodeURIComponent(path.slice('/dossier/'.length));
    const entry = scored.find((e) => slug(e.response.name) === wanted);
    if (!entry) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(`No dossier for "${wanted}".`);
    }
    const html = renderDossier(buildSnapshot(entry.score, entry.response));
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(html),
      'cache-control': 'no-store',
    });
    return res.end(html);
  }

  // The interactive Ashby record used to be served here. It now lives on the Ashby side
  // at http://localhost:3001, reading Ashby's own store through Ashby's own read
  // endpoints — so it can only ever show values a real write call actually landed.
  if (req.method === 'GET' && (path === '/ashby' || path === '/ashby/')) {
    res.writeHead(302, { location: process.env.ASHBY_UI_URL ?? 'http://localhost:3001/' });
    return res.end();
  }

  // The walkthrough surface: every version of the Snapshot on one page, built live.
  if (req.method === 'GET' && path.startsWith('/canvas/')) {
    const wanted = decodeURIComponent(path.slice('/canvas/'.length));
    const target = scored.find((e) => slug(e.response.name) === wanted);
    if (!target) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(`No candidate "${wanted}".`);
    }
    try {
      const out = join(HERE, '..', 'ashby-simulator', 'output', `canvas_${wanted}.html`);
      execFileSync(process.execPath, ['scripts/build-canvas.js', out, String(target.response.rowNumber)], {
        cwd: join(HERE, '..'), stdio: 'pipe',
      });
      // The canvas is authored as a fragment so it can also be published as an
      // artifact; serving it standalone just means wrapping it in a document.
      const fragment = readFileSync(out, 'utf8');
      const headEnd = fragment.indexOf('</style>') + '</style>'.length;
      const head = fragment.slice(0, headEnd);
      const body = fragment.slice(headEnd);
      const page = [
        '<!doctype html><html lang="en"><head><meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width,initial-scale=1">',
        head,
        '</head><body>',
        body,
        '</body></html>',
      ].join('');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(page);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(`Canvas build failed: ${err.message}`);
    }
  }

  // The pool leaderboard, scored once at boot.
  if (req.method === 'GET' && path === '/pool.csv') {
    const csv = poolReportCsv(scored);
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-length': Buffer.byteLength(csv) });
    return res.end(csv);
  }

  if (req.method === 'GET' && path === '/health') {
    return send(res, 200, { status: 'ok', pool: scored.length, role: ROLE.title, deliveries: deliveries.size() });
  }
  if (req.method !== 'POST' || path !== '/webhooks/applicationSubmit') {
    return send(res, 404, { error: `No handler for ${req.method} ${path}.` });
  }

  let raw;
  try { raw = await readRaw(req); }
  catch (err) { return send(res, 413, { error: err.message }); }

  // 1. Signature over the raw bytes, before any parsing.
  if (!verifySignature(raw, req.headers['ashby-signature'], SECRET)) {
    bad('signature verification FAILED', 'payload rejected');
    return send(res, 401, { error: 'Invalid webhook signature.' });
  }

  // 2. Envelope validation.
  let envelope;
  try { envelope = parseEnvelope(raw); }
  catch (err) { bad('envelope rejected', err.message); return send(res, 400, { error: err.message }); }

  console.log();
  log(`${envelope.action} received`, `signature verified · delivery ${envelope.webhookActionId.slice(0, 8)}`);

  // 3. Idempotency — webhookActionId persists across Ashby retries.
  if (deliveries.isDuplicate(envelope.webhookActionId)) {
    warn('duplicate delivery — acknowledged, not reprocessed', envelope.webhookActionId.slice(0, 8));
    return send(res, 200, { received: true, duplicate: true, ...deliveries.get(envelope.webhookActionId) });
  }

  // A merge retires one candidateId. Re-sync before anything downstream reads a record
  // whose scores have quietly vanished.
  if (envelope.merge) {
    try {
      const r = await reconcileMerge({
        sourceCandidateId: envelope.merge.source,
        destinationCandidateId: envelope.merge.destination,
        applicationId: envelope.merge.applicationId,
        deliveryId: envelope.webhookActionId,
        onStep: (st) => (st.ok ? log : bad)(`  ${st.ok ? '✓' : '✕'} ${st.label}`, st.detail),
      });
      (r.outcome === MERGE_OUTCOME.resynced ? log : warn)(`candidateMerge ${r.outcome}`, '');
      return send(res, 200, { received: true, action: 'candidateMerge', ...r });
    } catch (err) {
      bad('merge reconciliation failed', err.message);
      return send(res, 500, { error: err.message });
    }
  }

  // 4. Acknowledge fast, then process.
  try {
    const result = await processApplication(envelope);
    deliveries.remember(envelope.webhookActionId, result);
    return send(res, 200, result);
  } catch (err) {
    if (err instanceof UnknownJobError) {
      warn('declined to score', err.message);
      return send(res, 422, {
        received: true,
        scored: false,
        reason: 'no_rubric_for_job',
        jobId: err.jobId,
        jobTitle: err.jobTitle,
        registeredJobs: registeredJobs(),
        message: err.message,
      });
    }
    bad('processing failed', err.message);
    return send(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  log(`listening on :${PORT}`, `POST /webhooks/applicationSubmit`);
  log(`open Ashby`, `http://localhost:${PORT}/ashby`);
  log(`also`, `GET /canvas/:candidate · GET /dossier/:candidate · GET /pool.csv`);
  log(`Ashby target ${process.env.ASHBY_API_URL ?? 'https://api.ashbyhq.com'}`);
});

process.on('SIGINT', () => { console.log(`\n[Sam] processed ${deliveries.size()} deliveries.`); server.close(() => process.exit(0)); });
