import { get, writable } from 'svelte/store';
import { browser } from '$app/environment';
import { handleAudioEvent, stopCallRuntime } from './callRuntime';
import { type MediaSettings, mediaSettingsStore } from './mediaSettings';

// Identity shim: wraps hex string with .toHexString() so +page.svelte works unchanged
export type IdentityCompat = {
  toHexString(): string;
  _hex: string;
};

export type RelayConn = {
  sendBinaryFrame(buf: ArrayBuffer): void;
  sendControl(obj: object): void;
};

function makeIdent(hex: string): IdentityCompat {
  return { _hex: hex, toHexString: () => hex };
}

// Stores — same names as original so +page.svelte needs zero changes
export const connStore = writable<RelayConn | null>(null);
export const identityStore = writable<IdentityCompat | null>(null);
export const isConnected = writable(false);
export const connectionError = writable<string | null>(null);
export const actionError = writable<string | null>(null);

export const usersStore = writable<any[]>([]);
export const messagesStore = writable<any[]>([]);
export const callSessionsStore = writable<any[]>([]);

export const incomingCallStore = writable<any | null>(null);
export const activeCallStore = writable<any | null>(null);
export const aiTranscriptsStore = writable<any[]>([]);

// Identity helpers (same signatures as original)
export function identityHex(id: any): string {
  if (!id) return '';
  if (typeof id === 'string') return id;
  if (typeof id._hex === 'string') return id._hex;
  if (typeof id.toHexString === 'function') return id.toHexString();
  return '';
}

export function shortHex(id: any): string {
  const h = identityHex(id);
  return h ? `${h.slice(0, 10)}…${h.slice(-6)}` : '';
}

// Binary frame builders
function buildControlFrame(obj: object): ArrayBuffer {
  const json = JSON.stringify(obj);
  const jsonBytes = new TextEncoder().encode(json);
  const buf = new Uint8Array(1 + jsonBytes.length);
  buf[0] = 0x00;
  buf.set(jsonBytes, 1);
  return buf.buffer;
}

// State management helpers
function sessionIdStr(sess: any): string {
  const id = sess?.session_id ?? sess?.sessionId;
  return id?.toString?.() ?? String(id ?? '');
}

function upsertUsers(arr: any[], row: any): any[] {
  const hex = identityHex(row.identity);
  const idx = arr.findIndex((u) => identityHex(u.identity) === hex);
  if (idx === -1) return [...arr, row];
  const copy = arr.slice();
  copy[idx] = row;
  return copy;
}

function removeUser(arr: any[], identity: any): any[] {
  const hex = identityHex(identity);
  return arr.filter((u) => identityHex(u.identity) !== hex);
}

function upsertMessage(arr: any[], row: any): any[] {
  const id = row?.id?.toString?.() ?? String(row?.id ?? '');
  if (!id) return arr;
  const idx = arr.findIndex(
    (m) => (m?.id?.toString?.() ?? String(m?.id ?? '')) === id,
  );
  let next: any[];
  if (idx === -1) next = [...arr, row];
  else {
    next = arr.slice();
    next[idx] = row;
  }
  next.sort((a, b) => {
    const ai = BigInt(a.id ?? 0);
    const bi = BigInt(b.id ?? 0);
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });
  return next.slice(-250);
}

function upsertCallSession(arr: any[], row: any): any[] {
  const id = sessionIdStr(row);
  const idx = arr.findIndex((s) => sessionIdStr(s) === id);
  if (idx === -1) return [...arr, row];
  const copy = arr.slice();
  copy[idx] = row;
  return copy;
}

function removeCallSession(arr: any[], row: any): any[] {
  const id = sessionIdStr(row);
  return arr.filter((s) => sessionIdStr(s) !== id);
}

// Coerce PG rows so identity fields have .toHexString()
function coerceUser(row: any): any {
  return { ...row, identity: makeIdent(row.identity) };
}

function coerceMessage(row: any): any {
  return { ...row, sender: makeIdent(row.sender) };
}

function coerceSession(row: any): any {
  return {
    ...row,
    caller: makeIdent(row.caller),
    callee: makeIdent(row.callee),
  };
}

function applySettingsRow(row: any): void {
  if (!row) return;
  const id = Number(row.id);
  if (id !== 1) return;

  const s: MediaSettings = {
    id: 1,
    audio_target_sample_rate: Number(row.audio_target_sample_rate),
    audio_frame_ms: Number(row.audio_frame_ms),
    audio_max_frame_bytes: Number(row.audio_max_frame_bytes),
    audio_talking_rms_threshold: Number(row.audio_talking_rms_threshold),
  };

  // Validate all fields are finite numbers
  for (const [k, v] of Object.entries(s)) {
    if (k === 'id') continue;
    if (!Number.isFinite(v)) {
      connectionError.set(`media_settings.${k} is not a valid number: ${v}`);
      mediaSettingsStore.set(null);
      return;
    }
  }

  mediaSettingsStore.set(s);
  connectionError.set(null);
}

// Snapshot and change handlers
function applySnapshot(table: string, rows: any[]): void {
  if (table === 'users') {
    usersStore.set(rows.map(coerceUser));
  } else if (table === 'chat_messages') {
    const msgs = rows.map(coerceMessage);
    msgs.sort((a, b) => {
      const ai = BigInt(a.id ?? 0);
      const bi = BigInt(b.id ?? 0);
      return ai < bi ? -1 : ai > bi ? 1 : 0;
    });
    messagesStore.set(msgs.slice(-250));
  } else if (table === 'call_sessions') {
    callSessionsStore.set(rows.map(coerceSession));
  } else if (table === 'media_settings') {
    if (rows.length > 0) {
      applySettingsRow(rows[0]);
    } else {
      mediaSettingsStore.set(null);
      connectionError.set('media_settings singleton (id=1) not found');
    }
  } else if (table === 'ai_transcripts') {
    const transcripts = rows.slice();
    transcripts.sort((a, b) => {
      const ai = BigInt(a.id ?? 0);
      const bi = BigInt(b.id ?? 0);
      return ai < bi ? -1 : ai > bi ? 1 : 0;
    });
    aiTranscriptsStore.set(transcripts);
  }
}

function applyInsert(table: string, row: any): void {
  if (table === 'users') {
    usersStore.update((u) => upsertUsers(u, coerceUser(row)));
  } else if (table === 'chat_messages') {
    messagesStore.update((m) => upsertMessage(m, coerceMessage(row)));
  } else if (table === 'call_sessions') {
    callSessionsStore.update((s) => upsertCallSession(s, coerceSession(row)));
  } else if (table === 'media_settings') {
    applySettingsRow(row);
  } else if (table === 'ai_transcripts') {
    aiTranscriptsStore.update((arr) => {
      const id = row?.id?.toString?.() ?? String(row?.id ?? '');
      if (!id) return arr;
      const idx = arr.findIndex(
        (t) => (t?.id?.toString?.() ?? String(t?.id ?? '')) === id,
      );
      let next: any[];
      if (idx === -1) next = [...arr, row];
      else {
        next = arr.slice();
        next[idx] = row;
      }
      next.sort((a, b) => {
        const ai = BigInt(a.id ?? 0);
        const bi = BigInt(b.id ?? 0);
        return ai < bi ? -1 : ai > bi ? 1 : 0;
      });
      return next;
    });
  }
}

function applyUpdate(table: string, row: any): void {
  // Same as insert for our upsert logic
  applyInsert(table, row);
}

function applyDelete(table: string, old: any): void {
  if (table === 'users') {
    usersStore.update((u) => removeUser(u, old?.identity ?? ''));
  } else if (table === 'chat_messages') {
    const id = old?.id?.toString?.() ?? String(old?.id ?? '');
    messagesStore.update((m) =>
      m.filter((msg) => (msg.id?.toString?.() ?? String(msg.id ?? '')) !== id),
    );
  } else if (table === 'call_sessions') {
    callSessionsStore.update((s) => removeCallSession(s, old));
    // If the deleted session is the active call, tear it down
    const active = get(activeCallStore);
    if (active && sessionIdStr(active) === sessionIdStr(old)) {
      activeCallStore.set(null);
      stopCallRuntime();
    }
  } else if (table === 'media_settings') {
    if (Number(old?.id) === 1) {
      mediaSettingsStore.set(null);
      connectionError.set('media_settings singleton (id=1) was deleted');
    }
  } else if (table === 'ai_transcripts') {
    const id = old?.id?.toString?.() ?? String(old?.id ?? '');
    aiTranscriptsStore.update((arr) =>
      arr.filter((t) => (t?.id?.toString?.() ?? String(t?.id ?? '')) !== id),
    );
  }
}

// Incoming message handler
function handleIncoming(buf: ArrayBuffer): void {
  const view = new DataView(buf);
  if (buf.byteLength < 1) return;
  const tag = view.getUint8(0);

  if (tag === 0x00) {
    // JSON control message
    let msg: any;
    try {
      msg = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 1)));
    } catch {
      return;
    }
    handleControlMessage(msg);
    return;
  }

  if (tag === 0x01 && buf.byteLength >= 5) {
    // Binary audio frame
    const headerLen = view.getUint32(1, false);
    if (buf.byteLength < 5 + headerLen) return;

    let header: any;
    try {
      header = JSON.parse(
        new TextDecoder().decode(new Uint8Array(buf, 5, headerLen)),
      );
    } catch {
      return;
    }
    const payload = new Uint8Array(buf, 5 + headerLen);

    handleAudioEvent({
      session_id: header.session_id,
      from: makeIdent(header.from),
      seq: header.seq,
      sample_rate: header.sample_rate,
      channels: header.channels,
      rms: header.rms,
      pcm16le: payload,
    });
  }
}

function handleControlMessage(msg: any): void {
  if (msg.type === 'identity') {
    const RELAY_URI = import.meta.env.VITE_RELAY_URI as string;
    const TOKEN_KEY = `${RELAY_URI}/auth_token`;
    localStorage.setItem(TOKEN_KEY, msg.token);
    identityStore.set(makeIdent(msg.identity));
    return;
  }

  if (msg.type === 'snapshot') {
    applySnapshot(msg.table, msg.rows ?? []);
    return;
  }

  if (msg.type === 'insert') {
    applyInsert(msg.table, msg.row);
    return;
  }

  if (msg.type === 'update') {
    applyUpdate(msg.table, msg.row);
    return;
  }

  if (msg.type === 'delete') {
    applyDelete(msg.table, msg.old);
    return;
  }

  if (msg.type === 'error') {
    actionError.set(`${msg.req_type}: ${msg.message}`);
    return;
  }

  if (msg.type === 'ack') {
    // Clear action error on successful ack
    actionError.set(null);
    return;
  }
}

// Connection
let _ws: WebSocket | null = null;
let started = false;

export function connectRelay(): void {
  if (!browser || started) return;
  started = true;

  const RELAY_URI = import.meta.env.VITE_RELAY_URI as string | undefined;
  if (!RELAY_URI) {
    connectionError.set('Missing VITE_RELAY_URI env var');
    started = false;
    return;
  }

  const TOKEN_KEY = `${RELAY_URI}/auth_token`;
  const savedToken = localStorage.getItem(TOKEN_KEY) ?? undefined;

  const url = savedToken ? `${RELAY_URI}?token=${savedToken}` : RELAY_URI;
  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';
  _ws = socket;

  const conn: RelayConn = {
    sendBinaryFrame(buf: ArrayBuffer) {
      if (socket.readyState === WebSocket.OPEN) socket.send(buf);
    },
    sendControl(obj: object) {
      if (socket.readyState === WebSocket.OPEN)
        socket.send(buildControlFrame(obj));
    },
  };

  socket.onopen = () => {
    connStore.set(conn);
    isConnected.set(true);
    connectionError.set(null);
  };

  socket.onclose = (ev) => {
    isConnected.set(false);
    connStore.set(null);
    identityStore.set(null);
    incomingCallStore.set(null);
    activeCallStore.set(null);
    mediaSettingsStore.set(null);
    stopCallRuntime();
    if (ev.code !== 1000) {
      connectionError.set(`Disconnected: ${ev.reason || ev.code}`);
    }
    started = false;
    _ws = null;
  };

  socket.onerror = () => {
    connectionError.set('WebSocket connection error');
  };

  socket.onmessage = (ev: MessageEvent) => {
    if (ev.data instanceof ArrayBuffer) {
      handleIncoming(ev.data);
    }
  };
}

// Action wrappers — same signatures as original
export function sendChat(text: string): void {
  const conn = get(connStore);
  if (!conn) return;
  conn.sendControl({ type: 'send_message', text });
}

export function setNickname(nickname: string): void {
  const conn = get(connStore);
  if (!conn) return;
  conn.sendControl({ type: 'set_nickname', nickname });
}

export function requestCall(target: any): void {
  const conn = get(connStore);
  if (!conn) return;

  if (!get(mediaSettingsStore)) {
    actionError.set(
      'Cannot place call: media_settings singleton (id=1) not loaded',
    );
    return;
  }

  const targetHex = identityHex(target);
  conn.sendControl({ type: 'request_call', target: targetHex });
}

export function acceptCall(sessionId: any): void {
  const conn = get(connStore);
  if (!conn) return;
  const sid = sessionId?.toString?.() ?? String(sessionId ?? '');
  conn.sendControl({ type: 'accept_call', session_id: sid });
}

export function declineCall(sessionId: any): void {
  const conn = get(connStore);
  if (!conn) return;
  const sid = sessionId?.toString?.() ?? String(sessionId ?? '');
  conn.sendControl({ type: 'decline_call', session_id: sid });
}

export function endCall(sessionId: any): void {
  const conn = get(connStore);
  if (!conn) return;
  const sid = sessionId?.toString?.() ?? String(sessionId ?? '');
  conn.sendControl({ type: 'end_call', session_id: sid });
}
