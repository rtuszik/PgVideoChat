import {
  LogicalReplicationService,
  PgoutputPlugin,
} from 'pg-logical-replication';
import type WebSocket from 'ws';
import { PUBLICATION_NAME, REPLICATION_DSN, SLOT_NAME } from './db.js';
import { buildJsonFrame, buildMediaFrame, TAG_AUDIO } from './protocol.js';

export type ClientMap = Map<string, WebSocket>;

function sendToClient(
  clients: ClientMap,
  identity: string,
  data: Buffer,
): void {
  const ws = clients.get(identity);
  if (ws && ws.readyState === 1 /* OPEN */) {
    ws.send(data);
  }
}

function broadcast(clients: ClientMap, data: Buffer): void {
  for (const ws of clients.values()) {
    if (ws.readyState === 1) {
      ws.send(data);
    }
  }
}

function rowToJson(
  row: Record<string, any> | null | undefined,
): Record<string, any> {
  if (!row) return {};
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(row)) {
    if (Buffer.isBuffer(v)) {
      out[k] = v.toString('base64');
    } else {
      out[k] = v;
    }
  }
  return out;
}

function dispatchChange(clients: ClientMap, log: any): void {
  const tableName: string = log.relation?.name ?? '';
  const tag: string = log.tag ?? '';

  // Audio frames: route to target client only
  if (tableName === 'audio_frames' && tag === 'insert') {
    const row = log.new;
    if (!row) return;

    const frame = buildMediaFrame(
      TAG_AUDIO,
      {
        session_id: row.session_id,
        from: row.from_id,
        seq: row.seq,
        sample_rate: row.sample_rate,
        channels: row.channels,
        rms: row.rms,
      },
      Buffer.isBuffer(row.pcm16le) ? row.pcm16le : Buffer.from(row.pcm16le),
    );

    sendToClient(clients, row.to_id, frame);
    return;
  }

  // State tables: broadcast to all
  const stateTables = new Set([
    'users',
    'chat_messages',
    'call_sessions',
    'media_settings',
    'ai_transcripts',
  ]);
  if (!stateTables.has(tableName)) return;

  let msg: Buffer;
  if (tag === 'insert') {
    msg = buildJsonFrame({
      type: 'insert',
      table: tableName,
      row: rowToJson(log.new),
    });
  } else if (tag === 'update') {
    msg = buildJsonFrame({
      type: 'update',
      table: tableName,
      row: rowToJson(log.new),
      old: rowToJson(log.old),
    });
  } else if (tag === 'delete') {
    msg = buildJsonFrame({
      type: 'delete',
      table: tableName,
      old: rowToJson(log.old ?? log.new),
    });
  } else {
    return;
  }

  broadcast(clients, msg);
}

export function startReplication(
  clients: ClientMap,
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
      dispatchChange(clients, log);
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
