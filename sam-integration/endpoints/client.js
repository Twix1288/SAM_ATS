/**
 * Ashby HTTP client.
 *
 * Basic auth (API key as username, empty password), JSON envelopes, and retry
 * with exponential backoff on 5xx and network faults. 4xx is never retried —
 * a rejected payload will be rejected identically on every attempt.
 */
import { ASHBY_BASE_URL, authHeader } from '../../shared/ashby-contract.js';

const BASE = process.env.ASHBY_API_URL ?? ASHBY_BASE_URL;
const API_KEY = process.env.ASHBY_API_KEY ?? 'demo_ashby_key';
const MAX_ATTEMPTS = 3;

export class AshbyError extends Error {
  constructor(endpoint, status, messages) {
    super(`Ashby ${endpoint} failed (${status}): ${messages.join('; ')}`);
    this.name = 'AshbyError';
    this.endpoint = endpoint;
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * POSTs to an Ashby endpoint and unwraps the { success, results } envelope.
 *
 * `idempotencyKey` is sent as a header, but Ashby does not document honouring it, so it
 * is a hope rather than a guarantee — the real protection is `verify`.
 *
 * NOT EVERY WRITE IS SAFE TO REPEAT. `customField.setValues` overwrites the same values
 * and `candidate.uploadFile` replaces the same file, so a blind retry is harmless there.
 * `candidate.createNote` appends: if the first POST timed out AFTER Ashby created the
 * note but before we saw the 200, retrying drops a second copy of a large HTML table
 * into the hiring manager's feed.
 *
 * So a caller that appends passes `verify` — a function that asks Ashby whether the write
 * already landed. It runs before every retry, and a truthy result is returned instead of
 * repeating the write.
 *
 * @param {object}   [opts]
 * @param {Function} [opts.verify]  async () => existing result, or null if it did not land
 */
export async function post(endpoint, body, { idempotencyKey, headers = {}, raw, verify } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1 && verify) {
      try {
        const already = await verify();
        if (already) return already;
      } catch {
        // A failed check is not a reason to skip the retry, only to lose the protection.
      }
    }
    try {
      const res = await fetch(`${BASE}${endpoint}`, {
        method: 'POST',
        headers: {
          authorization: authHeader(API_KEY),
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
          ...(raw ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        body: raw ?? JSON.stringify(body),
      });

      const payload = await res.json().catch(() => ({ success: false, errors: [{ message: `Non-JSON response (HTTP ${res.status}).` }] }));

      if (payload.success) return payload.results;

      const messages = (payload.errors ?? [{ message: 'Unknown error.' }]).map((e) => e.message);
      const error = new AshbyError(endpoint, res.status, messages);
      if (res.status >= 400 && res.status < 500) throw error; // client error: do not retry
      lastError = error;
    } catch (err) {
      if (err instanceof AshbyError && err.status < 500) throw err;
      lastError = err;
    }

    if (attempt < MAX_ATTEMPTS) await sleep(2 ** attempt * 100);
  }
  throw lastError;
}

/** Resolves custom-field titles to the UUIDs customField.setValue requires. */
export async function resolveCustomFieldIds(titles) {
  const fields = await post('/customField.list', {});
  const byTitle = new Map(fields.map((f) => [f.title, f.id]));
  const missing = titles.filter((t) => !byTitle.has(t));
  if (missing.length) {
    throw new Error(`Ashby is missing custom fields: ${missing.join(', ')}. Create them before running the integration.`);
  }
  return byTitle;
}
