import {
  LogicalReplicationService,
  PgoutputPlugin,
} from 'pg-logical-replication';
import { AI_AGENT_IDENTITY } from './config.js';
import { PUBLICATION_NAME, REPLICATION_DSN, SLOT_NAME } from './db.js';

export type ReplicationCallbacks = {
  onCallRinging: (sessionId: string, caller: string) => void;
  onCallActive: (sessionId: string) => void;
  onCallDeleted: (sessionId: string) => void;
  onAudioFrame: (row: {
    session_id: string;
    from_id: string;
    to_id: string;
    seq: number;
    sample_rate: number;
    channels: number;
    rms: number;
    pcm16le: Buffer;
  }) => void;
};

export function startReplication(
  callbacks: ReplicationCallbacks,
): LogicalReplicationService {
  const plugin = new PgoutputPlugin({
    protoVersion: 1,
    publicationNames: [PUBLICATION_NAME],
  });

  const service = new LogicalReplicationService(
    { connectionString: REPLICATION_DSN, ssl: { rejectUnauthorized: true } },
    { acknowledge: { auto: true, timeoutSeconds: 10 } },
  );

  service.on('data', (_lsn: string, log: any) => {
    try {
      dispatchChange(callbacks, log);
    } catch (err) {
      console.error('[replication] dispatch error', err);
    }
  });

  service.on('error', (err: Error) => {
    console.error('[replication] stream error', err);
  });

  function subscribe() {
    service.subscribe(plugin, SLOT_NAME).catch((err: Error) => {
      console.error(
        '[replication] subscribe failed, retrying in 5s',
        err.message,
      );
      setTimeout(subscribe, 5_000);
    });
  }

  subscribe();
  console.log(`[replication] subscribing to slot ${SLOT_NAME}`);
  return service;
}

function dispatchChange(callbacks: ReplicationCallbacks, log: any): void {
  const tableName: string = log.relation?.name ?? '';
  const tag: string = log.tag ?? '';

  if (tableName === 'call_sessions') {
    if (tag === 'insert') {
      const row = log.new;
      if (!row) return;
      // Only care about calls where the AI agent is the callee
      if (row.callee === AI_AGENT_IDENTITY && row.state === 'Ringing') {
        callbacks.onCallRinging(row.session_id, row.caller);
      }
    } else if (tag === 'update') {
      const row = log.new;
      if (!row) return;
      if (
        (row.caller === AI_AGENT_IDENTITY ||
          row.callee === AI_AGENT_IDENTITY) &&
        row.state === 'Active'
      ) {
        callbacks.onCallActive(row.session_id);
      }
    } else if (tag === 'delete') {
      const old = log.old ?? log.new;
      if (!old) return;
      if (
        old.caller === AI_AGENT_IDENTITY ||
        old.callee === AI_AGENT_IDENTITY
      ) {
        callbacks.onCallDeleted(old.session_id);
      }
    }
    return;
  }

  if (tableName === 'audio_frames' && tag === 'insert') {
    const row = log.new;
    if (!row) return;
    // Only process audio addressed to the AI agent
    if (row.to_id !== AI_AGENT_IDENTITY) return;

    callbacks.onAudioFrame({
      session_id: row.session_id,
      from_id: row.from_id,
      to_id: row.to_id,
      seq: row.seq,
      sample_rate: row.sample_rate,
      channels: row.channels,
      rms: row.rms,
      pcm16le: Buffer.isBuffer(row.pcm16le)
        ? row.pcm16le
        : Buffer.from(row.pcm16le),
    });
    return;
  }
}
