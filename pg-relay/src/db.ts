import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

const pgSsl =
  process.env.PG_SSL === 'false' ? false : { rejectUnauthorized: true };

export const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: pgSsl,
  max: 10,
  idleTimeoutMillis: 30_000,
});

export const REPLICATION_DSN = DATABASE_URL;

export const SLOT_NAME = process.env.PG_SLOT_NAME ?? 'spacechat_slot';
export const PUBLICATION_NAME = 'spacechat_pub';

export async function ensureReplicationSlot(): Promise<void> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT 1 FROM pg_replication_slots WHERE slot_name = $1`,
      [SLOT_NAME],
    );
    if (res.rowCount === 0) {
      await client.query(
        `SELECT pg_create_logical_replication_slot($1, 'pgoutput')`,
        [SLOT_NAME],
      );
      console.log(`[db] created replication slot: ${SLOT_NAME}`);
    } else {
      console.log(`[db] replication slot already exists: ${SLOT_NAME}`);
    }
  } finally {
    client.release();
  }
}
