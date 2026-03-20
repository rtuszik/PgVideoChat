import { base64ToPcm16le, computeRms, pcm16leToBase64 } from './audio.js';
import {
  AI_AGENT_IDENTITY,
  AUDIO_CHANNELS,
  AUDIO_FRAME_MS,
  AUDIO_SAMPLE_RATE,
} from './config.js';
import { pool } from './db.js';
import { OpenAIRealtimeClient } from './openai-realtime.js';

interface CallContext {
  sessionId: string;
  peerIdentity: string;
  openai: OpenAIRealtimeClient;
  outputSeq: number;
  /** Buffer to accumulate audio deltas before chunking into frames */
  responseAudioBuffer: Buffer;
}

const activeCalls = new Map<string, CallContext>();

/** Auto-accept an incoming call by writing directly to Postgres. */
export async function acceptCall(
  sessionId: string,
  caller: string,
): Promise<void> {
  console.log(
    `[agent] auto-accepting call ${sessionId.slice(0, 8)} from ${caller.slice(0, 12)}`,
  );

  const res = await pool.query(
    `UPDATE call_sessions SET state = 'Active', answered_at = NOW()
     WHERE session_id = $1 AND callee = $2 AND state = 'Ringing'`,
    [sessionId, AI_AGENT_IDENTITY],
  );

  if (res.rowCount === 0) {
    console.error(
      `[agent] failed to accept call ${sessionId.slice(0, 8)}: not found or already accepted`,
    );
    return;
  }

  console.log(`[agent] call ${sessionId.slice(0, 8)} accepted`);
}

/** Set up the OpenAI Realtime connection for a newly active call. */
export function startCall(sessionId: string, peerIdentity: string): void {
  if (activeCalls.has(sessionId)) {
    console.log(
      `[agent] call ${sessionId.slice(0, 8)} already active, skipping`,
    );
    return;
  }

  console.log(
    `[agent] starting call ${sessionId.slice(0, 8)} with peer ${peerIdentity.slice(0, 12)}`,
  );

  const ctx: CallContext = {
    sessionId,
    peerIdentity,
    outputSeq: 0,
    responseAudioBuffer: Buffer.alloc(0),
    openai: null as any, // Set below
  };

  const openai = new OpenAIRealtimeClient({
    onAudioDelta: (base64Audio) => {
      const pcm = base64ToPcm16le(base64Audio);
      // Accumulate audio data
      ctx.responseAudioBuffer = Buffer.concat([ctx.responseAudioBuffer, pcm]);
      // Flush complete frames immediately for low latency
      flushAudioFrames(ctx);
    },

    onAudioDone: () => {
      // Flush any remaining audio
      flushRemainingAudio(ctx);
      console.log(
        `[agent] response audio complete for call ${sessionId.slice(0, 8)}`,
      );
    },

    onInputTranscript: (text) => {
      console.log(`[agent] human said: "${text}"`);
      insertTranscript(sessionId, 'human', text).catch((err) =>
        console.error('[agent] failed to insert human transcript', err),
      );
    },

    onResponseTranscript: (text) => {
      console.log(`[agent] AI said: "${text}"`);
      insertTranscript(sessionId, 'assistant', text).catch((err) =>
        console.error('[agent] failed to insert AI transcript', err),
      );
    },

    onError: (error) => {
      console.error(
        `[agent] OpenAI error in call ${sessionId.slice(0, 8)}: ${error}`,
      );
    },

    onClose: () => {
      console.log(
        `[agent] OpenAI connection closed for call ${sessionId.slice(0, 8)}`,
      );
    },
  });

  ctx.openai = openai;
  activeCalls.set(sessionId, ctx);
  openai.connect();
}

/** Forward an incoming audio frame to OpenAI. */
export function handleAudioFrame(row: {
  session_id: string;
  from_id: string;
  pcm16le: Buffer;
}): void {
  const ctx = activeCalls.get(row.session_id);
  if (!ctx) return;

  const base64 = pcm16leToBase64(row.pcm16le);
  ctx.openai.sendAudio(base64);
}

/** Clean up when a call ends. */
export function endCall(sessionId: string): void {
  const ctx = activeCalls.get(sessionId);
  if (!ctx) return;

  console.log(`[agent] ending call ${sessionId.slice(0, 8)}`);
  ctx.openai.close();
  activeCalls.delete(sessionId);
}

/** Flush complete frames from the response audio buffer. */
function flushAudioFrames(ctx: CallContext): void {
  const bytesPerSample = 2;
  const samplesPerFrame = Math.floor(
    (AUDIO_SAMPLE_RATE * AUDIO_FRAME_MS) / 1000,
  );
  const bytesPerFrame = samplesPerFrame * bytesPerSample * AUDIO_CHANNELS;

  while (ctx.responseAudioBuffer.length >= bytesPerFrame) {
    const frame = ctx.responseAudioBuffer.subarray(0, bytesPerFrame);
    ctx.responseAudioBuffer = ctx.responseAudioBuffer.subarray(bytesPerFrame);
    insertAudioFrame(ctx, Buffer.from(frame));
  }
}

/** Flush any remaining partial audio at end of response. */
function flushRemainingAudio(ctx: CallContext): void {
  if (
    ctx.responseAudioBuffer.length > 0 &&
    ctx.responseAudioBuffer.length % 2 === 0
  ) {
    insertAudioFrame(ctx, Buffer.from(ctx.responseAudioBuffer));
    ctx.responseAudioBuffer = Buffer.alloc(0);
  }
}

/** Insert an audio frame into Postgres for delivery to the human peer. */
function insertAudioFrame(ctx: CallContext, pcm: Buffer): void {
  const seq = ctx.outputSeq++;
  const rms = computeRms(pcm);

  pool
    .query(
      `INSERT INTO audio_frames (session_id, from_id, to_id, seq, sample_rate, channels, rms, pcm16le)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        ctx.sessionId,
        AI_AGENT_IDENTITY,
        ctx.peerIdentity,
        seq,
        AUDIO_SAMPLE_RATE,
        AUDIO_CHANNELS,
        rms,
        pcm,
      ],
    )
    .catch((err) => {
      console.error(`[agent] failed to insert audio frame seq=${seq}`, err);
    });
}

/** Insert a transcript row into Postgres. */
async function insertTranscript(
  sessionId: string,
  role: string,
  text: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO ai_transcripts (session_id, role, text, created_at)
     VALUES ($1, $2, $3, NOW())`,
    [sessionId, role, text],
  );
}

/** Look up the peer identity for a call session from the database. */
export async function getPeerIdentity(
  sessionId: string,
): Promise<string | null> {
  const res = await pool.query(
    `SELECT caller, callee FROM call_sessions WHERE session_id = $1`,
    [sessionId],
  );
  if (res.rowCount === 0) return null;
  const { caller, callee } = res.rows[0];
  return caller === AI_AGENT_IDENTITY ? callee : caller;
}

/** Clean up all active calls (used during shutdown). */
export function cleanupAll(): void {
  for (const [sessionId, ctx] of activeCalls) {
    console.log(`[agent] cleaning up call ${sessionId.slice(0, 8)}`);
    ctx.openai.close();
  }
  activeCalls.clear();
}
