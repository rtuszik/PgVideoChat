import {
  acceptCall,
  cleanupAll,
  endCall,
  getPeerIdentity,
  handleAudioFrame,
  startCall,
} from './agent.js';
import { AI_AGENT_IDENTITY, AI_AGENT_NICKNAME } from './config.js';
import { ensureReplicationSlot, pool } from './db.js';
import { startReplication } from './replication.js';

async function registerAgent(): Promise<void> {
  await pool.query(
    `INSERT INTO users (identity, nickname, connected_at, is_ai)
     VALUES ($1, $2, NOW(), TRUE)
     ON CONFLICT (identity) DO UPDATE
       SET connected_at = NOW(), nickname = $2, is_ai = TRUE`,
    [AI_AGENT_IDENTITY, AI_AGENT_NICKNAME],
  );
  console.log(
    `[main] registered AI agent: ${AI_AGENT_NICKNAME} (${AI_AGENT_IDENTITY.slice(0, 12)}…)`,
  );
}

async function unregisterAgent(): Promise<void> {
  await pool.query(
    `DELETE FROM call_sessions WHERE caller = $1 OR callee = $1`,
    [AI_AGENT_IDENTITY],
  );
  await pool.query(`DELETE FROM users WHERE identity = $1`, [
    AI_AGENT_IDENTITY,
  ]);
  console.log('[main] unregistered AI agent');
}

async function main(): Promise<void> {
  console.log('[main] starting ai-worker...');

  try {
    await ensureReplicationSlot();
  } catch (err) {
    console.error('[main] failed to ensure replication slot:', err);
    console.error('[main] make sure wal_level = logical in postgresql.conf');
    process.exit(1);
  }

  await registerAgent();

  // Track pending calls that have been accepted but not yet active
  const pendingCalls = new Map<string, { caller: string }>();

  startReplication({
    onCallRinging: (sessionId, caller) => {
      // Auto-accept the call
      pendingCalls.set(sessionId, { caller });
      acceptCall(sessionId, caller).catch((err) =>
        console.error('[main] accept error', err),
      );
    },

    onCallActive: async (sessionId) => {
      // Call is now active — start the OpenAI session
      const pending = pendingCalls.get(sessionId);
      let peerIdentity: string | null = null;

      if (pending) {
        peerIdentity = pending.caller;
        pendingCalls.delete(sessionId);
      } else {
        // Fallback: look up from DB
        peerIdentity = await getPeerIdentity(sessionId);
      }

      if (peerIdentity) {
        startCall(sessionId, peerIdentity);
      } else {
        console.error(
          `[main] could not determine peer for call ${sessionId.slice(0, 8)}`,
        );
      }
    },

    onCallDeleted: (sessionId) => {
      pendingCalls.delete(sessionId);
      endCall(sessionId);
    },

    onAudioFrame: (row) => {
      handleAudioFrame(row);
    },
  });

  console.log('[main] ai-worker running. Press Ctrl+C to stop.');

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n[main] shutting down...');
    cleanupAll();
    try {
      await unregisterAgent();
    } catch (err) {
      console.error('[main] unregister error', err);
    }
    await pool.end();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[main] fatal', err);
  process.exit(1);
});
