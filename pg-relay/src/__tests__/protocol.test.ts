import { describe, expect, test } from 'bun:test';
import {
  buildJsonFrame,
  buildMediaFrame,
  parseIncoming,
  TAG_AUDIO,
  TAG_JSON,
} from '../protocol.js';

describe('buildJsonFrame', () => {
  test('first byte is TAG_JSON', () => {
    const frame = buildJsonFrame({ hello: 'world' });
    expect(frame[0]).toBe(TAG_JSON);
  });

  test('payload is valid JSON', () => {
    const obj = { type: 'test', value: 42 };
    const frame = buildJsonFrame(obj);
    const json = frame.subarray(1).toString('utf8');
    expect(JSON.parse(json)).toEqual(obj);
  });

  test('handles empty object', () => {
    const frame = buildJsonFrame({});
    const json = frame.subarray(1).toString('utf8');
    expect(JSON.parse(json)).toEqual({});
  });

  test('handles nested objects', () => {
    const obj = { a: { b: [1, 2, 3] } };
    const frame = buildJsonFrame(obj);
    const json = frame.subarray(1).toString('utf8');
    expect(JSON.parse(json)).toEqual(obj);
  });
});

describe('buildMediaFrame', () => {
  test('first byte is the tag', () => {
    const frame = buildMediaFrame(TAG_AUDIO, { seq: 0 }, Buffer.from([0xff]));
    expect(frame[0]).toBe(TAG_AUDIO);
  });

  test('header length is big-endian uint32 at offset 1', () => {
    const header = { seq: 0 };
    const headerJson = JSON.stringify(header);
    const frame = buildMediaFrame(TAG_AUDIO, header, Buffer.alloc(0));
    const headerLen = frame.readUInt32BE(1);
    expect(headerLen).toBe(Buffer.byteLength(headerJson, 'utf8'));
  });

  test('header JSON is at offset 5', () => {
    const header = { session_id: '123', seq: 7 };
    const frame = buildMediaFrame(TAG_AUDIO, header, Buffer.alloc(0));
    const headerLen = frame.readUInt32BE(1);
    const headerJson = frame.subarray(5, 5 + headerLen).toString('utf8');
    expect(JSON.parse(headerJson)).toEqual(header);
  });

  test('payload follows header', () => {
    const payload = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    const frame = buildMediaFrame(TAG_AUDIO, { seq: 0 }, payload);
    const headerLen = frame.readUInt32BE(1);
    const extractedPayload = frame.subarray(5 + headerLen);
    expect(Buffer.compare(extractedPayload, payload)).toBe(0);
  });

  test('total length is correct', () => {
    const header = { x: 1 };
    const payload = Buffer.alloc(10);
    const headerLen = Buffer.byteLength(JSON.stringify(header), 'utf8');
    const frame = buildMediaFrame(TAG_AUDIO, header, payload);
    expect(frame.length).toBe(1 + 4 + headerLen + 10);
  });
});

describe('parseIncoming', () => {
  test('parses JSON frame', () => {
    const obj = { type: 'hello', data: 123 };
    const frame = buildJsonFrame(obj);
    const result = parseIncoming(frame);
    expect(result).not.toBeNull();
    expect(result!.tag).toBe(TAG_JSON);
    expect(result!.json).toEqual(obj);
  });

  test('parses audio frame', () => {
    const header = { session_id: 'abc', seq: 5 };
    const payload = Buffer.from([1, 2, 3, 4, 5]);
    const frame = buildMediaFrame(TAG_AUDIO, header, payload);
    const result = parseIncoming(frame);
    expect(result).not.toBeNull();
    expect(result!.tag).toBe(TAG_AUDIO);
    expect(result!.header).toEqual(header);
    expect(Buffer.compare(result!.payload!, payload)).toBe(0);
  });

  test('returns null for empty buffer', () => {
    expect(parseIncoming(Buffer.alloc(0))).toBeNull();
  });

  test('returns null for unknown tag', () => {
    const buf = Buffer.from([0xff, 0x01, 0x02]);
    expect(parseIncoming(buf)).toBeNull();
  });

  test('returns null for truncated audio frame (no header length)', () => {
    const buf = Buffer.from([TAG_AUDIO, 0x00, 0x00]);
    expect(parseIncoming(buf)).toBeNull();
  });

  test('returns null for truncated audio frame (header length exceeds buffer)', () => {
    const buf = Buffer.alloc(5);
    buf[0] = TAG_AUDIO;
    buf.writeUInt32BE(100, 1); // claims 100 bytes of header but buffer is only 5
    expect(parseIncoming(buf)).toBeNull();
  });

  test('returns null for malformed JSON in JSON frame', () => {
    const buf = Buffer.from([TAG_JSON, ...Buffer.from('not{json')]);
    expect(parseIncoming(buf)).toBeNull();
  });

  test('returns null for malformed JSON in audio frame header', () => {
    const badHeader = Buffer.from('not{json');
    const buf = Buffer.alloc(1 + 4 + badHeader.length);
    buf[0] = TAG_AUDIO;
    buf.writeUInt32BE(badHeader.length, 1);
    badHeader.copy(buf, 5);
    expect(parseIncoming(buf)).toBeNull();
  });

  test('roundtrip: JSON frame', () => {
    const obj = { type: 'snapshot', table: 'users', rows: [{ id: 1 }] };
    const result = parseIncoming(buildJsonFrame(obj));
    expect(result!.json).toEqual(obj);
  });

  test('roundtrip: audio frame', () => {
    const header = {
      session_id: '42',
      to: 'abc123',
      seq: 99,
      sample_rate: 24000,
    };
    const payload = Buffer.from(
      Array.from({ length: 100 }, (_, i) => i & 0xff),
    );
    const result = parseIncoming(buildMediaFrame(TAG_AUDIO, header, payload));
    expect(result!.header).toEqual(header);
    expect(Buffer.compare(result!.payload!, payload)).toBe(0);
  });

  test('audio frame with empty payload', () => {
    const header = { seq: 0 };
    const result = parseIncoming(
      buildMediaFrame(TAG_AUDIO, header, Buffer.alloc(0)),
    );
    expect(result!.tag).toBe(TAG_AUDIO);
    expect(result!.header).toEqual(header);
    expect(result!.payload!.length).toBe(0);
  });
});
