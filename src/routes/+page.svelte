<script lang="ts">
  import { onMount, tick } from 'svelte';
  import {
    connectRelay,
    isConnected,
    connectionError,
    actionError,
    identityStore,
    usersStore,
    messagesStore,
    callSessionsStore,
    incomingCallStore,
    activeCallStore,
    sendChat,
    requestCall,
    acceptCall,
    declineCall,
    endCall,
    setNickname,
    shortHex,
    identityHex,
    connStore,
    aiTranscriptsStore
  } from '$lib/relay';
  import { startCallRuntime, stopCallRuntime, remoteTalking } from '$lib/callRuntime';

  let messageText = '';
  let nicknameText = '';

  let messagesEl: HTMLDivElement | null = null;
  let lastScrollKey = '';

  type MenuState = { open: boolean; x: number; y: number; target: any | null };
  let menu: MenuState = { open: false, x: 0, y: 0, target: null };

  function closeMenu() {
    menu = { open: false, x: 0, y: 0, target: null };
  }

  function msgKey(m: any): string {
    const id = m?.id;
    return id?.toString?.() ?? String(id ?? crypto.randomUUID());
  }

  function sessionIdOf(sess: any): string {
    const id = sess?.session_id ?? sess?.sessionId;
    return id?.toString?.() ?? String(id ?? '');
  }

  function tagLower(v: any): string {
    if (!v) return '';
    if (typeof v === 'string') return v.toLowerCase();
    if (typeof v === 'object') {
      if (typeof v.tag === 'string') return v.tag.toLowerCase();
      const keys = Object.keys(v);
      if (keys.length === 1) return keys[0].toLowerCase();
    }
    return String(v).toLowerCase();
  }

  function stateTag(sess: any): string {
    return tagLower(sess?.state);
  }

  function answeredAtField(sess: any) {
    return sess?.answered_at ?? sess?.answeredAt;
  }

  function isOptionNone(v: any): boolean {
    if (v == null) return true;
    const t = tagLower(v);
    if (t === 'none') return true;
    if (typeof v === 'object') {
      const keys = Object.keys(v);
      if (keys.length === 1 && keys[0].toLowerCase() === 'none') return true;
    }
    return false;
  }

  function isOptionSome(v: any): boolean {
    if (v == null) return false;
    const t = tagLower(v);
    if (t === 'some') return true;
    if (typeof v === 'object') {
      const keys = Object.keys(v);
      if (keys.length === 1 && keys[0].toLowerCase() === 'some') return true;
    }
    return false;
  }

  function isUnanswered(sess: any): boolean {
    return isOptionNone(answeredAtField(sess));
  }

  function isAnswered(sess: any): boolean {
    return isOptionSome(answeredAtField(sess));
  }

  function findUserByIdentity(identity: any) {
    const hex = identity?.toHexString?.() ?? '';
    return ($usersStore ?? []).find((u) => (u.identity?.toHexString?.() ?? '') === hex) ?? null;
  }

  function displayUser(u: any) {
    const nick = (u.nickname ?? '').trim();
    if (nick) return nick;
    return shortHex(u.identity);
  }

  function displayIdentity(identity: any) {
    const u = findUserByIdentity(identity);
    return u ? displayUser(u) : shortHex(identity);
  }

  function isAiUser(u: any): boolean {
    return u?.is_ai === true || u?.is_ai === 't';
  }

  function isPeerAI(sess: any): boolean {
    const meHex = identityHex($identityStore);
    const peerIdentity = identityHex(sess.caller) === meHex ? sess.callee : sess.caller;
    const peerHex = identityHex(peerIdentity);
    const user = ($usersStore ?? []).find((u) => identityHex(u.identity) === peerHex);
    return user ? isAiUser(user) : false;
  }

  $: activeCallTranscripts = ($aiTranscriptsStore ?? []).filter((t) => {
    if (!$activeCallStore) return false;
    const sid = sessionIdOf($activeCallStore);
    return t.session_id === sid || t.session_id?.toString?.() === sid;
  });

  let transcriptEl: HTMLDivElement | null = null;
  let lastTranscriptKey = '';

  $: {
    const transcripts = activeCallTranscripts;
    const key = transcripts.length ? (transcripts[transcripts.length - 1]?.id?.toString?.() ?? String(transcripts.length)) : '';
    if (transcriptEl && key && key !== lastTranscriptKey) {
      lastTranscriptKey = key;
      tick().then(() => {
        if (transcriptEl) transcriptEl.scrollTop = transcriptEl.scrollHeight;
      });
    }
  }

  function openMenu(e: MouseEvent, u: any) {
    e.preventDefault();
    const myHex = identityHex($identityStore);
    const targetHex = identityHex(u.identity);
    if (!myHex || myHex === targetHex) return;
    menu = { open: true, x: e.clientX, y: e.clientY, target: u };
  }

  async function call() {
    if (!menu.target) return;
    try {
      await requestCall(menu.target.identity);
    } catch (e) {
      console.error('requestCall failed', e);
    } finally {
      closeMenu();
    }
  }

  function recomputeCallUi() {
    const me = $identityStore;
    if (!me) return;

    const meHex = me.toHexString();
    const sessions = $callSessionsStore ?? [];

    const incoming =
      sessions.find((s) => (s.callee?.toHexString?.() ?? '') === meHex && isUnanswered(s)) ?? null;

    incomingCallStore.set(incoming);

    const active =
      sessions.find((s) => {
        const callerHex = s.caller?.toHexString?.() ?? '';
        const calleeHex = s.callee?.toHexString?.() ?? '';
        const amParticipant = callerHex === meHex || calleeHex === meHex;
        if (!amParticipant) return false;

        if (isAnswered(s)) return true;
        return stateTag(s) === 'active';
      }) ?? null;

    const prev = $activeCallStore;
    if (sessionIdOf(prev) !== sessionIdOf(active)) {
      activeCallStore.set(active);
      if (!active) {
        stopCallRuntime();
      } else {
        const conn = $connStore;
        if (conn) startCallRuntime(active, conn, me);
      }
    }
  }

  $: {
    $identityStore;
    $callSessionsStore;
    $connStore;
    recomputeCallUi();
  }

  function onSend() {
    const t = messageText.trim();
    if (!t) return;
    void sendChat(t);
    messageText = '';
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  }

  function setNick() {
    const t = nicknameText.trim();
    if (!t) return;
    void setNickname(t);
    nicknameText = '';
  }

  function acceptIncoming(sess: any) {
    const id = sess?.session_id ?? sess?.sessionId;
    acceptCall(id);
    incomingCallStore.set(null);
  }

  function declineIncoming(sess: any) {
    const id = sess?.session_id ?? sess?.sessionId;
    declineCall(id);
    incomingCallStore.set(null);
  }

  function hangup(sess: any) {
    const id = sess?.session_id ?? sess?.sessionId;
    endCall(id);
    activeCallStore.set(null);
    stopCallRuntime();
  }

  onMount(() => {
    connectRelay();
    const onWindowClick = () => closeMenu();
    window.addEventListener('click', onWindowClick);
    return () => window.removeEventListener('click', onWindowClick);
  });

  $: {
    const msgs = $messagesStore ?? [];
    const key = msgs.length ? (msgs[msgs.length - 1]?.id?.toString?.() ?? String(msgs.length)) : '';
    if (messagesEl && key && key !== lastScrollKey) {
      lastScrollKey = key;
      tick().then(() => {
        if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
      });
    }
  }
</script>

<div class="app" on:keydown={onKeyDown}>
  <header class="topbar">
    <div class="brand">SpaceChatDB</div>
    <div class="status">
      {#if $isConnected}
        <span class="pill ok">Connected</span>
        <span class="mono">{shortHex($identityStore)}</span>
      {:else}
        <span class="pill warn">Connecting…</span>
      {/if}
      {#if $connectionError}
        <span class="pill err">{$connectionError}</span>
      {/if}
      {#if $actionError}
        <span class="pill err">{$actionError}</span>
      {/if}
    </div>
  </header>

  <div class="content">
    <section class="chat">
      <div class="chatHeader">
        <div class="title">Chat</div>
        <div class="nick">
          <input class="input" placeholder="set nickname" bind:value={nicknameText} />
          <button class="btn" on:click={setNick}>Set</button>
        </div>
      </div>

      <div class="messages" bind:this={messagesEl}>
        {#each $messagesStore as m (msgKey(m))}
          <div class="msg">
            <div class="meta">
              <span class="who">{displayIdentity(m.sender)}</span>
              <span class="mono id">{m.sender?.toHexString?.()?.slice(0, 10)}…</span>
            </div>
            <div class="text">{m.text}</div>
          </div>
        {/each}
      </div>

      <div class="composer">
        <input class="input grow" placeholder="type a message…" bind:value={messageText} />
        <button class="btn" on:click={onSend}>Send</button>
      </div>
    </section>

    <aside class="users">
      <div class="title">Users ({$usersStore.length})</div>
      <div class="userList">
        {#each $usersStore as u (u.identity?.toHexString?.())}
          <div
            class="userRow"
            class:me={identityHex($identityStore) === identityHex(u.identity)}
            on:contextmenu={(e) => openMenu(e, u)}
          >
            <div class="name">{displayUser(u)}{#if isAiUser(u)} <span class="pill ai">AI</span>{/if}</div>
            <div class="mono sub">{shortHex(u.identity)}</div>
          </div>
        {/each}
      </div>
    </aside>
  </div>

  {#if menu.open}
    <div class="contextMenu" style="left:{menu.x}px; top:{menu.y}px;">
      <button class="menuBtn" on:click={() => void call()}>Call</button>
    </div>
  {/if}

  {#if $incomingCallStore}
    <div class="modalBackdrop">
      <div class="modal">
        <div class="modalTitle">Incoming call</div>
        <div class="modalBody">
          From: <span class="mono">{displayIdentity($incomingCallStore.caller)}</span>
        </div>
        <div class="modalActions">
          <button class="btn" on:click={() => acceptIncoming($incomingCallStore)}>Accept</button>
          <button class="btn danger" on:click={() => declineIncoming($incomingCallStore)}>Decline</button>
        </div>
      </div>
    </div>
  {/if}

  {#if $activeCallStore}
    <div class="callBar">
      <div class="callInfo">
        <div class="callTitle">
          Call with
          {#if identityHex($identityStore) === identityHex($activeCallStore.caller)}
            {displayIdentity($activeCallStore.callee)}
          {:else}
            {displayIdentity($activeCallStore.caller)}
          {/if}
        </div>

        <div class="talk">
          Remote:
          {#if $remoteTalking}
            <span class="pill ok">talking</span>
          {:else}
            <span class="pill">silent</span>
          {/if}
        </div>
      </div>

      <div class="callActions">
        <button class="btn danger" on:click={() => hangup($activeCallStore)}>End</button>
      </div>
    </div>

    {#if isPeerAI($activeCallStore) && activeCallTranscripts.length > 0}
      <div class="transcriptPanel" bind:this={transcriptEl}>
        {#each activeCallTranscripts as t (t.id)}
          <div class="transcript {t.role}">
            <span class="transcriptRole">{t.role === 'human' ? 'You' : 'AI'}</span>
            <span class="transcriptText">{t.text}</span>
          </div>
        {/each}
      </div>
    {/if}

  {/if}
</div>

<style>
  /* unchanged styles (keep what you already have) */
  .app { height: 100vh; display: flex; flex-direction: column; font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; background: #0b0d12; color: #e9eefc; }
  .topbar { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid #1b2230; background: #0b0d12; }
  .brand { font-weight: 700; letter-spacing: 0.2px; }
  .status { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 12px; opacity: 0.9; }
  .pill { display: inline-flex; padding: 4px 8px; border-radius: 999px; background: #141a25; border: 1px solid #1b2230; font-size: 12px; }
  .pill.ok { border-color: #1f6f3b; background: #0f1d15; }
  .pill.warn { border-color: #6a5a1c; background: #16140c; }
  .pill.err { border-color: #7b2a2a; background: #1d0f0f; }
  .content { flex: 1; display: grid; grid-template-columns: 1fr 280px; gap: 12px; padding: 12px; min-height: 0; }
  .chat, .users { border: 1px solid #1b2230; background: #0f121a; border-radius: 12px; min-height: 0; display: flex; flex-direction: column; }
  .chatHeader { display: flex; justify-content: space-between; align-items: center; padding: 10px 10px; border-bottom: 1px solid #1b2230; }
  .title { font-weight: 600; }
  .nick { display: flex; gap: 8px; align-items: center; }
  .messages { flex: 1; overflow: auto; padding: 10px; display: flex; flex-direction: column; gap: 10px; }
  .msg { border: 1px solid #1b2230; background: #0b0d12; border-radius: 10px; padding: 8px 10px; }
  .meta { display: flex; gap: 8px; align-items: baseline; }
  .who { font-weight: 600; }
  .id { opacity: 0.7; }
  .text { margin-top: 4px; white-space: pre-wrap; word-break: break-word; }
  .composer { display: flex; gap: 8px; padding: 10px; border-top: 1px solid #1b2230; }
  .input { background: #0b0d12; border: 1px solid #1b2230; color: #e9eefc; border-radius: 10px; padding: 10px 10px; outline: none; width: 180px; }
  .input.grow { flex: 1; width: auto; }
  .btn { background: #192238; border: 1px solid #253150; color: #e9eefc; border-radius: 10px; padding: 10px 12px; cursor: pointer; }
  .btn:hover { filter: brightness(1.1); }
  .btn.danger { background: #2a1420; border-color: #4a1e31; }
  .users .title { padding: 10px; border-bottom: 1px solid #1b2230; }
  .userList { overflow: auto; padding: 6px; display: flex; flex-direction: column; gap: 6px; }
  .userRow { padding: 10px; border-radius: 10px; border: 1px solid #1b2230; background: #0b0d12; cursor: context-menu; }
  .userRow.me { opacity: 0.7; cursor: default; }
  .userRow:hover { filter: brightness(1.08); }
  .name { font-weight: 600; }
  .sub { opacity: 0.7; margin-top: 2px; }
  .contextMenu { position: fixed; z-index: 50; border: 1px solid #1b2230; background: #0b0d12; border-radius: 10px; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.35); }
  .menuBtn { display: block; width: 100%; text-align: left; padding: 10px 12px; background: transparent; border: none; color: #e9eefc; cursor: pointer; }
  .menuBtn:hover { background: #141a25; }
  .modalBackdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 60; display: flex; align-items: center; justify-content: center; }
  .modal { width: 360px; border: 1px solid #1b2230; background: #0b0d12; border-radius: 14px; padding: 14px; }
  .modalTitle { font-weight: 700; margin-bottom: 8px; }
  .modalBody { opacity: 0.9; margin-bottom: 12px; }
  .modalActions { display: flex; gap: 8px; justify-content: flex-end; }
  .callBar { position: fixed; left: 12px; right: 12px; bottom: 12px; z-index: 55; display: flex; justify-content: space-between; align-items: center; border: 1px solid #1b2230; background: #0b0d12; border-radius: 14px; padding: 12px 12px; gap: 12px; }
  .pill.ai { border-color: #4a6fa5; background: #0f1a2d; font-size: 11px; padding: 2px 6px; vertical-align: middle; }
  .transcriptPanel { position: fixed; left: 12px; right: 12px; bottom: 86px; max-height: 280px; z-index: 53; overflow: auto; border: 1px solid #1b2230; background: #0f121a; border-radius: 14px; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
  .transcript { padding: 8px 10px; border-radius: 10px; border: 1px solid #1b2230; background: #0b0d12; }
  .transcript.assistant { border-color: #1a3a5c; background: #0c1420; }
  .transcriptRole { font-weight: 600; margin-right: 8px; font-size: 12px; opacity: 0.7; text-transform: uppercase; }
  .transcriptText { white-space: pre-wrap; word-break: break-word; }
</style>