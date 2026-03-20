# SpaceChatDB

Real-time voice chat app built with SvelteKit + PostgreSQL. Uses bun as the runtime and package manager.

## Architecture

- **Frontend**: SvelteKit app in `src/` — connects to pg-relay via WebSocket
- **Backend**: `pg-relay/` — WebSocket server (bun) that reads/writes PostgreSQL and uses logical replication to push changes to clients in real-time
- **AI Worker**: `ai-worker/` — Standalone service (bun) that registers as an AI user, auto-accepts calls, and pipes audio through the OpenAI Realtime API
- **Database**: PostgreSQL with `wal_level = logical` — schema in `pg-relay/schema.sql`

## Running

1. Set up PostgreSQL with `wal_level = logical`
2. Apply schema: `psql $DATABASE_URL < pg-relay/schema.sql`
3. Create `.env` in project root: `VITE_RELAY_URI=ws://localhost:9000`
4. Create `.env` in `pg-relay/`: `DATABASE_URL=postgresql://...`
5. Create `.env` in `ai-worker/`: `DATABASE_URL=postgresql://... OPENAI_API_KEY=sk-...`
6. Start pg-relay: `cd pg-relay && bun install && bun dev`
7. Start frontend: `bun install && bun dev`
8. Start AI worker: `cd ai-worker && bun install && bun dev`

## Key Files

- `pg-relay/src/server.ts` — WebSocket server, message routing
- `pg-relay/src/reducers.ts` — Business logic (chat, calls, media)
- `pg-relay/src/replication.ts` — PG logical replication → WebSocket push
- `pg-relay/src/db.ts` — Database pool and replication slot setup
- `pg-relay/schema.sql` — Full database schema
- `src/lib/relay.ts` — Client-side WebSocket connection and state management
- `src/lib/callRuntime.ts` — Audio capture and playback
- `ai-worker/src/index.ts` — AI worker entry point
- `ai-worker/src/agent.ts` — Per-call orchestrator, OpenAI Realtime API integration
- `ai-worker/src/openai-realtime.ts` — OpenAI Realtime API WebSocket client
