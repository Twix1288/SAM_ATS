/**
 * HALF 1 — stands in for Ashby's servers.
 *
 * Hosts the real Ashby endpoint paths with the real request shapes, the real Basic-auth
 * scheme, and the real { success, results } / { success, errors } envelopes, so the
 * integration under test cannot pass here and fail in production.
 *
 * It also imitates Ashby's HTML sanitisation on notes. The allow-list is not published,
 * so the one modelled here is a deliberately conservative guess — and seeing markup get
 * stripped in the demo is more honest than pretending it all survives.
 */
import http from 'node:http';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { ENDPOINTS, FILE_CONTEXT, CUSTOM_FIELD_OBJECT, UPLOAD_HANDLE_PARAMS as P, ok, fail } from '../shared/ashby-contract.js';
import { parseMultipart } from './multipart.js';
import { loadPool } from '../shared/seed/survey.js';
import * as db from './store.js';
import { renderAshbyUI } from './ui.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(HERE, 'output');
const PORT = Number(process.env.ASHBY_PORT ?? 3001);
const API_KEY = process.env.ASHBY_API_KEY ?? 'demo_ashby_key';

/**
 * Fault injection for the walkthrough. `ASHBY_FAIL=/candidate.uploadFile` makes that one
 * endpoint reject, so the partial-delivery path can be shown live rather than described.
 */
const FAIL_ENDPOINTS = new Set((process.env.ASHBY_FAIL ?? '').split(',').map((x) => x.trim()).filter(Boolean));

/**
 * The nastier fault: the write SUCCEEDS and then the response is lost. This is what a
 * timeout actually looks like from the client's side, and it is the only way to show
 * that a retry does not duplicate an appending write.
 *
 *   ASHBY_FLAKY=/candidate.createNote
 */
const FLAKY_ENDPOINTS = new Set((process.env.ASHBY_FLAKY ?? '').split(',').map((x) => x.trim()).filter(Boolean));
const flakedOnce = new Set();

mkdirSync(OUTPUT_DIR, { recursive: true });

const c = { a: '\x1b[36m', dim: '\x1b[90m', b: '\x1b[1m', g: '\x1b[32m', y: '\x1b[33m', off: '\x1b[0m' };
const log = (m, x = '') => console.log(`${c.a}[Ashby]${c.off} ${m}${x ? ` ${c.dim}${x}${c.off}` : ''}`);

const CUSTOM_FIELDS = db.CUSTOM_FIELDS;

/**
 * Seed the record with what Ashby knows the moment each person applies: who they are,
 * how to reach them, and the resume they uploaded. Deliberately nothing from Sam —
 * every score, file and note in this store arrives later through a real write call.
 */
const SURVEY = join(HERE, '..', 'data', 'survey_agree.com_business_development_representative.xlsx');
for (const r of loadPool(SURVEY)) {
  db.seedApplicant({
    responseHash: r.responseHash,
    name: r.name,
    email: r.email,
    location: r.location,
    linkedin: r.linkedin,
    resume: r.resume,
    attachments: r.attachments,
    appliedAt: '2025-12-11T00:00:00.000Z',
  });
}

/**
 * Sanitisation allow-list.
 *
 * CONFIRMED by the integration architecture: candidate.createNote renders rich formatting,
 * embedded tables and user mentions natively in the Activity Feed. Tables survive, so the
 * note can carry structure rather than prose — which is most of why it is the version a
 * reviewer actually reads.
 *
 * Attributes are still dropped apart from href, because no styling contract is published
 * and a note that depends on CSS would degrade invisibly.
 */
const ALLOWED_TAGS = new Set([
  'p', 'br', 'b', 'strong', 'i', 'em', 'u', 'ul', 'ol', 'li', 'a', 'h3', 'h4',
  'blockquote', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
]);

function sanitizeHtml(html) {
  let stripped = 0;
  const out = html.replace(/<\/?([a-z0-9]+)([^>]*)>/gi, (tag, name, attrs) => {
    if (!ALLOWED_TAGS.has(name.toLowerCase())) { stripped++; return ''; }
    if (name.toLowerCase() === 'a') {
      const href = /href="([^"]*)"/i.exec(attrs)?.[1];
      return href ? `<a href="${href}">` : tag.startsWith('</') ? '</a>' : '<a>';
    }
    if (attrs.trim()) stripped++;              // every other attribute is dropped
    return tag.startsWith('</') ? `</${name}>` : `<${name}>`;
  });
  return { html: out, stripped };
}

const received = { customFields: [], notes: [], files: [], handles: new Map(), blobs: new Map() };

/**
 * Ashby distinguishes the two failure modes, and so must we: a missing key is 401, a key
 * that exists but lacks the scope for the endpoint is 403 with missing_endpoint_permission.
 * Collapsing both into 401 sends integrators hunting for a credential problem when the
 * real fix is a permission grant.
 */
function authorize(req) {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return { ok: false, status: 401, error: 'No API key was provided.' };
  const [key] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
  if (key !== API_KEY) {
    return { ok: false, status: 403, error: 'missing_endpoint_permission', code: 'missing_endpoint_permission' };
  }
  return { ok: true };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (ch) => {
      size += ch.length;
      if (size > 25 * 1024 * 1024) { reject(new Error('Request body exceeds the 25MB limit.')); req.destroy(); return; }
      chunks.push(ch);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const send = (res, status, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
};

function saveFile(filename, bytes, kind) {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  writeFileSync(join(OUTPUT_DIR, safe), bytes);
  received.files.push(safe);
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  log(`${kind} ${c.b}${safe}${c.off}`, `${bytes.length} bytes · sha256:${digest} → output/`);
  return safe;
}

const HANDLERS = {
  [ENDPOINTS.listCustomFields]: () => ok(CUSTOM_FIELDS),

  [ENDPOINTS.createFileUploadHandle]: (body) => {
    const filename = body[P.name];
    const contentType = body[P.type];
    const contentLength = body[P.length];
    const context = body[P.context];
    if (!filename) return fail(`${P.name} is required.`);
    if (!context) return fail(`${P.context} is required.`);
    if (!Object.values(FILE_CONTEXT).includes(context)) {
      return fail(`${P.context} must be one of ${Object.values(FILE_CONTEXT).join(', ')}.`);
    }
    if (!contentType) return fail(`${P.type} is required — the upload signature is bound to it.`);
    if (typeof contentLength !== 'number') return fail(`${P.length} must be a number.`);

    const handle = `handle_${randomUUID()}`;
    received.handles.set(handle, { filename, contentType, contentLength, context });
    log(`file.createFileUploadHandle → ${filename}`, `context ${context} · ${contentType} · ${contentLength} bytes`);
    // Ashby returns an S3 presigned POST: the url plus the policy fields that must be
    // written into the form ahead of the file part.
    return ok({
      handle,
      url: `http://localhost:${PORT}/upload/${handle}`,
      fields: { key: `agree/file/${filename}`, acl: 'private', 'Content-Type': contentType },
    });
  },

  [ENDPOINTS.setCustomFields]: (body) => {
    const { objectId, objectType, values } = body;
    if (!objectId) return fail('objectId is required.');
    if (!Object.values(CUSTOM_FIELD_OBJECT).includes(objectType)) {
      return fail(`objectType must be one of ${Object.values(CUSTOM_FIELD_OBJECT).join(', ')}.`);
    }
    if (!Array.isArray(values) || !values.length) return fail('values must be a non-empty array.');

    const written = [];
    for (const { fieldId, fieldValue } of values) {
      const field = CUSTOM_FIELDS.find((f) => f.id === fieldId);
      if (!field) return fail(`No custom field exists with id ${fieldId}.`);
      // null clears a field, whatever its type. Ashby does not document how to unset a
      // value — the per-type table says what to send to SET one and is silent on
      // removing one — so this models the reading that matches every other JSON API.
      // It is on the questions list, and it is the one place a wrong guess shows up.
      if (fieldValue !== null && field.fieldType === 'Number' && typeof fieldValue !== 'number') {
        return fail(`Custom field "${field.title}" is a Number field but received ${typeof fieldValue}.`);
      }
      written.push({ field: field.title, value: fieldValue });
      received.customFields.push({ field: field.title, value: fieldValue });
    }
    if (!db.setCustomFieldValues(objectId, values)) {
      return fail(`No application exists with id ${objectId}.`);
    }
    log(`customField.setValues  ${written.length} fields on ${objectType}`, `object ${objectId.slice(0, 8)}`);
    for (const w of written) console.log(`        ${c.dim}│${c.off} ${c.b}${w.field}${c.off} = ${c.g}${w.value}${c.off}`);
    return ok({ objectId, values: written });
  },

  [ENDPOINTS.setCustomField]: (body) => {
    const { objectId, fieldId, fieldValue } = body;
    if (!objectId || !fieldId) return fail('objectId and fieldId are required.');
    const field = CUSTOM_FIELDS.find((f) => f.id === fieldId);
    if (!field) return fail(`No custom field exists with id ${fieldId}.`);
    received.customFields.push({ field: field.title, value: fieldValue });
    log(`customField.setValue  ${c.b}${field.title}${c.off} = ${c.g}${fieldValue}${c.off}`);
    return ok({ id: fieldId, value: fieldValue });
  },

  [ENDPOINTS.createNote]: (body) => {
    const { candidateId, note } = body;
    if (!candidateId) return fail('candidateId is required.');
    const type = typeof note === 'string' ? 'text/plain' : note?.type ?? 'text/plain';
    const raw = typeof note === 'string' ? note : note?.value;
    if (!raw) return fail('note is required.');
    if (!['text/plain', 'text/html'].includes(type)) {
      return fail(`note.type must be text/plain or text/html, received ${type}.`);
    }

    let stored = raw;
    if (type === 'text/html') {
      const clean = sanitizeHtml(raw);
      stored = clean.html;
      log(`candidate.createNote  ${c.b}${type}${c.off}`, `${raw.length} → ${stored.length} chars after sanitising`);
      if (clean.stripped) console.log(`        ${c.y}│${c.off} ${c.dim}${clean.stripped} tags or attributes stripped by sanitisation${c.off}`);
    } else {
      log(`candidate.createNote  ${c.b}${type}${c.off}`, `${raw.length} chars`);
    }
    received.notes.push({ type, value: stored });
    const saved = db.addNote(candidateId, { type, value: stored, author: 'Sam' });
    if (!saved) return fail(`No candidate exists with id ${candidateId}.`);
    writeFileSync(join(OUTPUT_DIR, `note_${candidateId.slice(0, 8)}.${type === 'text/html' ? 'html' : 'txt'}`), stored);
    return ok({ id: saved.id, createdAt: saved.createdAt });
  },
};

/**
 * Read endpoints. The Ashby UI calls only these, so it can never show a value that no
 * write actually landed — which is the whole point of keeping the store on this side.
 */
const READS = {
  [ENDPOINTS.listCandidates]: () => ok(db.listCandidates()),
  [ENDPOINTS.candidateInfo]: (b) => {
    const c = db.getCandidate(b.id ?? b.candidateId);
    return c ? ok(c) : fail(`No candidate exists with id ${b.id ?? b.candidateId}.`);
  },
  [ENDPOINTS.listApplications]: () => ok(db.listApplications().map(db.expandApplication)),
  [ENDPOINTS.applicationInfo]: (b) => {
    const a = db.getApplication(b.id ?? b.applicationId);
    return a ? ok(db.expandApplication(a)) : fail(`No application exists with id ${b.id ?? b.applicationId}.`);
  },
  [ENDPOINTS.listNotes]: (b) => {
    const id = b.candidateId ?? b.id;
    return db.getCandidate(id) ? ok(db.listNotes(id)) : fail(`No candidate exists with id ${id}.`);
  },
  [ENDPOINTS.fileInfo]: (b) => {
    const f = db.getFile(b.id ?? b.fileId);
    return f ? ok(f) : fail(`No file exists with id ${b.id ?? b.fileId}.`);
  },
  [ENDPOINTS.jobInfo]: () => ok(db.JOB),
  [ENDPOINTS.listInterviewStages]: () => ok(db.INTERVIEW_STAGES),
  [ENDPOINTS.searchCandidates]: (b) => {
    const q = String(b.name ?? b.query ?? '').toLowerCase();
    return ok(db.listCandidates().filter((c) => c.name.toLowerCase().includes(q)));
  },
};

const server = http.createServer(async (req, res) => {
  // The presigned upload target. Unauthenticated by design — the handle is the secret.
  // S3 takes a multipart POST carrying the policy fields, and rejects the upload when the
  // bytes disagree with the contentType/contentLength the signature was bound to.
  if (req.method === 'POST' && req.url.startsWith('/upload/')) {
    const handle = req.url.slice('/upload/'.length);
    const meta = received.handles.get(handle);
    if (!meta) return send(res, 403, fail(`Unknown or expired upload handle "${handle}".`));

    let raw;
    try { raw = await readBody(req); }
    catch (err) { return send(res, 413, fail(err.message)); }

    let file; let fields;
    try {
      const parsed = parseMultipart(raw, req.headers['content-type'] ?? '');
      file = parsed.files.file; fields = parsed.fields;
    } catch (err) { return send(res, 400, fail(err.message)); }
    if (!file) return send(res, 400, fail('The upload must contain a "file" part.'));

    if (fields['Content-Type'] && fields['Content-Type'] !== meta.contentType) {
      return send(res, 403, fail('SignatureDoesNotMatch: Content-Type differs from the signed value.'));
    }
    if (file.body.length !== meta.contentLength) {
      return send(res, 403, fail(
        `EntityTooLarge: signature was bound to ${meta.contentLength} bytes, received ${file.body.length}.`));
    }

    received.blobs.set(handle, file.body);
    log(`POST /upload/${handle.slice(0, 15)}…`, `${file.body.length} bytes · signature fields verified`);
    res.writeHead(204); return res.end();
  }

  // The Ashby product UI. Served from this side because it is Ashby's screen, and it
  // reads the same store the API writes to.
  if (req.method === 'GET') {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = renderAshbyUI();
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (url.pathname.startsWith('/files/')) {
      const file = db.getFile(url.pathname.slice('/files/'.length));
      const blob = file && db.getUploadHandle(`blob:${file.id}`);
      if (!blob) return send(res, 404, fail('File not found.'));
      res.writeHead(200, { 'content-type': file.contentType, 'content-disposition': `inline; filename="${file.name}"` });
      return res.end(blob.bytes);
    }
    return send(res, 404, fail(`No GET handler for ${url.pathname}.`));
  }

  if (req.method !== 'POST') return send(res, 405, fail('Ashby endpoints accept POST or GET requests only.'));
  const auth = authorize(req);
  if (!auth.ok) return send(res, auth.status, fail(auth.error));

  const path = new URL(req.url, `http://localhost:${PORT}`).pathname;
  const contentType = req.headers['content-type'] ?? '';

  if (FAIL_ENDPOINTS.has(path)) {
    log(`${c.y}injected failure${c.off} ${path}`, 'ASHBY_FAIL is set for this endpoint');
    return send(res, 503, fail(`Injected failure: ${path} is unavailable.`));
  }

  let raw;
  try { raw = await readBody(req); }
  catch (err) { return send(res, 413, fail(err.message)); }

  try {
    // Both file endpoints accept either JSON (a handle) or multipart (the bytes).
    if (path === ENDPOINTS.uploadFile || path === ENDPOINTS.uploadResume) {
      const isResume = path === ENDPOINTS.uploadResume;
      const part = isResume ? 'resume' : 'file';
      let candidateId; let filename; let bytes;

      if (contentType.startsWith('multipart/form-data')) {
        const { fields, files } = parseMultipart(raw, contentType);
        candidateId = fields.candidateId;
        filename = files[part]?.filename;
        bytes = files[part]?.body;
        if (!bytes) return send(res, 400, fail(`${part} file part is required.`));
      } else {
        const body = JSON.parse(raw.toString('utf8') || '{}');
        candidateId = body.candidateId;
        const key = isResume ? body.resumeHandle : body.fileHandle;
        const meta = received.handles.get(key);
        if (!meta) return send(res, 400, fail(`Unknown ${isResume ? 'resumeHandle' : 'fileHandle'} "${key}".`));
        if (!isResume && meta.context !== FILE_CONTEXT.candidateFiles) {
          return send(res, 400, fail(`A handle created for ${meta.context} cannot be attached via candidate.uploadFile.`));
        }
        filename = meta.filename;
        bytes = received.blobs.get(key);
        if (!bytes) return send(res, 400, fail(`No bytes were uploaded to the presigned URL for handle "${key}".`));
      }
      if (!candidateId) return send(res, 400, fail('candidateId is required.'));

      const saved = saveFile(filename, bytes, isResume ? 'candidate.uploadResume' : 'candidate.uploadFile');
      const handle = db.attachFile(candidateId, { name: saved, bytes, source: 'Sam' });
      if (!handle) return send(res, 400, fail(`No candidate exists with id ${candidateId}.`));
      db.putUploadHandle(`blob:${handle.id}`, { bytes });
      return send(res, 200, ok({ id: candidateId, fileHandles: [handle] }));
    }

    const handler = HANDLERS[path] ?? READS[path];
    if (!handler) return send(res, 404, fail(`Unknown endpoint "${path}".`));

    const body = contentType.includes('application/json') ? JSON.parse(raw.toString('utf8') || '{}') : {};
    const result = handler(body);

    // Apply the write, then drop the response — once — so the client has to decide
    // whether repeating it is safe.
    if (FLAKY_ENDPOINTS.has(path) && !flakedOnce.has(path) && result.success) {
      flakedOnce.add(path);
      log(`${c.y}write applied, response dropped${c.off} ${path}`, 'ASHBY_FLAKY — the client will retry');
      return send(res, 503, fail('Service temporarily unavailable.'));
    }
    return send(res, result.success ? 200 : 400, result);
  } catch (err) {
    return send(res, 400, fail(err.message));
  }
});

server.listen(PORT, () => {
  const seeded = db.samCoverage();
  log(`listening on :${PORT}`, 'stand-in for https://api.ashbyhq.com');
  log(`${seeded.total} applications seeded`, `${db.JOB.title} · Application Review · nothing from Sam yet`);
  log(`${c.b}open http://localhost:${PORT}${c.off}`, 'the Ashby product UI, reading this store');
});

process.on('SIGINT', () => {
  const cov = db.samCoverage();
  console.log(`\n[Ashby] ${cov.scored} of ${cov.total} applications scored by Sam · ${cov.withFile} with a Snapshot file · ${cov.withNote} with a note`);
  server.close(() => process.exit(0));
});
