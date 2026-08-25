/**
 * Fires an applicationSubmit webhook at the Sam integration, exactly as Ashby would:
 * the { webhookActionId, action, data } envelope, HMAC-SHA256 signed over the raw body.
 *
 *   node ashby-simulator/trigger_application.js --row 6
 */
import { createHmac, randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPool, findByRow } from '../shared/seed/survey.js';
import { SIGNATURE_PREFIX, WEBHOOK_ACTION_APPLICATION_SUBMIT } from '../shared/ashby-contract.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SURVEY = join(HERE, '..', 'data', 'survey_agree.com_business_development_representative.xlsx');
const SAM_URL = process.env.SAM_URL ?? 'http://localhost:3000/webhooks/applicationSubmit';
const SECRET = process.env.ASHBY_WEBHOOK_SECRET ?? 'demo_webhook_secret';

const log = (m, x = '') => console.log(`\x1b[35m[Trigger]\x1b[0m ${m}${x ? ` \x1b[90m${x}\x1b[0m` : ''}`);

const argOf = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

/** Deterministic UUIDs so re-running the demo targets the same Ashby objects. */
const stableId = (seed) => {
  const h = createHmac('sha256', 'ashby-demo').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

async function main() {
  const row = Number(argOf('--row', '6'));
  // `--job other` fires an application for a job with no registered rubric, so the
  // refuse-to-score path can be shown live rather than described.
  const jobKey = argOf('--job', 'sales-ae');
  const JOBS = {
    'sales-ae': { id: stableId('job:sales-ae'), title: 'Sales Account Executive' },
    other: { id: stableId('job:platform-engineer'), title: 'Platform Engineer' },
  };
  const job = JOBS[jobKey] ?? JOBS['sales-ae'];
  const replay = process.argv.includes('--replay');

  const pool = loadPool(SURVEY);
  const candidate = findByRow(pool, row);
  if (!candidate) {
    console.error(`No candidate at row ${row}. Rows run 2 through ${Math.max(...pool.map((p) => p.rowNumber))}.`);
    process.exit(1);
  }

  // `--merge --row A --into B` retires A's candidate into B's, the way a coordinator
  // deduplicating two profiles would.
  const intoRow = Number(argOf('--into', '0'));
  if (process.argv.includes('--merge')) {
    if (!intoRow) { console.error('--merge needs --into <row>'); process.exit(1); }
    const survivor = findByRow(pool, intoRow);
    if (!survivor) { console.error(`No candidate at row ${intoRow}.`); process.exit(1); }

    const mergePayload = {
      webhookActionId: randomUUID(),
      action: 'candidateMerge',
      data: {
        sourceCandidateId: stableId(`candidate:${candidate.responseHash}`),
        destinationCandidateId: stableId(`candidate:${survivor.responseHash}`),
        application: { id: stableId(`application:${survivor.responseHash}`) },
      },
    };
    const mergeRaw = Buffer.from(JSON.stringify(mergePayload), 'utf8');
    const mergeSig = SIGNATURE_PREFIX + createHmac('sha256', SECRET).update(mergeRaw).digest('hex');
    log(`POST candidateMerge`, `${candidate.name} → ${survivor.name}`);
    const mr = await fetch(SAM_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'ashby-signature': mergeSig, 'user-agent': 'Ashby-Webhook' },
      body: mergeRaw,
    });
    const mb = await mr.json().catch(() => ({}));
    // Printed whole, not truncated: this line is parsed by the preflight check, and a
    // clipped JSON object is indistinguishable from a failed request.
    log(`← HTTP ${mr.status}`, JSON.stringify(mb));
    return;
  }

  const payload = {
    webhookActionId: replay ? 'replay-fixed-delivery-id' : randomUUID(),
    action: WEBHOOK_ACTION_APPLICATION_SUBMIT,
    data: {
      application: {
        id: stableId(`application:${candidate.responseHash}`),
        status: 'Active',
        createdAt: '2026-08-21T19:48:47.000Z',
        candidate: {
          id: stableId(`candidate:${candidate.responseHash}`),
          name: candidate.name,
          primaryEmailAddress: { value: candidate.email, type: 'Personal' },
          ...(candidate.linkedin ? { socialLinks: [{ type: 'LinkedIn', url: candidate.linkedin }] } : {}),
          location: candidate.location ? { locationSummary: candidate.location } : null,
          resumeFileHandle: candidate.resumeUrl ? { url: candidate.resumeUrl } : null,
        },
        job,
      },
      // Survey row reference — Sam re-reads the response from the source of record.
      surveyRow: candidate.rowNumber,
    },
  };

  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = SIGNATURE_PREFIX + createHmac('sha256', SECRET).update(raw).digest('hex');

  log(`POST ${SAM_URL}`, `${candidate.name} · row ${row} · ${job.title}${replay ? ' · REPLAY' : ''}`);
  log(`delivery ${payload.webhookActionId}`, `signed ${signature.slice(0, 24)}…`);

  const started = Date.now();
  const res = await fetch(SAM_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'ashby-signature': signature,
      // Ashby stamps this on outbound webhooks. Useful for routing and logging, and
      // never for authentication — a user agent is trivially spoofed.
      'user-agent': 'Ashby-Webhook',
    },
    body: raw,
  });
  const body = await res.json().catch(() => ({}));
  log(`← HTTP ${res.status} in ${Date.now() - started}ms`, JSON.stringify(body));
  if (!res.ok) process.exitCode = 1;
}

main().catch((err) => { console.error('[Trigger] failed:', err.message); process.exit(1); });
