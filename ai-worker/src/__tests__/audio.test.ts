import { describe, expect, test } from 'bun:test';
import {
  base64ToPcm16le,
  chunkPcmToFrames,
  computeRms,
  pcm16leToBase64,
} from '../audio.js';

describe('chunkPcmToFrames', () => {
  test('splits buffer into correct frame sizes', () => {
    // 24kHz mono, 50ms = 1200 samples = 2400 bytes per frame
    const sampleRate = 24000;
    const frameMs = 50;
    const bytesPerFrame = 2400;

    // 2 full frames = 4800 bytes
    const pcm = Buffer.alloc(bytesPerFrame * 2);
    const frames = chunkPcmToFrames(pcm, sampleRate, frameMs);

    expect(frames).toHaveLength(2);
    expect(frames[0].length).toBe(bytesPerFrame);
    expect(frames[1].length).toBe(bytesPerFrame);
  });

  test('includes trailing partial frame if sample-aligned', () => {
    const sampleRate = 24000;
    const frameMs = 50;
    const bytesPerFrame = 2400;

    // 1 full frame + 100 bytes (50 samples, sample-aligned)
    const pcm = Buffer.alloc(bytesPerFrame + 100);
    const frames = chunkPcmToFrames(pcm, sampleRate, frameMs);

    expect(frames).toHaveLength(2);
    expect(frames[0].length).toBe(bytesPerFrame);
    expect(frames[1].length).toBe(100);
  });

  test('excludes trailing partial frame if not sample-aligned', () => {
    const sampleRate = 24000;
    const frameMs = 50;
    const bytesPerFrame = 2400;

    // 1 full frame + 99 bytes (not divisible by 2)
    const pcm = Buffer.alloc(bytesPerFrame + 99);
    const frames = chunkPcmToFrames(pcm, sampleRate, frameMs);

    expect(frames).toHaveLength(1);
  });

  test('returns empty array for empty buffer', () => {
    const frames = chunkPcmToFrames(Buffer.alloc(0), 24000, 50);
    expect(frames).toHaveLength(0);
  });

  test('preserves original data', () => {
    const pcm = Buffer.alloc(2400);
    pcm.writeInt16LE(12345, 0);
    pcm.writeInt16LE(-9876, 2);

    const frames = chunkPcmToFrames(pcm, 24000, 50);
    expect(frames[0].readInt16LE(0)).toBe(12345);
    expect(frames[0].readInt16LE(2)).toBe(-9876);
  });
});

describe('computeRms', () => {
  test('returns 0 for silence', () => {
    const pcm = Buffer.alloc(200); // 100 samples of silence
    expect(computeRms(pcm)).toBe(0);
  });

  test('returns 0 for empty buffer', () => {
    expect(computeRms(Buffer.alloc(0))).toBe(0);
  });

  test('returns ~1 for full-scale signal', () => {
    // All samples at max positive value (32767)
    const pcm = Buffer.alloc(200);
    for (let i = 0; i < 100; i++) {
      pcm.writeInt16LE(32767, i * 2);
    }
    const rms = computeRms(pcm);
    expect(rms).toBeGreaterThan(0.99);
    expect(rms).toBeLessThanOrEqual(1);
  });

  test('computes correct RMS for known signal', () => {
    // Single sample at half scale (16384 = ~0.5)
    const pcm = Buffer.alloc(2);
    pcm.writeInt16LE(16384, 0);
    const rms = computeRms(pcm);
    expect(rms).toBeCloseTo(16384 / 32768, 4);
  });

  test('handles negative samples', () => {
    const pcm = Buffer.alloc(4);
    pcm.writeInt16LE(-32768, 0);
    pcm.writeInt16LE(32767, 2);
    const rms = computeRms(pcm);
    expect(rms).toBeGreaterThan(0.99);
  });
});

describe('pcm16leToBase64 / base64ToPcm16le roundtrip', () => {
  test('roundtrip preserves data', () => {
    const original = Buffer.from([0x01, 0x02, 0x03, 0x04, 0xff, 0xfe]);
    const b64 = pcm16leToBase64(original);
    const decoded = base64ToPcm16le(b64);

    expect(Buffer.compare(original, decoded)).toBe(0);
  });

  test('roundtrip with PCM audio data', () => {
    const pcm = Buffer.alloc(100);
    for (let i = 0; i < 50; i++) {
      pcm.writeInt16LE(Math.floor(Math.random() * 65535) - 32768, i * 2);
    }
    const b64 = pcm16leToBase64(pcm);
    const decoded = base64ToPcm16le(b64);

    expect(Buffer.compare(pcm, decoded)).toBe(0);
  });

  test('base64 output is a valid string', () => {
    const b64 = pcm16leToBase64(Buffer.from([0xab, 0xcd]));
    expect(typeof b64).toBe('string');
    expect(b64.length).toBeGreaterThan(0);
  });

  test('handles empty buffer', () => {
    const b64 = pcm16leToBase64(Buffer.alloc(0));
    const decoded = base64ToPcm16le(b64);
    expect(decoded.length).toBe(0);
  });
});
