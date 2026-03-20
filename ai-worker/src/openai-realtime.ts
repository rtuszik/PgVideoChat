import WebSocket from 'ws';
import {
  AI_SYSTEM_PROMPT,
  OPENAI_API_KEY,
  OPENAI_REALTIME_MODEL,
} from './config.js';

export type RealtimeEvents = {
  onAudioDelta: (base64Audio: string) => void;
  onAudioDone: () => void;
  onInputTranscript: (text: string) => void;
  onResponseTranscript: (text: string) => void;
  onError: (error: string) => void;
  onClose: () => void;
};

export class OpenAIRealtimeClient {
  private ws: WebSocket | null = null;
  private events: RealtimeEvents;

  constructor(events: RealtimeEvents) {
    this.events = events;
  }

  connect(): void {
    const url = `wss://api.openai.com/v1/realtime?model=${OPENAI_REALTIME_MODEL}`;

    this.ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });

    this.ws.on('open', () => {
      console.log('[openai-rt] connected');
      this.configureSession();
    });

    this.ws.on('message', (data: WebSocket.RawData) => {
      try {
        const event = JSON.parse(data.toString());
        this.handleEvent(event);
      } catch (err) {
        console.error('[openai-rt] failed to parse message', err);
      }
    });

    this.ws.on('error', (err: Error) => {
      console.error('[openai-rt] websocket error', err.message);
      this.events.onError(err.message);
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      console.log(`[openai-rt] closed: ${code} ${reason.toString()}`);
      this.ws = null;

      this.events.onClose();
    });
  }

  private configureSession(): void {
    this.send({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions: AI_SYSTEM_PROMPT,
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: {
          model: 'whisper-1',
        },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 800,
        },
      },
    });

    console.log('[openai-rt] session configured');
  }

  /** Send audio data (PCM16LE base64) to the Realtime API. */
  sendAudio(base64Audio: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.send({
      type: 'input_audio_buffer.append',
      audio: base64Audio,
    });
  }

  private handleEvent(event: any): void {
    switch (event.type) {
      case 'session.created':
        console.log('[openai-rt] session created');
        break;

      case 'session.updated':
        console.log('[openai-rt] session updated');
        break;

      case 'response.audio.delta':
        if (event.delta) {
          this.events.onAudioDelta(event.delta);
        }
        break;

      case 'response.audio.done':
        this.events.onAudioDone();
        break;

      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript) {
          this.events.onInputTranscript(event.transcript);
        }
        break;

      case 'response.audio_transcript.done':
        if (event.transcript) {
          this.events.onResponseTranscript(event.transcript);
        }
        break;

      case 'error':
        console.error('[openai-rt] API error:', event.error);
        this.events.onError(JSON.stringify(event.error));
        break;

      case 'input_audio_buffer.speech_started':
        console.log('[openai-rt] speech started');
        break;

      case 'input_audio_buffer.speech_stopped':
        console.log('[openai-rt] speech stopped');
        break;

      case 'response.created':
      case 'response.done':
      case 'response.output_item.added':
      case 'response.output_item.done':
      case 'response.content_part.added':
      case 'response.content_part.done':
      case 'response.audio_transcript.delta':
      case 'conversation.item.created':
      case 'input_audio_buffer.committed':
        // Expected lifecycle events, no action needed
        break;

      default:
        // Log unexpected events for debugging
        if (event.type) {
          console.log(`[openai-rt] unhandled event: ${event.type}`);
        }
        break;
    }
  }

  private send(event: object): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
    }
  }

  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}
