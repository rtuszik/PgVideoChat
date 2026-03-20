import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { createIdentity, resolveToken } from './auth.js';
import { startCleanup } from './cleanup.js';
import { ensureReplicationSlot, pool } from './db.js';
import { buildJsonFrame, parseIncoming } from './protocol.js';
import * as reducers from './reducers.js';
import { type ClientMap, startReplication } from './replication.js';

const PORT = parseInt(process.env.PORT ?? '9000', 10);

// identity hex → WebSocket (one connection per identity)
const clients: ClientMap = new Map();

const server = http.createServer((_req, res) => {
  // CORS headers for health checks
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('spacechat pg-relay');
});

const wss = new WebSocketServer({ server });

wss.on('connection', async (ws: WebSocket, req) => {
  const url = new URL(req.url ?? '/', `http://localhost`);
  const providedToken = url.searchParams.get('token') ?? undefined;

  let identity: string;
  let token: string;

  if (providedToken) {
    const resolved = resolveToken(providedToken);
    if (resolved) {
      identity = resolved;
      token = providedToken;
    } else {
      const cid = createIdentity();
      identity = cid.identity;
      token = cid.token;
    }
  } else {
    const cid = createIdentity();
    identity = cid.identity;
    token = cid.token;
  }

  // Close any existing connection for this identity
  const existing = clients.get(identity);
  if (existing && existing.readyState === WebSocket.OPEN) {
    existing.close(4001, 'Replaced by new connection');
  }
  clients.set(identity, ws);

  console.log(`[ws] connected: ${identity.slice(0, 12)}…`);

  // Send identity to client
  ws.send(buildJsonFrame({ type: 'identity', identity, token }));

  // Register user in DB
  try {
    await reducers.clientConnected(identity);
  } catch (err) {
    console.error('[ws] clientConnected error', err);
  }

  // Send initial snapshot of all state tables
  try {
    await sendSnapshot(ws);
  } catch (err) {
    console.error('[ws] snapshot error', err);
  }

  ws.on('message', async (data: Buffer | ArrayBuffer | Buffer[]) => {
    try {
      const buf = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data);
      await handleMessage(ws, identity, buf);
    } catch (err) {
      console.error(
        `[ws] message handler error for ${identity.slice(0, 12)}`,
        err,
      );
    }
  });

  ws.on('close', async () => {
    console.log(`[ws] disconnected: ${identity.slice(0, 12)}…`);
    clients.delete(identity);
    try {
      await reducers.clientDisconnected(identity);
    } catch (err) {
      console.error('[ws] clientDisconnected error', err);
    }
  });

  ws.on('error', (err) => {
    console.error(`[ws] error for ${identity.slice(0, 12)}`, err);
  });
});

async function sendSnapshot(ws: WebSocket): Promise<void> {
  const tables: Array<[string, string]> = [
    ['users', 'SELECT * FROM users'],
    ['chat_messages', 'SELECT * FROM chat_messages ORDER BY id DESC LIMIT 250'],
    ['call_sessions', 'SELECT * FROM call_sessions'],
    ['media_settings', 'SELECT * FROM media_settings WHERE id = 1'],
    [
      'ai_transcripts',
      `SELECT * FROM ai_transcripts WHERE created_at > NOW() - INTERVAL '1 hour' ORDER BY id DESC LIMIT 200`,
    ],
  ];

  for (const [table, query] of tables) {
    const res = await pool.query(query);
    const msg = buildJsonFrame({ type: 'snapshot', table, rows: res.rows });
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

async function handleMessage(
  ws: WebSocket,
  identity: string,
  buf: Buffer,
): Promise<void> {
  const parsed = parseIncoming(buf);
  if (!parsed) {
    sendError(ws, 'unknown', 'Malformed message');
    return;
  }

  if (parsed.tag === 0x00 && parsed.json) {
    await handleControl(ws, identity, parsed.json);
    return;
  }

  if (parsed.tag === 0x01 && parsed.header && parsed.payload) {
    const result = await reducers.sendAudioFrame({
      identity,
      sessionId: parsed.header.session_id,
      to: parsed.header.to,
      seq: parsed.header.seq,
      sampleRate: parsed.header.sample_rate,
      channels: parsed.header.channels,
      rms: parsed.header.rms,
      pcm16le: parsed.payload,
    });
    if (result.error) sendError(ws, 'send_audio_frame', result.error);
    return;
  }

  sendError(ws, 'unknown', 'Unknown message type');
}

async function handleControl(
  ws: WebSocket,
  identity: string,
  msg: any,
): Promise<void> {
  const type: string = msg.type ?? '';

  const dispatch: Record<string, () => Promise<{ error?: string }>> = {
    set_nickname: () => reducers.setNickname(identity, msg.nickname ?? ''),
    send_message: () => reducers.sendMessage(identity, msg.text ?? ''),
    request_call: () => reducers.requestCall(identity, msg.target ?? ''),
    accept_call: () => reducers.acceptCall(identity, msg.session_id ?? ''),
    decline_call: () => reducers.declineCall(identity, msg.session_id ?? ''),
    end_call: () => reducers.endCall(identity, msg.session_id ?? ''),
  };

  const handler = dispatch[type];
  if (!handler) {
    sendError(ws, type, 'Unknown message type');
    return;
  }

  try {
    const result = await handler();
    if (result.error) {
      sendError(ws, type, result.error);
    } else {
      sendAck(ws, type);
    }
  } catch (err) {
    sendError(ws, type, String(err));
  }
}

function sendAck(ws: WebSocket, reqType: string): void {
  sendJson(ws, { type: 'ack', req_type: reqType });
}

function sendError(ws: WebSocket, reqType: string, message: string): void {
  sendJson(ws, { type: 'error', req_type: reqType, message });
}

function sendJson(ws: WebSocket, obj: object): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(buildJsonFrame(obj));
}

// Startup
async function main() {
  try {
    await ensureReplicationSlot();
  } catch (err) {
    console.error('[startup] failed to ensure replication slot:', err);
    console.error('[startup] make sure wal_level = logical in postgresql.conf');
    process.exit(1);
  }

  startReplication(clients);
  startCleanup();

  server.listen(PORT, () => {
    console.log(`[relay] listening on :${PORT}`);
  });
}

main().catch((err) => {
  console.error('[startup] fatal', err);
  process.exit(1);
});
