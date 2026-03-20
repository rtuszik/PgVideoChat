import { pool } from './db.js';

export function startCleanup(intervalMs = 2_000): NodeJS.Timeout {
  async function run() {
    try {
      await pool.query(
        `DELETE FROM audio_frames WHERE inserted_at < NOW() - INTERVAL '30 seconds'`,
      );
    } catch (err) {
      console.error('[cleanup] error', err);
    }
  }

  const id = setInterval(run, intervalMs);
  id.unref();
  return id;
}
