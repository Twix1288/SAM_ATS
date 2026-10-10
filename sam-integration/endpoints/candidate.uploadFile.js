/**
 * Ashby candidate.uploadFile — attaches the rendered Snapshot to the candidate.
 *
 * Deliberately NOT candidate.uploadResume. That endpoint writes the resume slot, and
 * sending a Snapshot through it risks displacing the candidate's real resume — the
 * single most damaging thing this integration could do. uploadFile puts our document
 * alongside theirs instead.
 */
import { ENDPOINTS, FILE_CONTEXT, UPLOAD_HANDLE_PARAMS as P } from '../../shared/ashby-contract.js';
import { post } from './client.js';
import { createHash } from 'node:crypto';

/**
 * Uploads the bytes to the presigned URL.
 *
 * Ashby returns { handle, url, fields } — an S3 presigned POST, not a PUT. The `fields`
 * carry the policy and signature and must be written into the form BEFORE the file part;
 * S3 ignores anything that follows the file, so a misordered body fails signature checks
 * for reasons that are painful to diagnose.
 */
async function uploadToPresignedUrl(handle, { filename, bytes, contentType = 'application/pdf' }) {
  if (!handle.url) return;                       // nothing to upload against
  const boundary = `----SamUpload${Date.now().toString(16)}`;
  const parts = [];

  // Every EXACT-MATCH condition in the policy must arrive as a FORM FIELD. Ashby's `fields`
  // does not include all of them — it omits `Content-Type`, which the policy nonetheless
  // conditions on — and S3 answers a missing condition with a bare 403 and no explanation.
  // Reading the conditions out of the policy is what makes this robust: a condition Ashby
  // adds later is satisfied automatically instead of breaking the upload again.
  const fields = { ...(handle.fields ?? {}) };
  for (const [name, value] of policyConditions(fields.Policy)) {
    if (!(name in fields)) fields[name] = value;
  }
  // Only the file part carries a content type S3 did not sign, so keep it consistent with
  // the field above rather than hardcoding a second, possibly different, value.
  if (!fields['Content-Type']) fields['Content-Type'] = contentType;

  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8'));
  }
  // The file part goes LAST: S3 ignores every field that follows it.
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n`
    + `Content-Type: ${fields['Content-Type']}\r\n\r\n`, 'utf8'));
  parts.push(bytes, Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));

  const res = await fetch(handle.url, {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat(parts),
  });
  if (!res.ok) {
    // S3 explains the refusal in the body, and that text is the difference between a
    // five-minute fix and an afternoon: it names the condition that failed.
    const detail = await res.text().catch(() => '');
    const reason = /<Message>([^<]+)<\/Message>/.exec(detail)?.[1] ?? detail.slice(0, 200);
    throw new Error(
      `Presigned upload failed (${res.status}) for ${filename}${reason ? `: ${reason}` : '.'}`);
  }
}

/**
 * The exact-match conditions inside a base64 S3 POST policy, as [name, value] pairs.
 *
 * The policy is the authority on what S3 will check. Range rules (`content-length-range`)
 * arrive as arrays and are not form fields, so they are skipped. Returns nothing at all if
 * the policy is absent or unparseable — the caller still sends what Ashby gave it, which is
 * exactly the behaviour before this existed.
 */
export function policyConditions(policyB64) {
  try {
    const policy = JSON.parse(Buffer.from(String(policyB64), 'base64').toString('utf8'));
    return (policy.conditions ?? [])
      .filter((c) => c && !Array.isArray(c) && typeof c === 'object')
      .flatMap((c) => Object.entries(c));
  } catch {
    return [];
  }
}

/** Builds multipart/form-data without pulling in a form-data dependency. */
function buildMultipart({ candidateId, filename, bytes }) {
  const boundary = `----SamSnapshot${Buffer.from(filename).toString('hex').slice(0, 12)}`;
  const head = Buffer.from(
    `--${boundary}\r\n`
    + `Content-Disposition: form-data; name="candidateId"\r\n\r\n${candidateId}\r\n`
    + `--${boundary}\r\n`
    + `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`
    + 'Content-Type: application/pdf\r\n\r\n',
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return { body: Buffer.concat([head, bytes, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

/**
 * Two-step upload: reserve a handle in the CandidateFiles context, then attach it.
 * Falls back to a direct multipart upload if handle creation is unavailable.
 */
/**
 * Asks Ashby whether this exact Snapshot is already on the candidate.
 *
 * `candidate.uploadFile` APPENDS. It does not upsert, and nothing in the response says a
 * file of the same name is already there — so a delivery that runs twice leaves two
 * identical PDFs in the Files list, and a third leaves three. Observed on a live record.
 *
 * The ledger normally prevents the second run from happening at all. This is the guard for
 * when it cannot: a lost or rolled-back ledger, a restart mid-delivery, a retry after a
 * response we never saw. The ledger is the plan; this is what stops the failure being
 * visible to a recruiter when the plan does not hold.
 *
 * AND THERE IS NO UNDO. Ashby publishes no endpoint that removes a file from a candidate —
 * `candidate.removeFile`, `file.delete`, `candidate.deleteFile` and `file.archive` all
 * return 404. A duplicate Snapshot can only be cleared by a human, by hand, in the product.
 * That is what makes this check load-bearing rather than defensive: every other failed write
 * in this system leaves the record as it was, and this one leaves litter nobody can sweep
 * up through the API.
 */
export async function snapshotAlreadyAttached(candidateId, filename) {
  const candidate = await post(ENDPOINTS.candidateInfo, { id: candidateId });
  const hit = (candidate?.fileHandles ?? []).find((f) => f.name === filename);
  return hit ? { filename, handle: hit.handle, deduplicated: true } : null;
}

/**
 * The filename a Snapshot is stored under: the person, plus a fingerprint of the document.
 *
 * MATCHING ON THE NAME ALONE WAS WRONG, and it failed in the direction that matters. The
 * dedupe guard exists to stop a re-run attaching a second copy of the SAME document. Keyed
 * on `sam_snapshot_<name>.pdf` it also blocked every IMPROVED document — a candidate
 * re-scored, or a Snapshot now rendered by Sam instead of by us, kept whatever was attached
 * first. Observed live: a record showing 90% in its fields with a stale one-page placeholder
 * attached, and the delivery reporting success both times.
 *
 * The fingerprint makes the name mean "this exact document". The same bytes dedupe; different
 * bytes are a different file and attach. Ashby cannot delete a file, so a genuinely re-graded
 * candidate ends up with both — which is the correct outcome, and visibly so, rather than
 * silently keeping the older one.
 */
export const snapshotFilename = (name, bytes) =>
  `sam_snapshot_${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`
  + `_${createHash('sha256').update(bytes).digest('hex').slice(0, 8)}.pdf`;

export async function uploadSnapshotFile({ candidateId, filename, bytes, deliveryId }) {
  // Before anything is uploaded, not only before a retry: the duplicate this prevents is
  // created by a SECOND RUN, and a second run's first attempt is exactly where it happens.
  const already = await snapshotAlreadyAttached(candidateId, filename).catch(() => null);
  if (already) return { filename, bytes: bytes.length, via: 'already-attached', results: already };

  try {
    // The presigned signature is cryptographically bound to the declared contentType
    // and contentLength, so these must describe the bytes exactly or S3 rejects the
    // upload rather than storing something that does not match.
    const handle = await post(ENDPOINTS.createFileUploadHandle, {
      [P.context]: FILE_CONTEXT.candidateFiles,
      [P.name]: filename,
      [P.type]: 'application/pdf',
      [P.length]: bytes.length,
    }, { idempotencyKey: `${deliveryId}:handle` });

    if (handle?.handle && handle?.url) {
      // Ship the bytes to the presigned URL, then attach the handle to the candidate.
      await uploadToPresignedUrl(handle, { filename, bytes, contentType: 'application/pdf' });

      const results = await post(ENDPOINTS.uploadFile, {
        candidateId,
        fileHandle: handle.handle,
      }, { idempotencyKey: `${deliveryId}:snapshot` });
      return { filename, bytes: bytes.length, via: 'fileHandle', results };
    }
  } catch (err) {
    // The handle flow is the one Ashby documents, so falling back to a direct multipart
    // upload is a degradation worth hearing about — a silent fallback here would hide a
    // broken presigned flow behind a demo that still appears to work.
    if (err?.status && err.status >= 500) throw err;
    console.warn(`[Sam] presigned upload unavailable, falling back to multipart: ${err.message}`);
  }

  const { body, contentType } = buildMultipart({ candidateId, filename, bytes });
  const results = await post(ENDPOINTS.uploadFile, null, {
    raw: body,
    headers: { 'content-type': contentType },
    idempotencyKey: `${deliveryId}:snapshot`,
  });
  return { filename, bytes: bytes.length, via: 'multipart', results };
}
