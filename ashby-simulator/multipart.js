/** Minimal multipart/form-data parser — enough for candidate.uploadResume. */
export function parseMultipart(buffer, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '');
  if (!boundaryMatch) throw new Error('multipart/form-data request is missing its boundary parameter.');
  const boundary = Buffer.from(`--${boundaryMatch[1] ?? boundaryMatch[2]}`);

  const parts = [];
  let index = buffer.indexOf(boundary);
  while (index !== -1) {
    const start = index + boundary.length;
    if (buffer.slice(start, start + 2).toString() === '--') break; // closing boundary
    const next = buffer.indexOf(boundary, start);
    if (next === -1) break;

    const chunk = buffer.subarray(start + 2, next - 2); // strip leading and trailing CRLF
    const split = chunk.indexOf('\r\n\r\n');
    if (split !== -1) {
      const headers = chunk.subarray(0, split).toString('utf8');
      const body = chunk.subarray(split + 4);
      const name = /name="([^"]+)"/i.exec(headers)?.[1];
      const filename = /filename="([^"]+)"/i.exec(headers)?.[1];
      if (name) parts.push({ name, filename, body });
    }
    index = next;
  }

  const fields = Object.create(null);
  const files = Object.create(null);
  for (const p of parts) {
    if (p.filename) files[p.name] = { filename: p.filename, body: p.body };
    else fields[p.name] = p.body.toString('utf8');
  }
  return { fields, files };
}
