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

/**
 * Uploads the bytes to the presigned URL.
 *
 * Ashby returns { handle, url, fields } — an S3 presigned POST, not a PUT. The `fields`
 * carry the policy and signature and must be written into the form BEFORE the file part;
 * S3 ignores anything that follows the file, so a misordered body fails signature checks
 * for reasons that are painful to diagnose.
 */
async function uploadToPresignedUrl(handle, { filename, bytes }) {
  if (!handle.url) return;                       // nothing to upload against
  const boundary = `----SamUpload${Date.now().toString(16)}`;
  const parts = [];
  for (const [k, v] of Object.entries(handle.fields ?? {})) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8'));
  }
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n`
    + 'Content-Type: application/pdf\r\n\r\n', 'utf8'));
  parts.push(bytes, Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));

  const res = await fetch(handle.url, {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat(parts),
  });
  if (!res.ok) {
    throw new Error(`Presigned upload failed (${res.status}) POST ${handle.url} for ${filename}.`);
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
export async function uploadSnapshotFile({ candidateId, filename, bytes, deliveryId }) {
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
      await uploadToPresignedUrl(handle, { filename, bytes });

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
