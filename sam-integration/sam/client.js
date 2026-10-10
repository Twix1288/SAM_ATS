/**
 * Sam's API. The other half of the integration.
 *
 * Three calls, verified live against https://app.launchsam.com:
 *
 *   POST /api/v1/jobs              once per job — returns Sam's job id AND the anchors it
 *                                  derived, so we can see what a candidate will be scored
 *                                  against before anyone goes through
 *   POST /api/v1/snapshots/batch   many applicants — returns a batch id immediately, because
 *                                  scoring takes minutes
 *   GET  /api/v1/snapshots/batch/{id}   status, if we would rather poll than wait
 *
 * Results arrive by CALLBACK, not polling. We send a `callback_url` and Sam POSTs there when
 * the batch finishes. Sam retries a failed callback, so **the same batch can land twice** —
 * see `sam/callback.js` for why that is safe here.
 *
 * AUTH IS A BEARER TOKEN, and it is a different credential from the Ashby key. Neither is
 * ever logged: an error from this client carries the status and Sam's own reason, never the
 * request headers.
 */
const BASE = process.env.SAM_API_BASE ?? 'https://app.launchsam.com';
const TOKEN = process.env.SAM_API_TOKEN;
const TIMEOUT_MS = Number(process.env.SAM_TIMEOUT_MS ?? 60_000);
const MAX_ATTEMPTS = 3;

export class SamApiError extends Error {
  constructor(path, status, reason) {
    super(`Sam ${path} failed (${status}): ${reason}`);
    this.name = 'SamApiError';
    this.status = status;
    this.path = path;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Sam answers a bad request with HTTP 400 and `{error, reason}` — a real, readable reason
 * naming the missing fields. That is worth surfacing verbatim rather than flattening into
 * "request failed": it is the difference between a fixable error and a mystery.
 */
async function call(path, { method = 'POST', body } = {}) {
  if (!TOKEN) throw new Error('SAM_API_TOKEN is not set. Sam cannot be reached without it.');

  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${TOKEN}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* keep the raw body for the error */ }

      if (res.ok) return json ?? {};

      const reason = json?.reason ?? json?.error ?? text.slice(0, 200);
      const error = new SamApiError(path, res.status, reason);
      // 4xx is a rejected request: the same payload is rejected identically every time.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) throw error;
      lastError = error;
    } catch (err) {
      if (err instanceof SamApiError && err.status >= 400 && err.status < 500 && err.status !== 429) throw err;
      lastError = err;
    }
    if (attempt < MAX_ATTEMPTS) await sleep(2 ** attempt * 250);
  }
  throw lastError;
}

/**
 * Registers a job and gets back the anchors Sam will score against.
 *
 * `anchor_set_changed` is the field worth watching. Re-registering after a posting is edited
 * tells us whether the REQUIREMENTS actually moved, which is a stronger signal than our own
 * description hash: an employer fixing a typo changes the hash and not the rubric, and
 * re-scoring a whole pipeline over a typo is expensive and confusing.
 *
 * @returns {Promise<{job_id: string, anchors: object[], anchor_set_changed: boolean}>}
 */
export function registerJob({ ashbyJobId, companyId, title, description }) {
  return call('/api/v1/jobs', {
    body: {
      source_system: 'ashby',
      source_company_id: companyId,
      source_job_id: ashbyJobId,
      title,
      job_description: description,
    },
  });
}

/**
 * Sends a whole sweep's worth of applicants at once.
 *
 * Returns a batch id immediately — scoring takes minutes, so nothing here waits for it. The
 * results arrive at `callbackUrl`.
 */
export function submitBatch({ samJobId, applicants, callbackUrl }) {
  return call('/api/v1/snapshots/batch', {
    body: {
      job_id: samJobId,
      applicants,
      ...(callbackUrl ? { callback_url: callbackUrl } : {}),
    },
  });
}

/** One applicant, same shape, when a batch would be overkill. */
export function submitOne({ samJobId, applicant, callbackUrl }) {
  return call('/api/v1/snapshots', {
    body: { job_id: samJobId, ...applicant, ...(callbackUrl ? { callback_url: callbackUrl } : {}) },
  });
}

/** The fallback when a callback never arrives. Polling is the exception, not the design. */
export function batchStatus(batchId) {
  return call(`/api/v1/snapshots/batch/${encodeURIComponent(batchId)}`, { method: 'GET' });
}

/**
 * Sam's own rendering of the Snapshot.
 *
 * Sam returns `assets.snapshot_pdf_url` alongside every scored payload, and it is a better
 * document than the one we draw from the same data: it carries the cohort rank in the
 * header, marks each requirement CORE or SUPPORTING, and gives met-by-equivalence its own
 * callout naming the assumption. Sam owns the design and is iterating on it; re-drawing it
 * from the JSON means our version drifts from theirs every time they improve it.
 *
 * So the division is: SAM RENDERS, WE PLACE. We fetch their PDF and bind the candidate's own
 * résumé in behind it, which is the one thing their renderer cannot do — it has never seen
 * the Ashby record.
 *
 * Falls back to our renderer rather than failing a delivery: a Snapshot drawn by us is worth
 * far more than no Snapshot at all, and the caller is told which one it got.
 */
export async function fetchSnapshotPdf(url, { fetchImpl = fetch, timeoutMs = 60_000 } = {}) {
  if (!url) return null;
  const res = await fetchImpl(url, {
    headers: { authorization: `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new SamApiError(url, res.status, 'could not fetch the Snapshot PDF');

  const bytes = Buffer.from(await res.arrayBuffer());

  // Asserted, not assumed. An auth redirect or an error page served with a 200 would
  // otherwise be attached to a candidate's record as though it were their Snapshot.
  if (bytes.subarray(0, 4).toString() !== '%PDF') {
    throw new SamApiError(url, res.status,
      `expected a PDF, got ${res.headers.get('content-type') ?? 'something else'} (${bytes.length} bytes)`);
  }
  return bytes;
}
