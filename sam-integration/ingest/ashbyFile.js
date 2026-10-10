/**
 * Fetching a candidate's own documents out of Ashby.
 *
 * Nothing in this repo did this before. Every résumé it has ever read came from a local
 * cache seeded from a spreadsheet, which is fine for a walkthrough and is not an input a
 * production run has. Against a real org the résumé is the ONLY substantial evidence the
 * engine gets — `candidate.info` returns identity and file handles and no parsed work
 * history at all — so this is the production input path.
 *
 * THE PARAMETER NAME IS `fileHandle`, AND IT IS THE OPAQUE BLOB.
 *
 * Verified against a live org. `candidate.info` returns
 * `resumeFileHandle: {id, name, handle}`, and `file.info` wants the `handle` — a long base64
 * string — NOT the `id`, and not `fileHandleId`:
 *
 *   {fileHandleId: <id>}  → success:false  ["invalid_input"]
 *   {id: <id>}            → success:false  ["invalid_input"]
 *   {fileHandle: <handle>}→ success:true   {url}
 *
 * Both wrong spellings answer at HTTP 200, so a caller that branches on status codes reads
 * a refusal as a success and concludes the candidate has no résumé.
 *
 * The returned `url` is a short-lived signed link. Fetch it immediately; do not store it.
 */
import { ENDPOINTS } from '../../shared/ashby-contract.js';
import { post } from '../endpoints/client.js';

export class NoResumeError extends Error {
  constructor(candidateId, why) {
    super(`No readable résumé for candidate ${candidateId}: ${why}. `
      + 'Sam will not grade against an empty document.');
    this.name = 'NoResumeError';
    this.candidateId = candidateId;
  }
}

/**
 * Downloads one file handle's bytes.
 *
 * @param {{id?: string, name?: string, handle: string}} fileHandle from candidate.info
 * @returns {Promise<{filename: string, bytes: Buffer, contentType: string}>}
 */
export async function fetchFile(fileHandle, { post: call = post, fetchImpl = fetch } = {}) {
  if (!fileHandle?.handle) {
    throw new Error('A file handle must carry its opaque `handle`; the id alone is refused by file.info.');
  }

  const info = await call(ENDPOINTS.fileInfo, { fileHandle: fileHandle.handle });
  if (!info?.url) {
    throw new Error(`file.info returned no url for ${fileHandle.name ?? fileHandle.handle.slice(0, 12)}.`);
  }

  const res = await fetchImpl(info.url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Downloading ${fileHandle.name ?? 'file'} failed (HTTP ${res.status}).`);

  return {
    filename: fileHandle.name ?? 'document',
    bytes: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get('content-type') ?? 'application/octet-stream',
  };
}

/**
 * The candidate's résumé, and everything else they attached.
 *
 * The résumé is required; the rest is not. A candidate with no résumé is REFUSED rather than
 * sent to the engine as an empty document — a score derived from nothing still looks like a
 * score once it is on the record, and that is the worst thing this integration can publish.
 *
 * One attachment failing does not lose the résumé: the engine can grade without a cover
 * letter, and what could not be read is reported rather than silently dropped.
 *
 * @returns {Promise<{resume, attachments: object[], unreadable: object[]}>}
 */
export async function fetchCandidateDocuments(candidate, opts = {}) {
  const handle = candidate?.resumeFileHandle;
  if (!handle?.handle) {
    throw new NoResumeError(candidate?.id, 'candidate.info returned no resumeFileHandle');
  }

  let resume;
  try {
    resume = await fetchFile(handle, opts);
  } catch (err) {
    throw new NoResumeError(candidate.id, err.message);
  }
  if (!resume.bytes?.length) {
    throw new NoResumeError(candidate.id, 'the résumé downloaded as zero bytes');
  }

  const attachments = [];
  const unreadable = [];
  for (const other of candidate.fileHandles ?? []) {
    if (other.handle === handle.handle) continue;             // already have it
    if (isSamGenerated(other.name)) continue;                 // see below
    try {
      attachments.push(await fetchFile(other, opts));
    } catch (err) {
      unreadable.push({ name: other.name ?? null, why: err.message });
    }
  }

  return { resume, attachments, unreadable };
}

/**
 * Files Sam put there itself, which must never be bound into a new Snapshot.
 *
 * `candidate.fileHandles` is everything on the record — INCLUDING the Snapshot from the last
 * delivery, because `candidate.uploadFile` attaches alongside everything else and nothing
 * distinguishes our uploads from the candidate's. Verified on a live record: after one
 * delivery, `fileHandles` carried both the candidate's résumé and `SAM_Snapshot_<name>.pdf`.
 *
 * Bind that in and the second Snapshot contains the first, the third contains the second,
 * and the attachment grows by a whole document every pass — behind a divider page captioned
 * "source document", implying the candidate submitted it.
 *
 * Matching on the filename is a blunt instrument, and it is the only one Ashby gives us:
 * there is no `source` or `uploadedBy` field on a file handle. The prefix is ours and is
 * generated in exactly one place, so it is stable — but a candidate who happens to name
 * their own file this way loses it from the attachment, which is the safe direction to be
 * wrong in.
 */
export const SAM_FILE_PREFIX = 'sam_snapshot';
export const isSamGenerated = (name) =>
  String(name ?? '').toLowerCase().startsWith(SAM_FILE_PREFIX);

/**
 * Candidate documents in the shape the Snapshot stitcher binds.
 *
 * The résumé first — it is the evidence the score was read from and belongs directly behind
 * the judgement. Everything else follows, flagged `read: false`, so its divider page says
 * plainly that Sam did not score it. A cover letter bound in behind a page captioned
 * "source document" would imply evidence the score never used.
 */
export function stitchSourcesFrom({ resume, attachments = [] }) {
  const ext = (name) => String(name ?? '').split('.').pop()?.toLowerCase() ?? '';
  return [
    { label: resume.filename, bytes: resume.bytes, ext: ext(resume.filename), read: true },
    ...attachments.map((a) => ({ label: a.filename, bytes: a.bytes, ext: ext(a.filename), read: false })),
  ];
}
