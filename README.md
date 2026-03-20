# SpaceChatDB

Real-time voice chat application with AI assistant support. Built with SvelteKit, PostgreSQL, and the OpenAI Realtime API.

## Architecture

Three services communicate through PostgreSQL:

- **Frontend** (`src/`) -- SvelteKit app. Connects to pg-relay over WebSocket for chat, calls, and live state updates.
- **pg-relay** (`pg-relay/`) -- Bun WebSocket server. Handles message routing, auth, and streams database changes to clients via PostgreSQL logical replication.
- **AI worker** (`ai-worker/`) -- Standalone Bun service. Registers as a user, auto-accepts calls, and pipes audio through the OpenAI Realtime API.

Audio is transmitted as PCM16LE frames (24 kHz, mono) over a custom binary WebSocket protocol.

## Prerequisites

- [Bun](https://bun.sh)
- PostgreSQL 14+ with `wal_level = logical`

## Setup

Apply the database schema:

```sh
psql $DATABASE_URL < pg-relay/schema.sql
```

Create three `.env` files:

**Root `.env`**
```
VITE_RELAY_URI=ws://localhost:9000
```

**`pg-relay/.env`**
```
DATABASE_URL=postgresql://user:password@localhost:5432/spacechat
```

**`ai-worker/.env`**
```
DATABASE_URL=postgresql://user:password@localhost:5432/spacechat
OPENAI_API_KEY=sk-...
```

## Running

```sh
# Terminal 1 -- relay server
cd pg-relay && bun install && bun dev

# Terminal 2 -- frontend
bun install && bun dev

# Terminal 3 -- AI worker (optional)
cd ai-worker && bun install && bun dev
```

The frontend runs on `http://localhost:5174`. The relay server runs on port 9000.

## Testing

```sh
bun run test                                    # frontend tests
cd pg-relay && bun run test                     # relay tests
cd ai-worker && bun run test                    # worker tests
```

## Linting

```sh
bun run lint
```

Uses [Biome](https://biomejs.dev) for formatting and linting.

## Kubernetes deployment

Manifests are in `k8s/`. Single-replica setup with an in-cluster PostgreSQL instance.

### Build and push images

```sh
# Set your registry
REGISTRY=your-registry.example.com/spacechatdb

docker build -f Dockerfile.frontend \
  --build-arg VITE_RELAY_URI=wss://relay.example.com \
  -t $REGISTRY/frontend:latest .

docker build -f Dockerfile.pg-relay -t $REGISTRY/pg-relay:latest .
docker build -f Dockerfile.ai-worker -t $REGISTRY/ai-worker:latest .

docker push $REGISTRY/frontend:latest
docker push $REGISTRY/pg-relay:latest
docker push $REGISTRY/ai-worker:latest
```

### Deploy

```sh
# Create secrets (edit secrets.example.yaml first)
cp k8s/secrets.example.yaml k8s/secrets.yaml
# Fill in real values in k8s/secrets.yaml

# Update image references in k8s/*.yaml to point to your registry

kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/secrets.yaml
kubectl apply -f k8s/postgres.yaml
kubectl apply -f k8s/pg-relay.yaml
kubectl apply -f k8s/ai-worker.yaml
kubectl apply -f k8s/frontend.yaml
```

The frontend `VITE_RELAY_URI` is baked in at Docker build time since it runs in the browser. Set it to the external URL where pg-relay will be reachable.

## Project structure

```
src/
  lib/
    relay.ts              # WebSocket client, state management
    callRuntime.ts        # Audio capture and playback
  routes/
    +page.svelte          # Main UI

pg-relay/
  src/
    server.ts             # WebSocket server, message routing
    reducers.ts           # Business logic (chat, calls, media)
    replication.ts        # Logical replication listener
    db.ts                 # Database pool, replication slot setup
  schema.sql              # Full database schema

ai-worker/
  src/
    index.ts              # Entry point
    agent.ts              # Per-call orchestrator
    openai-realtime.ts    # OpenAI Realtime API client
```
