-- SpaceChatDB PostgreSQL Schema
-- Requires: wal_level = logical in postgresql.conf

CREATE TABLE IF NOT EXISTS users (
    identity     TEXT        PRIMARY KEY,
    nickname     TEXT        NOT NULL DEFAULT '',
    connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_ai        BOOLEAN     NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS chat_messages (
    id       BIGSERIAL   PRIMARY KEY,
    sender   TEXT        NOT NULL,
    sent_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    text     TEXT        NOT NULL CHECK (char_length(text) <= 500)
);

CREATE TABLE IF NOT EXISTS call_sessions (
    session_id  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    state       TEXT        NOT NULL CHECK (state IN ('Ringing', 'Active')),
    caller      TEXT        NOT NULL,
    callee      TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    answered_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS media_settings (
    id                          INT      PRIMARY KEY CHECK (id = 1),
    audio_target_sample_rate    INT      NOT NULL DEFAULT 24000,
    audio_frame_ms              SMALLINT NOT NULL DEFAULT 50,
    audio_max_frame_bytes       INT      NOT NULL DEFAULT 64000,
    audio_talking_rms_threshold REAL     NOT NULL DEFAULT 0.02
);
INSERT INTO media_settings (id) VALUES (1) ON CONFLICT DO NOTHING;

-- WAL-logged (not UNLOGGED) so logical replication works
CREATE TABLE IF NOT EXISTS audio_frames (
    id          BIGSERIAL   PRIMARY KEY,
    session_id  UUID        NOT NULL,
    from_id     TEXT        NOT NULL,
    to_id       TEXT        NOT NULL,
    seq         INT         NOT NULL,
    sample_rate INT         NOT NULL,
    channels    SMALLINT    NOT NULL,
    rms         REAL        NOT NULL,
    pcm16le     BYTEA       NOT NULL,
    inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS audio_frames_time_idx ON audio_frames (inserted_at);
ALTER TABLE audio_frames SET (autovacuum_vacuum_scale_factor = 0.01);

-- AI conversation transcripts (queryable conversation history)
CREATE TABLE IF NOT EXISTS ai_transcripts (
    id          BIGSERIAL   PRIMARY KEY,
    session_id  UUID        NOT NULL,
    role        TEXT        NOT NULL CHECK (role IN ('human', 'assistant')),
    text        TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ai_transcripts_session_idx ON ai_transcripts (session_id, created_at);

-- Publication for logical replication
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'spacechat_pub') THEN
        CREATE PUBLICATION spacechat_pub FOR TABLE
            users, chat_messages, call_sessions, media_settings, audio_frames, ai_transcripts;
    END IF;
END $$;
