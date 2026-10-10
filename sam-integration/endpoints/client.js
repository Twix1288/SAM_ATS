/**
 * Ashby HTTP client.
 *
 * Basic auth (API key as username, empty password), JSON envelopes, and retry
 * with exponential backoff on 5xx and network faults. 4xx is never retried —
 * a rejected payload will be rejected identically on every attempt.
 */
import { ASHBY_BASE_URL, authHeader } from '../../shared/ashby-contract.js';

/**
 * Read at CALL time, not module load.
 *
 * As frozen consts these were unreachable to anything that set the environment after import
 * — which is every test, and any entry point that loads config before deciding a target. It
 * also made the live-write guard below untestable in process, so the one check standing
 * between a stray command and a customer's ATS had no coverage at all.
 */
const baseUrl = () => process.env.ASHBY_API_URL ?? ASHBY_BASE_URL;
// ASHBY_KEY is what the .env file uses, ASHBY_API_KEY is what everything here reads.
// Accepting both beats keeping a second copy of a live credential in the same file.
const apiKey = () => process.env.ASHBY_API_KEY ?? process.env.ASHBY_KEY ?? 'demo_ashby_key';
const MAX_ATTEMPTS = 3;
/** One hung socket must not stall an unattended run. Covers connect and response. */
const TIMEOUT_MS = Number(process.env.ASHBY_TIMEOUT_MS ?? 30_000);
/** A large Retry-After must not park the run until the next tick would have run anyway. */
const MAX_BACKOFF_MS = 30_000;

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
export async function post(endpoint, body, opts = {}) {
  const { envelope = false } = opts;
  const payload = await request(endpoint, body, opts);
  return envelope ? payload : payload.results;
}

/**
 * The full response envelope, not just `results`.
 *
 * Pagination lives BESIDE the results — `{success, results, moreDataAvailable, nextCursor}`
 * — so any caller that needs to page has to see the envelope. `post()` unwrapping to
 * `results` is what made `sweepJob` read `.results` off an array and get zero rows on every
 * call, and it is also why nothing could follow a cursor even if it wanted to.
 */
export const postPage = (endpoint, body, opts = {}) => request(endpoint, body, opts);

/**
 * Reads every page of a list endpoint, following Ashby's own pagination.
 *
 * `cap` is a runaway guard, not a limit anyone should hit: at 100 rows a page it allows
 * 50,000 applications. Hitting it means something is looping, and the caller is told rather
 * than silently handed a truncated pipeline.
 */
export async function postAll(endpoint, body = {}, { cap = 500, ...opts } = {}) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < cap; page++) {
    const env = await request(endpoint, { ...body, ...(cursor ? { cursor } : {}) }, opts);
    out.push(...(env.results ?? []));
    if (!env.moreDataAvailable || !env.nextCursor) return out;
    cursor = env.nextCursor;
  }
  throw new Error(
    `${endpoint} did not stop paginating after ${cap} pages (${out.length} rows). `
    + 'Refusing to continue rather than return a partial list as though it were complete.');
}

async function request(endpoint, body, { idempotencyKey, headers = {}, raw, verify, timeoutMs = TIMEOUT_MS } = {}) {
  let lastError;

  // Refuse production by accident. BASE defaults to api.ashbyhq.com and only one npm script
  // overrides it, so any stray `node …` with a real key in the shell would write to a
  // customer's ATS. Checked here rather than at module load: the test suite imports every
  // module, and a load-time throw would fail that on a machine with a key exported.
  const BASE = baseUrl();
  if (BASE === ASHBY_BASE_URL && !process.env.ASHBY_LIVE) {
    throw new Error(
      `Refusing to ${endpoint} against ${ASHBY_BASE_URL}. Set ASHBY_API_URL to the simulator, `
      + 'or ASHBY_LIVE=1 to mean it.');
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Only before a REPEAT. The case this guards is a first POST that timed out after Ashby
    // committed it — and that case reaches attempt 2, where the check runs.
    //
    // Running it on attempt 1 as well would buy one thing: catching a note posted by an
    // EARLIER RUN. That is the ledger's job, and paying an extra listNotes call on every
    // delivery to duplicate it is a poor trade — the ledger's per-surface record knows the
    // note landed without asking Ashby at all.
    if (attempt > 1 && verify) {
      try {
        const already = await verify();
        if (already) return already;
      } catch {
        // A failed check is not a reason to skip the attempt, only to lose the protection.
      }
    }
    try {
      const res = await fetch(`${BASE}${endpoint}`, {
        method: 'POST',
        headers: {
          authorization: authHeader(apiKey()),
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
          ...(raw ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        body: raw ?? JSON.stringify(body),
        // Without this a hung socket stalls the whole run: no output, no partial result,
        // no timeout of its own. AbortSignal.timeout covers connect AND response.
        signal: AbortSignal.timeout(timeoutMs),
      });

      const payload = await res.json().catch(() => ({
        success: false,
        errors: [`Non-JSON response (HTTP ${res.status}).`],
      }));

      if (payload.success) return payload;

      const error = new AshbyError(endpoint, res.status, messagesOf(payload.errors));
      // Decide ONCE, here, where the payload is in hand. The catch below cannot re-derive
      // this: a validation failure arrives as HTTP 200, and without the payload that looks
      // like a success status and gets retried — the exact bug this taxonomy exists to fix.
      error.retryable = isRetryable(res.status, payload);
      if (!error.retryable) throw error;
      lastError = error;
      if (attempt < MAX_ATTEMPTS) await sleep(backoffMs(attempt, res.headers.get('retry-after')));
      continue;
    } catch (err) {
      // A timeout is a transient fault, not a rejected payload — it must retry.
      if (err instanceof AshbyError) {
        if (err.retryable === false) throw err;
        lastError = err;
      } else {
        lastError = err;
      }
      if (attempt < MAX_ATTEMPTS) await sleep(backoffMs(attempt, null));
    }
  }
  throw lastError;
}

/**
 * Ashby's errors are an array of BARE STRINGS — `["invalid_input"]` — not objects carrying a
 * `message`. The old code mapped `e.message` over them, so every error this integration has
 * ever reported read "Ashby /endpoint failed (200): undefined". Both shapes are accepted
 * because the simulator echoes the documented object form.
 */
const messagesOf = (errors) => (errors ?? ['Unknown error.'])
  .map((e) => (typeof e === 'string' ? e : e?.message ?? JSON.stringify(e)));

/**
 * Whether another attempt could possibly succeed.
 *
 * Ashby answers VALIDATION errors with HTTP 200 and `success:false`, so a status-code check
 * is blind to them: a malformed request used to be retried three times with backoff before
 * failing, and a 429 — a 4xx — was never retried at all. Exactly backwards.
 */
function isRetryable(status, payload) {
  if (status === 429 || status === 408) return true;         // throttled or timed out: wait
  if (status === 200 && payload && payload.success === false) return false; // deterministic
  if (status >= 400 && status < 500) return false;           // rejected payload or bad auth
  return true;                                               // 5xx and network faults
}

/** Honour Retry-After when Ashby sends one, but never park a run on it. */
function backoffMs(attempt, retryAfter) {
  const header = Number(retryAfter) * 1000;
  const chosen = Number.isFinite(header) && header > 0 ? header : 2 ** attempt * 100;
  return Math.min(chosen, MAX_BACKOFF_MS);
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
