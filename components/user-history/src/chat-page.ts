import { createHash } from 'node:crypto';

const css = `
:root { color-scheme: light; font: 15px/1.6 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #242424; background: #fff; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin: 0; }
button, input, textarea { font: inherit; }
button { cursor: pointer; color: inherit; }
button:disabled { cursor: default; opacity: .45; }
button:focus-visible, input:focus-visible, textarea:focus-visible, summary:focus-visible { outline: 2px solid #555; outline-offset: 3px; }
button { border: 0; }
.app { display: grid; grid-template-columns: 264px minmax(0, 1fr); height: 100vh; height: 100dvh; overflow: hidden; }
.app[data-sidebar-open="false"] { grid-template-columns: 0 minmax(0, 1fr); }
.sidebar { display: flex; flex-direction: column; min-height: 0; padding: 20px 12px 14px; background: #f7f7f5; border-right: 1px solid #ececea; }
.brand-row { display: flex; justify-content: space-between; align-items: center; margin: 0 8px 22px; gap: 8px; }
.brand { font-size: 1rem; font-weight: 650; }
.quiet-button { padding: 6px 10px; border-radius: 8px; background: transparent; font-size: .8125rem; white-space: nowrap; }
.quiet-button:hover:not(:disabled) { background: #eaeae7; }
.view-toggle { display: flex; padding: 3px; border: 1px solid #e4e4e0; border-radius: 10px; margin-bottom: 12px; }
.view-toggle button { flex: 1; border-radius: 7px; padding: 6px; background: transparent; font-size: .875rem; }
.view-toggle button[aria-pressed="true"] { background: #fff; box-shadow: 0 1px 3px #0000000d; }
.search { width: 100%; min-width: 0; padding: 9px 11px; border: 1px solid #e2e2de; background: transparent; border-radius: 9px; font-size: .875rem; }
.list-heading { margin: 22px 10px 8px; font-size: .75rem; color: #71716c; font-weight: 500; }
.session-list { flex: 1; min-height: 0; overflow: auto; padding: 0; margin: 0; list-style: none; }
.session-button { width: 100%; text-align: left; background: transparent; padding: 10px 12px; border-radius: 9px; margin: 2px 0; }
.session-button:hover { background: #efefeb; }
.session-button[aria-current="true"] { background: #e9e9e5; }
.session-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .875rem; }
.session-meta { display: block; color: #73736d; font-size: .75rem; margin-top: 2px; overflow-wrap: anywhere; }
.list-notice { padding: 8px 10px; color: #71716c; font-size: .8125rem; }
.list-error { margin: 8px 0; padding: 8px 10px; border-radius: 8px; background: #fff; font-size: .8125rem; }
.list-error p { margin: 0 0 4px; overflow-wrap: anywhere; }
.sidebar-footer { border-top: 1px solid #e5e5e0; padding: 12px 6px 0; margin-top: 12px; }
.sidebar-footer p { margin: 4px 4px 0; font-size: .75rem; color: #777770; }
.chat { display: grid; grid-template-rows: auto auto minmax(0, 1fr) auto; min-width: 0; min-height: 0; }
.chat-header { grid-row: 1; display: flex; align-items: center; gap: 14px; padding: 16px 24px; border-bottom: 1px solid #f0f0ef; min-height: 77px; }
.chat-title { min-width: 0; flex: 1; }
.chat-title h1 { margin: 0; font-size: 1rem; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.header-status { font-size: .75rem; color: #777; margin: 2px 0 0; overflow-wrap: anywhere; }
.queue { font-size: .75rem; color: #666; white-space: nowrap; background: #f4f4f2; padding: 4px 9px; border-radius: 99px; }
.connection-banner { grid-row: 2; display: flex; align-items: center; gap: 12px; padding: 10px 24px; background: #fff7e9; font-size: .8125rem; }
.connection-banner p { margin: 0; flex: 1; overflow-wrap: anywhere; }
.conversation { grid-row: 3; min-height: 0; overflow: auto; overscroll-behavior: contain; scroll-behavior: auto; }
.transcript { max-width: 49rem; margin: 0 auto; padding: 36px 28px 24px; overflow-wrap: anywhere; }
.empty-state { padding: 16vh 0 48px; text-align: center; color: #777; }
.empty-state h2 { color: #333; font-size: 1.25rem; font-weight: 500; margin: 0 0 10px; }
.empty-state p { font-size: .875rem; margin: 0; }
.composer-region { grid-row: 4; padding: 8px 28px 18px; background: #fff; }
.composer-wrap { max-width: 46rem; margin: auto; }
.latest-row { display: flex; justify-content: center; height: 0; position: relative; }
.latest-button { position: absolute; bottom: 12px; border: 1px solid #ddd; border-radius: 99px; padding: 6px 14px; background: #fff; box-shadow: 0 2px 8px #0000000a; font-size: .8125rem; }
.composer { padding: 12px 12px 10px 18px; background: #f7f7f7; border: 1px solid #e6e6e6; border-radius: 24px; }
.composer:focus-within { border-color: #b6b6b6; }
.composer textarea { display: block; width: 100%; resize: vertical; min-height: 52px; max-height: 180px; border: 0; outline: none; background: transparent; padding: 2px 4px 8px 0; font-size: 1rem; line-height: 1.55; color: #222; }
.composer textarea:focus-visible { outline: none; }
.composer textarea:disabled { color: #777; }
.composer-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.composer-target { min-width: 0; color: #777; font-size: .75rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.send-button { display: grid; place-items: center; width: 34px; height: 34px; flex-shrink: 0; border-radius: 50%; background: #242424; color: #fff; font-size: 1.35rem; line-height: 1; }
.composer-help { margin: 8px 0 0; text-align: center; color: #808080; font-size: .6875rem; }
.send-notice { font-size: .8125rem; margin: 8px 2px 0; color: #63635e; overflow-wrap: anywhere; }
.send-notice[data-kind="error"] { color: #9c3024; }
.pair { margin: 0 0 42px; }
.question { width: fit-content; max-width: 85%; margin-left: auto; padding: 12px 20px; border-radius: 23px; background: #f3f3f3; overflow-wrap: anywhere; }
.question + .question { margin-top: 12px; }
.response { min-width: 0; margin-top: 26px; }
.response + .question { margin-top: 36px; }
.block { min-width: 0; margin: 16px 0; overflow-wrap: anywhere; }
.block > :first-child, .skill-body > :first-child { margin-top: 0; }
.block > :last-child, .skill-body > :last-child, .question > :last-child { margin-bottom: 0; }
.question > .block:first-of-type { margin-top: 0; }
.block p, .skill-body p { margin: 0 0 1em; }
.block :is(h1, h2, h3, h4, h5, h6), .skill-body :is(h1, h2, h3, h4, h5, h6) { font-weight: 600; line-height: 1.35; margin: 1.5em 0 .65em; }
.block h1, .skill-body h1 { font-size: 1.5rem; }
.block h2, .skill-body h2 { font-size: 1.25rem; }
.block :is(h3, h4, h5, h6), .skill-body :is(h3, h4, h5, h6) { font-size: 1.0625rem; }
.block :is(ul, ol), .skill-body :is(ul, ol) { margin: .75em 0 1em; padding-left: 1.5em; }
.block li, .skill-body li { margin: .35em 0; }
.block li > p, .skill-body li > p { margin: .5em 0; }
pre { max-width: 100%; overflow-x: auto; padding: 16px; background: #f6f6f6; border-radius: 12px; line-height: 1.5; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .875em; }
:not(pre) > code { background: #f0f0f0; padding: .15em .3em; border-radius: 4px; }
pre code { overflow-wrap: normal; }
table { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; font-size: .9375rem; margin: 1em 0; }
th, td { border-bottom: 1px solid #e5e5e5; padding: 10px 14px; text-align: left; }
blockquote { border-left: 3px solid #ddd; padding-left: 16px; color: #666; margin: 1em 0; }
hr { border: 0; border-top: 1px solid #e5e5e5; margin: 24px 0; }
.transcript details { min-width: 0; margin-top: 16px; }
.transcript summary { width: fit-content; max-width: 100%; cursor: pointer; color: #666; font-size: .875rem; }
.transcript details[open] > summary { margin-bottom: 12px; }
.skill-body { margin-top: 12px; padding-left: 16px; border-left: 2px solid #ddd; overflow-wrap: anywhere; }
.inert-url, .attachment, .missing, .notice { color: #777; overflow-wrap: anywhere; }
.attachment, .missing, .notice { font-size: .875rem; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
.sidebar-backdrop { display: none; }
@media (max-width: 760px) {
  .app, .app[data-sidebar-open="false"] { grid-template-columns: minmax(0, 1fr); }
  .sidebar { position: fixed; inset: 0 auto 0 0; width: min(300px, 85vw); z-index: 3; }
  .sidebar-backdrop:not([hidden]) { display: block; position: fixed; inset: 0; background: #0005; z-index: 2; }
  .chat-header { padding: 12px 14px; gap: 8px; min-height: 70px; }
  .transcript { padding: 24px 18px 20px; }
  .question { max-width: 92%; padding: 12px 16px; }
  .composer-region { padding: 6px 12px max(10px, env(safe-area-inset-bottom)); }
  .composer-help { font-size: .625rem; }
  .connection-banner { padding: 8px 14px; }
  .queue { max-width: 90px; overflow: hidden; text-overflow: ellipsis; }
}
`;

const script = String.raw`
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const app = $('app');
  const sidebar = $('sidebar');
  const sidebarToggle = $('sidebar-toggle');
  const backdrop = $('sidebar-backdrop');
  const list = $('session-list');
  const search = $('session-search');
  const title = $('session-title');
  const status = $('session-status');
  const queue = $('queue-count');
  const scroller = $('conversation');
  const transcript = $('transcript');
  const composer = $('message');
  const send = $('send');
  const sendNotice = $('send-notice');
  const banner = $('connection-banner');
  const bannerText = $('connection-text');
  const retry = $('retry-session');
  const latest = $('latest');
  const closeButton = $('close-chat');
  const csrfToken = document.body.dataset.chatToken;
  let selectedId = document.body.dataset.initialSessionId || '';
  let selected = null;
  let sessions = [];
  let view = 'session';
  let initialView = true;
  let generation = 0;
  let sessionRequest = null;
  let listRequest = null;
  let sessionTimer;
  let listTimer;
  let loaded = false;
  let connected = false;
  let closed = false;
  let suspended = false;
  let closing = false;
  let followingBottom = true;
  let lastHtml = null;
  let listLoaded = false;
  let composing = false;
  const drafts = new Map();
  const deliveries = new Map();

  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  function parseSession(value) {
    if (!isObject(value) || typeof value.id !== 'string' || !value.id || typeof value.name !== 'string' || typeof value.status !== 'string' || typeof value.writable !== 'boolean' || typeof value.html !== 'string' || !Number.isSafeInteger(value.queueCount) || value.queueCount < 0) throw new Error('The chat server returned an invalid session.');
    return value;
  }
  function parseList(value) {
    if (!isObject(value) || !Array.isArray(value.sessions) || typeof value.initialSessionId !== 'string') throw new Error('The chat server returned an invalid session list.');
    const ids = new Set();
    for (const item of value.sessions) {
      if (!isObject(item) || typeof item.id !== 'string' || !item.id || ids.has(item.id) || typeof item.name !== 'string' || typeof item.status !== 'string' || typeof item.writable !== 'boolean' || !['session', 'agent'].includes(item.kind) || (item.parentId !== undefined && typeof item.parentId !== 'string')) throw new Error('The chat server returned an invalid session list.');
      ids.add(item.id);
    }
    return value;
  }
  async function request(path, options, controller) {
    const timeout = setTimeout(() => controller.abort(), 35000);
    try {
      const response = await fetch(path, { ...options, signal: controller.signal, mode: 'same-origin', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
      const body = await response.json();
      if (!response.ok) throw new Error(isObject(body) && typeof body.error === 'string' ? body.error : 'The chat server returned HTTP ' + response.status + '.');
      return body;
    } finally { clearTimeout(timeout); }
  }
  function errorText(error) {
    if (error instanceof Error && error.name !== 'AbortError' && error.name !== 'TypeError') return error.message;
    return 'Cannot reach the local chat server.';
  }
  function setSidebar(open) {
    app.dataset.sidebarOpen = String(open);
    sidebar.hidden = !open;
    sidebarToggle.setAttribute('aria-expanded', String(open));
    backdrop.hidden = !open;
  }
  function hideMobileSidebar() {
    if (matchMedia('(max-width: 760px)').matches) setSidebar(false);
  }
  function showBanner(message, allowRetry) {
    banner.hidden = !message;
    bannerText.textContent = message;
    retry.hidden = !allowRetry;
  }
  function emptyTranscript(heading, message) {
    const box = document.createElement('div');
    box.className = 'empty-state';
    const h = document.createElement('h2');
    h.textContent = heading;
    const p = document.createElement('p');
    p.textContent = message;
    box.append(h, p);
    transcript.replaceChildren(box);
  }
  function writable() {
    return selected !== null && selected.id === selectedId && selected.writable && !sessions.some(item => item.id === selectedId && !item.writable);
  }
  function updateComposer() {
    const delivery = deliveries.get(selectedId);
    const pending = delivery !== undefined && delivery.kind === 'pending';
    const ready = !closed && !suspended && !closing && loaded && connected && navigator.onLine && writable();
    composer.disabled = !ready || pending;
    send.disabled = composer.disabled || !composer.value.trim();
    closeButton.disabled = closed || suspended || closing || Array.from(deliveries.values()).some(item => item.kind === 'pending');
    $('composer-target').textContent = closed ? 'Chat closed' : selected ? 'To ' + (selected.name || 'Untitled session') : 'Choose a session';
    composer.placeholder = closed ? 'This chat is closed' : !selectedId ? 'Choose a session' : !loaded ? 'Loading session...' : !writable() ? 'This session is read-only' : !connected || !navigator.onLine ? 'Reconnect to send a message' : pending ? 'Sending message...' : 'Message Prime Agent';
    send.setAttribute('aria-label', pending ? 'Sending message' : 'Send message');
    sendNotice.hidden = !delivery;
    sendNotice.textContent = delivery ? delivery.text : '';
    sendNotice.dataset.kind = delivery ? delivery.kind : '';
  }
  function renderList() {
    const query = search.value.trim().toLocaleLowerCase();
    const items = sessions.filter(item => item.kind === view && (!query || (item.name + ' ' + item.status).toLocaleLowerCase().includes(query)));
    const focusedId = list.contains(document.activeElement) ? document.activeElement.dataset.sessionId : null;
    list.replaceChildren();
    $('list-heading').textContent = view === 'session' ? 'Sessions' : 'Agents';
    $('view-sessions').setAttribute('aria-pressed', String(view === 'session'));
    $('view-agents').setAttribute('aria-pressed', String(view === 'agent'));
    for (const item of items) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'session-button';
      button.dataset.sessionId = item.id;
      button.disabled = closed;
      button.setAttribute('aria-current', String(item.id === selectedId));
      const name = document.createElement('span');
      name.className = 'session-name';
      name.textContent = item.name || 'Untitled session';
      const meta = document.createElement('span');
      meta.className = 'session-meta';
      meta.textContent = [item.status || 'Status unknown', !item.writable ? 'Read-only' : ''].filter(Boolean).join(' · ');
      button.append(name, meta);
      button.addEventListener('click', () => selectSession(item.id));
      li.append(button);
      list.append(li);
      if (item.id === focusedId) button.focus({ preventScroll: true });
    }
    $('list-notice').hidden = items.length > 0;
    $('list-notice').textContent = !listLoaded ? 'Loading sessions...' : query ? 'No matches.' : view === 'agent' ? 'No agents available.' : 'No sessions available.';
  }
  function selectSession(id) {
    if (closed) return;
    hideMobileSidebar();
    if (id === selectedId && loaded) return;
    if (selectedId) drafts.set(selectedId, composer.value);
    selectedId = id;
    generation++;
    selected = null;
    loaded = false;
    connected = false;
    followingBottom = true;
    lastHtml = null;
    composing = false;
    composer.value = drafts.get(id) || '';
    title.textContent = sessions.find(item => item.id === id)?.name || 'Loading session';
    status.textContent = 'Loading...';
    queue.hidden = true;
    latest.hidden = true;
    showBanner('', false);
    emptyTranscript('Loading conversation', 'Reading the saved transcript.');
    renderList();
    updateComposer();
    clearTimeout(sessionTimer);
    if (sessionRequest) sessionRequest.controller.abort();
    else void refreshSession();
  }
  function atBottom() { return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80; }
  function scrollBottom() {
    scroller.scrollTop = scroller.scrollHeight;
    followingBottom = true;
    latest.hidden = true;
  }
  function renderTranscript(html) {
    if (html === lastHtml) return;
    const toBottom = !loaded || followingBottom;
    const scrollTop = scroller.scrollTop;
    const openDetails = Array.from(transcript.querySelectorAll('details')).map((item, index) => item.open ? index : -1);
    if (html.trim()) transcript.innerHTML = html;
    else emptyTranscript('No messages yet', selected && selected.writable ? 'Send a message to this session below.' : 'This session has no saved messages.');
    for (const [index, item] of Array.from(transcript.querySelectorAll('details')).entries()) if (openDetails.includes(index)) item.open = true;
    lastHtml = html;
    if (toBottom) scrollBottom();
    else { scroller.scrollTop = scrollTop; latest.hidden = atBottom(); }
  }
  async function refreshSession() {
    clearTimeout(sessionTimer);
    if (closed || suspended || sessionRequest || !selectedId) return;
    if (document.hidden || !navigator.onLine) { sessionTimer = setTimeout(refreshSession, 2000); return; }
    const current = { id: selectedId, generation, controller: new AbortController() };
    sessionRequest = current;
    try {
      const result = parseSession(await request('api/session?id=' + encodeURIComponent(current.id), {}, current.controller));
      if (closed || suspended || current.generation !== generation || current.id !== selectedId) return;
      if (result.id !== current.id) throw new Error('The chat server returned a different session.');
      selected = result;
      connected = true;
      title.textContent = result.name || 'Untitled session';
      document.title = title.textContent + ' · Prime Agent';
      status.textContent = [result.status || 'Status unknown', !writable() ? 'Read-only' : ''].filter(Boolean).join(' · ');
      queue.hidden = result.queueCount === 0;
      queue.textContent = result.queueCount + ' queued';
      renderTranscript(result.html);
      loaded = true;
      showBanner('', false);
      updateComposer();
    } catch (error) {
      if (closed || suspended || current.generation !== generation || current.id !== selectedId) return;
      connected = false;
      status.textContent = 'Disconnected';
      showBanner(errorText(error) + ' Sending is paused.', true);
      if (!loaded) emptyTranscript('Conversation unavailable', 'Retry to load this session. Your draft is kept in this tab.');
      updateComposer();
    } finally {
      sessionRequest = null;
      if (!closed && !suspended) {
        if (current.generation !== generation) void refreshSession();
        else sessionTimer = setTimeout(refreshSession, 2000);
      }
    }
  }
  async function refreshList() {
    clearTimeout(listTimer);
    if (closed || suspended || listRequest) return;
    if (document.hidden || !navigator.onLine) { listTimer = setTimeout(refreshList, 10000); return; }
    const controller = new AbortController();
    listRequest = controller;
    try {
      const result = parseList(await request('api/sessions', {}, controller));
      if (closed || suspended) return;
      sessions = result.sessions;
      listLoaded = true;
      $('list-error').hidden = true;
      if (!selectedId && result.initialSessionId) selectSession(result.initialSessionId);
      if (initialView) {
        view = sessions.find(item => item.id === selectedId)?.kind || 'session';
        initialView = false;
      }
      renderList();
      updateComposer();
      if (!selectedId) {
        title.textContent = 'Prime Agent chat';
        status.textContent = sessions.length ? 'Choose a session' : 'No sessions available';
        emptyTranscript(sessions.length ? 'Choose a session' : 'No sessions available', sessions.length ? 'Select a session or agent from the sidebar.' : 'Sessions appear here when Prime Agent makes them available.');
      }
    } catch (error) {
      if (closed || suspended) return;
      $('list-error').hidden = false;
      $('list-error-text').textContent = errorText(error);
      if (!listLoaded) $('list-notice').textContent = 'Session list unavailable.';
    } finally {
      listRequest = null;
      if (!closed && !suspended) listTimer = setTimeout(refreshList, 10000);
    }
  }
  async function sendMessage() {
    updateComposer();
    if (send.disabled || composing) return;
    const id = selectedId;
    const message = composer.value;
    const previous = deliveries.get(id);
    const requestId = previous && previous.kind === 'error' && previous.message === message ? previous.requestId : crypto.randomUUID();
    drafts.set(id, message);
    deliveries.set(id, { kind: 'pending', requestId, message, text: 'Sending to Prime Agent...' });
    updateComposer();
    const controller = new AbortController();
    try {
      const result = await request('api/message', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Chat-Token': csrfToken }, body: JSON.stringify({ sessionId: id, message, requestId }) }, controller);
      if (!isObject(result) || result.accepted !== true) throw new Error('The chat server did not confirm acceptance.');
      deliveries.set(id, { kind: 'accepted', text: 'Accepted by Prime Agent. This does not mean the work is complete.' });
      if (drafts.get(id) === message) {
        drafts.delete(id);
        if (selectedId === id) composer.value = '';
      }
      if (!closed && selectedId === id) void refreshSession();
    } catch (error) {
      deliveries.set(id, { kind: 'error', requestId, message, text: errorText(error) + ' Acceptance is not confirmed. Your draft is kept. Retrying an unchanged draft checks the same submission. Check the transcript before editing and sending a different message.' });
      if (selectedId === id) {
        connected = false;
        showBanner('Send failed or its result is unknown. Reconnect before sending again.', true);
      }
    } finally {
      updateComposer();
      if (!closed && selectedId === id && !composer.disabled) composer.focus({ preventScroll: true });
    }
  }
  function stopPolling() {
    clearTimeout(sessionTimer);
    clearTimeout(listTimer);
    if (sessionRequest) sessionRequest.controller.abort();
    if (listRequest) listRequest.abort();
  }
  async function closeChat() {
    if (closed || closing || closeButton.disabled) return;
    closing = true;
    updateComposer();
    try {
      await request('api/close', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Chat-Token': csrfToken }, body: '{}' }, new AbortController());
      closed = true;
      connected = false;
      stopPolling();
      closeButton.textContent = 'Chat closed';
      status.textContent = 'Chat closed';
      showBanner('Chat closed. Prime Agent sessions keep running. You can close this tab.', false);
      renderList();
    } catch (error) {
      connected = false;
      showBanner(errorText(error) + ' Could not confirm that chat closed.', true);
    } finally { closing = false; updateComposer(); }
  }

  sidebarToggle.addEventListener('click', () => setSidebar(sidebar.hidden));
  $('hide-sidebar').addEventListener('click', () => { setSidebar(false); sidebarToggle.focus(); });
  backdrop.addEventListener('click', () => { setSidebar(false); sidebarToggle.focus(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !sidebar.hidden && matchMedia('(max-width: 760px)').matches) { setSidebar(false); sidebarToggle.focus(); }
  });
  $('view-sessions').addEventListener('click', () => { view = 'session'; initialView = false; renderList(); });
  $('view-agents').addEventListener('click', () => { view = 'agent'; initialView = false; renderList(); });
  search.addEventListener('input', renderList);
  $('retry-list').addEventListener('click', refreshList);
  retry.addEventListener('click', refreshSession);
  closeButton.addEventListener('click', closeChat);
  scroller.addEventListener('scroll', () => { followingBottom = atBottom(); latest.hidden = followingBottom || !loaded; }, { passive: true });
  latest.addEventListener('click', scrollBottom);
  composer.addEventListener('input', () => { drafts.set(selectedId, composer.value); updateComposer(); });
  composer.addEventListener('compositionstart', () => { composing = true; });
  composer.addEventListener('compositionend', () => { composing = false; });
  composer.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !composing && event.keyCode !== 229) { event.preventDefault(); void sendMessage(); }
  });
  $('composer-form').addEventListener('submit', event => { event.preventDefault(); void sendMessage(); });
  window.addEventListener('offline', () => { if (closed) return; connected = false; showBanner('You are offline. Sending is paused. Your draft is kept.', true); updateComposer(); });
  window.addEventListener('online', () => { void refreshSession(); void refreshList(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { void refreshSession(); void refreshList(); } });
  window.addEventListener('pagehide', () => { suspended = true; stopPolling(); updateComposer(); });
  window.addEventListener('pageshow', event => {
    if (!event.persisted || closed) return;
    suspended = false;
    connected = false;
    showBanner('Reconnecting to the local chat server...', false);
    updateComposer();
    void refreshSession();
    void refreshList();
  });
  setSidebar(!matchMedia('(max-width: 760px)').matches);
  renderList();
  updateComposer();
  if (selectedId) selectSession(selectedId);
  else emptyTranscript('Choose a session', 'Loading available sessions.');
  void refreshList();
})();
`;

export const chatContentSecurityPolicy = `default-src 'none'; script-src 'sha256-${createHash('sha256').update(script).digest('base64')}'; script-src-attr 'none'; style-src 'sha256-${createHash('sha256').update(css).digest('base64')}'; style-src-attr 'none'; connect-src 'self'; img-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

export function renderChatPage({ initialSessionId, csrfToken }: { initialSessionId: string; csrfToken: string }): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeAttribute(chatContentSecurityPolicy)}"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="referrer" content="no-referrer"><title>Prime Agent chat</title><style>${css}</style></head>
<body data-initial-session-id="${escapeAttribute(initialSessionId)}" data-chat-token="${escapeAttribute(csrfToken)}">
<div id="app" class="app" data-sidebar-open="true">
<button id="sidebar-backdrop" class="sidebar-backdrop" type="button" tabindex="-1" aria-label="Hide sidebar" hidden></button>
<aside id="sidebar" class="sidebar" aria-label="Sessions and agents">
  <div class="brand-row"><span class="brand">Prime Agent</span><button id="hide-sidebar" class="quiet-button" type="button" aria-label="Hide sidebar">Hide</button></div>
  <div class="view-toggle" role="group" aria-label="Conversation type"><button id="view-sessions" type="button" aria-pressed="true">Sessions</button><button id="view-agents" type="button" aria-pressed="false">Agents</button></div>
  <label class="sr-only" for="session-search">Search sessions and agents</label><input id="session-search" class="search" type="search" placeholder="Search" autocomplete="off">
  <h2 id="list-heading" class="list-heading">Sessions</h2>
  <div id="list-error" class="list-error" role="status" hidden><p id="list-error-text"></p><button id="retry-list" type="button" class="quiet-button">Retry list</button></div>
  <p id="list-notice" class="list-notice">Loading sessions...</p><ul id="session-list" class="session-list" aria-labelledby="list-heading"></ul>
  <div class="sidebar-footer"><button id="close-chat" class="quiet-button" type="button" title="Close this local chat. Prime Agent sessions keep running.">Close chat</button><p>Local chat · Drafts stay in this tab</p></div>
</aside>
<main class="chat">
  <header class="chat-header"><button id="sidebar-toggle" class="quiet-button" type="button" aria-controls="sidebar" aria-expanded="true">Sidebar</button><div class="chat-title"><h1 id="session-title">Prime Agent chat</h1><p id="session-status" class="header-status">Connecting...</p></div><span id="queue-count" class="queue" aria-live="polite" hidden></span></header>
  <div id="connection-banner" class="connection-banner" role="status" hidden><p id="connection-text"></p><button id="retry-session" class="quiet-button" type="button">Retry</button></div>
  <div id="conversation" class="conversation" tabindex="0" role="region" aria-label="Conversation"><div id="transcript" class="transcript"><div class="empty-state"><h2>Loading conversation</h2><p>Reading the saved transcript.</p></div></div></div>
  <footer class="composer-region"><div class="composer-wrap"><div class="latest-row"><button id="latest" class="latest-button" type="button" hidden>Latest messages ↓</button></div>
    <form id="composer-form" class="composer"><label class="sr-only" for="message">Message the selected session</label><textarea id="message" rows="2" maxlength="32000" placeholder="Loading session..." aria-describedby="composer-help composer-target" autocomplete="off" disabled></textarea><div class="composer-actions"><span id="composer-target" class="composer-target">Choose a session</span><button id="send" class="send-button" type="submit" aria-label="Send message" disabled><span aria-hidden="true">↑</span></button></div></form>
    <p id="send-notice" class="send-notice" role="status" aria-live="polite" hidden></p><p id="composer-help" class="composer-help">Enter to send · Shift+Enter for a new line. Busy sessions process your message after the current turn.</p>
  </div></footer>
</main></div><noscript>This chat needs JavaScript. The read-only history snapshot works without it.</noscript><script>${script}</script></body></html>`;
}
