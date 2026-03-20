import { AUDIO_CHANNELS, AUDIO_FRAME_MS, AUDIO_SAMPLE_RATE } from './config.js';

/**
 * Split a PCM16LE buffer into frame-sized chunks.
 * At 24kHz mono, 50ms = 1200 samples = 2400 bytes per frame.
 */
export function chunkPcmToFrames(
  pcm: Buffer,
  sampleRate: number = AUDIO_SAMPLE_RATE,
  frameMs: number = AUDIO_FRAME_MS,
): Buffer[] {
  const bytesPerSample = 2; // PCM16LE
  const samplesPerFrame = Math.floor((sampleRate * frameMs) / 1000);
  const bytesPerFrame = samplesPerFrame * bytesPerSample * AUDIO_CHANNELS;

  const frames: Buffer[] = [];
  for (
    let offset = 0;
    offset + bytesPerFrame <= pcm.length;
    offset += bytesPerFrame
  ) {
    frames.push(pcm.subarray(offset, offset + bytesPerFrame));
  }

  // Include any trailing partial frame
  const remainder = pcm.length % bytesPerFrame;
  if (remainder > 0 && remainder % bytesPerSample === 0) {
    frames.push(pcm.subarray(pcm.length - remainder));
  }

  return frames;
}

/**
 * Compute RMS (root mean square) of a PCM16LE buffer.
 * Returns a value in [0, 1].
 */
export function computeRms(pcm: Buffer): number {
  const sampleCount = Math.floor(pcm.length / 2);
  if (sampleCount === 0) return 0;

  let sumSquares = 0;
  for (let i = 0; i < sampleCount; i++) {
    const sample = pcm.readInt16LE(i * 2) / 32768;
    sumSquares += sample * sample;
  }

  return Math.sqrt(sumSquares / sampleCount);
}

/** Convert PCM16LE buffer to base64 string for OpenAI Realtime API. */
export function pcm16leToBase64(buf: Buffer): string {
  return buf.toString('base64');
}

/** Convert base64 string from OpenAI Realtime API to PCM16LE buffer. */
export function base64ToPcm16le(b64: string): Buffer {
  return Buffer.from(b64, 'base64');
}
