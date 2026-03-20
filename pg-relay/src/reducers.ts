import { pool } from './db.js';

export async function clientConnected(identity: string): Promise<void> {
  const defaultNick = `user-${identity.slice(0, 8)}`;
  await pool.query(
    `INSERT INTO users (identity, nickname, connected_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (identity) DO UPDATE
       SET connected_at = NOW(),
           nickname = CASE WHEN users.nickname = '' THEN $2 ELSE users.nickname END`,
    [identity, defaultNick],
  );
}

export async function clientDisconnected(identity: string): Promise<void> {
  await pool.query(
    `DELETE FROM call_sessions WHERE caller = $1 OR callee = $1`,
    [identity],
  );
  await pool.query(`DELETE FROM users WHERE identity = $1`, [identity]);
}

export async function setNickname(
  identity: string,
  nickname: string,
): Promise<{ error?: string }> {
  const trimmed = nickname.trim();
  if (!trimmed) return { error: 'Nickname cannot be empty' };
  if (trimmed.length > 32)
    return { error: 'Nickname must be <= 32 characters' };

  const res = await pool.query(
    `UPDATE users SET nickname = $1 WHERE identity = $2`,
    [trimmed, identity],
  );
  if (res.rowCount === 0) return { error: 'User not found' };
  return {};
}

export async function sendMessage(
  identity: string,
  text: string,
): Promise<{ error?: string }> {
  const t = text.trim();
  if (!t) return { error: 'Message cannot be empty' };
  if (t.length > 500) return { error: 'Message must be <= 500 characters' };

  await pool.query(
    `INSERT INTO chat_messages (sender, sent_at, text) VALUES ($1, NOW(), $2)`,
    [identity, t],
  );
  return {};
}

export async function requestCall(
  identity: string,
  target: string,
): Promise<{ error?: string }> {
  if (identity === target) return { error: 'Cannot call yourself' };

  const uRes = await pool.query(`SELECT 1 FROM users WHERE identity = $1`, [
    target,
  ]);
  if (uRes.rowCount === 0) return { error: 'Target is not online' };

  const cRes = await pool.query(
    `SELECT 1 FROM call_sessions
     WHERE (caller = $1 OR callee = $1 OR caller = $2 OR callee = $2)
       AND state IN ('Ringing', 'Active')
     LIMIT 1`,
    [identity, target],
  );
  if ((cRes.rowCount ?? 0) > 0) {
    return { error: 'Caller or callee is already in a call' };
  }

  await pool.query(
    `INSERT INTO call_sessions (state, caller, callee, created_at)
     VALUES ('Ringing', $1, $2, NOW())`,
    [identity, target],
  );
  return {};
}

export async function acceptCall(
  identity: string,
  sessionId: string,
): Promise<{ error?: string }> {
  const res = await pool.query(
    `SELECT callee, state FROM call_sessions WHERE session_id = $1`,
    [sessionId],
  );
  if (res.rowCount === 0) return { error: 'Call session not found' };

  const sess = res.rows[0];
  if (sess.callee !== identity) return { error: 'Only the callee can accept' };
  if (sess.state !== 'Ringing') return { error: 'Call is not ringing' };

  await pool.query(
    `UPDATE call_sessions SET state = 'Active', answered_at = NOW() WHERE session_id = $1`,
    [sessionId],
  );
  return {};
}

export async function declineCall(
  identity: string,
  sessionId: string,
): Promise<{ error?: string }> {
  const res = await pool.query(
    `SELECT callee FROM call_sessions WHERE session_id = $1`,
    [sessionId],
  );
  if (res.rowCount === 0) return { error: 'Call session not found' };
  if (res.rows[0].callee !== identity)
    return { error: 'Only the callee can decline' };

  await pool.query(`DELETE FROM call_sessions WHERE session_id = $1`, [
    sessionId,
  ]);
  return {};
}

export async function endCall(
  identity: string,
  sessionId: string,
): Promise<{ error?: string }> {
  const res = await pool.query(
    `SELECT caller, callee FROM call_sessions WHERE session_id = $1`,
    [sessionId],
  );
  if (res.rowCount === 0) return { error: 'Call session not found' };

  const { caller, callee } = res.rows[0];
  if (caller !== identity && callee !== identity) {
    return { error: 'Only a participant can end this call' };
  }

  await pool.query(`DELETE FROM call_sessions WHERE session_id = $1`, [
    sessionId,
  ]);
  return {};
}

export async function sendAudioFrame(params: {
  identity: string;
  sessionId: string;
  to: string;
  seq: number;
  sampleRate: number;
  channels: number;
  rms: number;
  pcm16le: Buffer;
}): Promise<{ error?: string }> {
  const { identity, sessionId, to, seq, sampleRate, channels, rms, pcm16le } =
    params;

  const res = await pool.query(
    `SELECT state, caller, callee FROM call_sessions WHERE session_id = $1`,
    [sessionId],
  );
  if (res.rowCount === 0) return { error: 'Call session not found' };

  const sess = res.rows[0];
  if (sess.state !== 'Active') return { error: 'Call is not active' };

  const peer =
    sess.caller === identity
      ? sess.callee
      : sess.callee === identity
        ? sess.caller
        : null;
  if (!peer || peer !== to) return { error: 'Invalid recipient' };
  if (pcm16le.length > 64_000) return { error: 'Audio frame too large' };

  await pool.query(
    `INSERT INTO audio_frames (session_id, from_id, to_id, seq, sample_rate, channels, rms, pcm16le)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [sessionId, identity, to, seq, sampleRate, channels, rms, pcm16le],
  );
  return {};
}
