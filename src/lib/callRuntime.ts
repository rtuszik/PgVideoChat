import { get, writable } from 'svelte/store';
import { type MediaSettings, mediaSettingsStore } from './mediaSettings';
import type { RelayConn } from './relay';
import { identityHex } from './relay';

export const remoteTalking = writable<boolean>(false);

type ActiveRuntime = {
  conn: RelayConn;
  myHex: string;
  peerHex: string;
  sessionIdStr: string;
  audioCtx: AudioContext;
  nextPlayTime: number;
  stopFns: (() => void)[];
  sendSeqAudio: number;
  micStream?: MediaStream;
  workletNode?: AudioWorkletNode;
  talkTimer?: number;
  cfg: MediaSettings;
};

let runtime: ActiveRuntime | null = null;

function mustFinite(n: number, name: string) {
  if (!Number.isFinite(n)) throw new Error(`Invalid ${name}`);
  return n;
}

function validateCfg(cfg: MediaSettings): MediaSettings {
  mustFinite(cfg.audio_target_sample_rate, 'audio_target_sample_rate');
  mustFinite(cfg.audio_frame_ms, 'audio_frame_ms');
  mustFinite(cfg.audio_max_frame_bytes, 'audio_max_frame_bytes');
  mustFinite(cfg.audio_talking_rms_threshold, 'audio_talking_rms_threshold');

  return cfg;
}

function idHex(id: any): string {
  return identityHex(id);
}

function sessionIdOf(sess: any): string {
  const id = sess?.session_id ?? sess?.sessionId;
  return id?.toString?.() ?? String(id ?? '');
}

// Binary frame builders for media
function buildBinaryAudioFrame(
  header: object,
  pcm16le: Uint8Array,
): ArrayBuffer {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const buf = new Uint8Array(1 + 4 + headerBytes.length + pcm16le.length);
  buf[0] = 0x01; // TAG_AUDIO
  new DataView(buf.buffer).setUint32(1, headerBytes.length, false);
  buf.set(headerBytes, 5);
  buf.set(pcm16le, 5 + headerBytes.length);
  return buf.buffer;
}

function asUint8Array(val: any): Uint8Array | null {
  if (!val) return null;
  if (val instanceof Uint8Array) return val;
  if (Array.isArray(val)) {
    try {
      return Uint8Array.from(val);
    } catch {
      return null;
    }
  }
  if (val instanceof ArrayBuffer) return new Uint8Array(val);
  if (
    val?.buffer instanceof ArrayBuffer &&
    typeof val.byteOffset === 'number' &&
    typeof val.byteLength === 'number'
  ) {
    try {
      return new Uint8Array(val.buffer, val.byteOffset, val.byteLength);
    } catch {
      return null;
    }
  }
  return null;
}

function getBytes(row: any, names: string[]): Uint8Array | null {
  for (const n of names) {
    if (row && row[n] != null) {
      const u8 = asUint8Array(row[n]);
      if (u8) return u8;
    }
  }
  return null;
}

function floatToPcm16leBytes(samples: Float32Array): {
  bytes: Uint8Array;
  rms: number;
} {
  let sumSq = 0;
  const i16 = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    sumSq += s * s;
    i16[i] = (s < 0 ? s * 32768 : s * 32767) | 0;
  }
  const rms = Math.sqrt(sumSq / Math.max(1, samples.length));
  const bytes = new Uint8Array(i16.buffer.slice(0));
  return { bytes, rms };
}

function pcm16leBytesToFloat(bytes: Uint8Array): Float32Array {
  const copy = bytes.slice().buffer;
  const i16 = new Int16Array(copy);
  const out = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) out[i] = i16[i] / 32768;
  return out;
}

function resampleLinear(
  input: Float32Array,
  inputRate: number,
  outputRate: number,
): Float32Array {
  if (inputRate === outputRate) return input;
  const ratio = outputRate / inputRate;
  const outLen = Math.max(1, Math.floor(input.length * ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i / ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = src - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

function scheduleAudio(
  audioCtx: AudioContext,
  nextPlayTime: number,
  pcm: Float32Array,
  sampleRate: number,
): number {
  const buf = audioCtx.createBuffer(1, pcm.length, sampleRate);
  buf.copyToChannel(pcm as unknown as Float32Array<ArrayBuffer>, 0);
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  src.connect(audioCtx.destination);

  const now = audioCtx.currentTime;
  const clamped = nextPlayTime > now + 0.15 ? now + 0.02 : nextPlayTime;
  const startAt = Math.max(clamped, now + 0.02);
  src.start(startAt);
  return startAt + pcm.length / sampleRate;
}

export async function startCallRuntime(
  session: any,
  conn: RelayConn,
  myId: any,
) {
  const cfg = get(mediaSettingsStore);
  if (!cfg)
    throw new Error(
      'Cannot start call: media_settings singleton (id=1) not loaded',
    );
  validateCfg(cfg);

  const sessionIdStr = sessionIdOf(session);
  if (!sessionIdStr) return;

  if (runtime && runtime.sessionIdStr === sessionIdStr) return;
  stopCallRuntime();

  const myHex = idHex(myId);
  const callerHex = idHex(session.caller);
  const peerIdentity = callerHex === myHex ? session.callee : session.caller;
  const peerHex = idHex(peerIdentity);

  const audioCtx = new AudioContext();
  const rt: ActiveRuntime = {
    conn,
    myHex,
    peerHex,
    sessionIdStr,
    audioCtx,
    nextPlayTime: audioCtx.currentTime + 0.1,
    stopFns: [],
    sendSeqAudio: 0,
    cfg,
  };
  runtime = rt;

  // If settings disappear mid-call, stop immediately (no defaults)
  const unsub = mediaSettingsStore.subscribe(async (next) => {
    if (!runtime || runtime.sessionIdStr !== sessionIdStr) return;
    if (!next) {
      stopCallRuntime();
      return;
    }
    validateCfg(next);
    runtime.cfg = next;
  });
  rt.stopFns.push(() => unsub());

  // Mic
  const mic = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  rt.micStream = mic;

  const workletUrl = new URL('./pcm-capture-worklet.ts', import.meta.url);
  await audioCtx.audioWorklet.addModule(workletUrl);

  const source = audioCtx.createMediaStreamSource(mic);
  const node = new AudioWorkletNode(audioCtx, 'pcm-capture');
  rt.workletNode = node;
  source.connect(node);

  const inRate = audioCtx.sampleRate;
  const outRate = rt.cfg.audio_target_sample_rate;
  const frameMs = rt.cfg.audio_frame_ms;
  const blockIn = Math.max(1, Math.floor(inRate * (frameMs / 1000)));

  let bufferIn = new Float32Array(0);

  node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
    if (!runtime || runtime.sessionIdStr !== sessionIdStr) return;
    const chunk = ev.data;
    if (!(chunk instanceof Float32Array)) return;

    const merged = new Float32Array(bufferIn.length + chunk.length);
    merged.set(bufferIn, 0);
    merged.set(chunk, bufferIn.length);
    bufferIn = merged;

    while (bufferIn.length >= blockIn) {
      const head = bufferIn.slice(0, blockIn);
      bufferIn = bufferIn.slice(blockIn);

      const resampled = resampleLinear(head, inRate, outRate);
      const { bytes, rms } = floatToPcm16leBytes(resampled);

      if (bytes.length > runtime.cfg.audio_max_frame_bytes) continue;

      const sessionId = session.session_id ?? session.sessionId;
      const seq = runtime.sendSeqAudio++;

      const frame = buildBinaryAudioFrame(
        {
          session_id: String(sessionId),
          to: runtime.peerHex,
          seq,
          sample_rate: outRate,
          channels: 1,
          rms,
        },
        bytes,
      );
      runtime.conn.sendBinaryFrame(frame);
    }
  };

  rt.stopFns.push(() => {
    node.port.onmessage = null;
    try {
      source.disconnect();
    } catch {}
    try {
      node.disconnect();
    } catch {}
  });
}

export function stopCallRuntime() {
  if (!runtime) return;

  for (const fn of runtime.stopFns) {
    try {
      fn();
    } catch {}
  }

  if (runtime.micStream)
    for (const t of runtime.micStream.getTracks()) t.stop();

  try {
    runtime.audioCtx.close();
  } catch {}

  runtime = null;
  remoteTalking.set(false);
}

export function handleAudioEvent(row: any) {
  if (!runtime) return;

  const sid = row?.session_id ?? row?.sessionId;
  const sidStr = sid?.toString?.() ?? String(sid ?? '');
  const fromHex = row?.from?.toHexString?.() ?? '';

  if (sidStr !== runtime.sessionIdStr) return;
  if (fromHex !== runtime.peerHex) return;

  const bytes = getBytes(row, ['pcm16le', 'pcm16Le', 'pcm16_le', 'pcm_16le']);
  if (!bytes) return;

  const pcm = pcm16leBytesToFloat(bytes);
  const sr = Number(
    row.sample_rate ?? row.sampleRate ?? runtime.cfg.audio_target_sample_rate,
  );

  runtime.nextPlayTime = scheduleAudio(
    runtime.audioCtx,
    runtime.nextPlayTime,
    pcm,
    sr,
  );

  const rms = Number(row.rms ?? 0);
  if (rms > runtime.cfg.audio_talking_rms_threshold) {
    remoteTalking.set(true);
    if (runtime.talkTimer) window.clearTimeout(runtime.talkTimer);
    runtime.talkTimer = window.setTimeout(() => remoteTalking.set(false), 250);
  }
}
