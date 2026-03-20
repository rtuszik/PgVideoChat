export const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

export const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY environment variable is required');
}

// Deterministic 64-char hex identity for the AI agent
export const AI_AGENT_IDENTITY =
  process.env.AI_AGENT_IDENTITY ??
  '00000000000000000000000000000000' + '00000000000000000000000000000001';

export const AI_AGENT_NICKNAME =
  process.env.AI_AGENT_NICKNAME ?? 'AI Assistant';

export const AI_SYSTEM_PROMPT =
  process.env.AI_SYSTEM_PROMPT ??
  'You are a helpful voice assistant in a real-time audio call. Keep responses concise and conversational, as they will be spoken aloud. Avoid markdown, code blocks, or long lists.';

export const OPENAI_REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL ?? 'gpt-4o-realtime-preview';

export const PG_SLOT_NAME = process.env.PG_SLOT_NAME ?? 'spacechat_ai_slot';

export const AUDIO_SAMPLE_RATE = 24_000;
export const AUDIO_FRAME_MS = 50;
export const AUDIO_CHANNELS = 1;
