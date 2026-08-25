/**
 * Ashby applicationSubmit webhook.
 *
 * The event name is `applicationSubmit` — the original plan used
 * `application.created`, which is not an Ashby event.
 *
 * Signature verification runs against the RAW request body. Parsing the JSON
 * first and re-serialising it produces a different byte sequence and the HMAC
 * will never match, so this handler is deliberately given the raw Buffer.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { SIGNATURE_PREFIX, WEBHOOK_ACTION_APPLICATION_SUBMIT, WEBHOOK_ACTION_CANDIDATE_MERGE } from '../../shared/ashby-contract.js';

/** Constant-time comparison of `sha256=<hex>` against an HMAC of the raw body. */
export function verifySignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader) return false;
  const expected = SIGNATURE_PREFIX + createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Validates the webhook envelope: { webhookActionId, action, data }. */
export function parseEnvelope(rawBody) {
  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new Error('Request body is not valid JSON.');
  }
  const { webhookActionId, action, data } = payload;
  if (!webhookActionId) throw new Error('Missing webhookActionId.');
  if (action === WEBHOOK_ACTION_CANDIDATE_MERGE) {
    // Routed, not rejected: everything Sam wrote is keyed on the retired candidateId, so
    // a merge needs an idempotent re-sync onto the surviving record.
    const source = data?.sourceCandidateId ?? data?.candidate?.sourceId;
    const destination = data?.destinationCandidateId ?? data?.candidate?.id;
    if (!source || !destination) {
      throw new Error('candidateMerge is missing sourceCandidateId or destinationCandidateId.');
    }
    return {
      webhookActionId, action, data, merge: { source, destination, applicationId: data?.application?.id },
    };
  }
  if (action !== WEBHOOK_ACTION_APPLICATION_SUBMIT) {
    throw new Error(`Unsupported action "${action}". This endpoint handles ${WEBHOOK_ACTION_APPLICATION_SUBMIT}.`);
  }
  if (!data?.application?.id) throw new Error('Missing data.application.id.');
  if (!data?.application?.candidate?.id) throw new Error('Missing data.application.candidate.id.');
  return { webhookActionId, action, data };
}

/**
 * Idempotency. `webhookActionId` persists across Ashby's retries, so a redelivery
 * is acknowledged but never reprocessed.
 */
export function createDeliveryLog() {
  const seen = new Map();
  return {
    isDuplicate: (id) => seen.has(id),
    remember: (id, result) => seen.set(id, result),
    get: (id) => seen.get(id),
    size: () => seen.size,
  };
}
