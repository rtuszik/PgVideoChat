// Binary protocol constants
export const TAG_JSON = 0x00;
export const TAG_AUDIO = 0x01;
export function buildJsonFrame(obj: object): Buffer {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const out = Buffer.allocUnsafe(1 + json.length);
  out[0] = TAG_JSON;
  json.copy(out, 1);
  return out;
}

export function buildMediaFrame(
  tag: typeof TAG_AUDIO,
  header: object,
  payload: Buffer,
): Buffer {
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  const out = Buffer.allocUnsafe(1 + 4 + headerBytes.length + payload.length);
  out[0] = tag;
  out.writeUInt32BE(headerBytes.length, 1);
  headerBytes.copy(out, 5);
  payload.copy(out, 5 + headerBytes.length);
  return out;
}

export function parseIncoming(buf: Buffer): {
  tag: number;
  json?: any;
  header?: any;
  payload?: Buffer;
} | null {
  if (buf.length < 1) return null;
  const tag = buf[0];

  if (tag === TAG_JSON) {
    try {
      const json = JSON.parse(buf.subarray(1).toString('utf8'));
      return { tag, json };
    } catch {
      return null;
    }
  }

  if (tag === TAG_AUDIO) {
    if (buf.length < 5) return null;
    const headerLen = buf.readUInt32BE(1);
    if (buf.length < 5 + headerLen) return null;
    try {
      const header = JSON.parse(
        buf.subarray(5, 5 + headerLen).toString('utf8'),
      );
      const payload = buf.subarray(5 + headerLen);
      return { tag, header, payload };
    } catch {
      return null;
    }
  }

  return null;
}
