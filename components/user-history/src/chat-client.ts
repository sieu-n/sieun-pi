export const chatClientScript = String.raw`
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
  const modelButton = $('model-button');
  const modelPanel = $('model-panel');
  const modelSearch = $('model-search');
  const modelOptions = $('model-options');
  const modelNotice = $('model-notice');
  const modelMore = $('model-more');
  const usageButton = $('usage-button');
  const usagePanel = $('usage-panel');
  const attachButton = $('attach-button');
  const imageInput = $('image-input');
  const previews = $('attachment-previews');
  const attachmentError = $('attachment-error');
  const imageViewer = $('image-viewer');
  const imageFull = $('image-full');
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
  let modelCatalog = null;
  let showAllModels = false;
  let modelRequest = null;
  let modelMutation = null;
  let modelEpoch = 0;
  let imageFocus = null;
  const imageTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  const drafts = new Map();
  const deliveries = new Map();

  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  function isModel(value) {
    return isObject(value) && typeof value.provider === 'string' && !!value.provider && typeof value.id === 'string' && !!value.id && typeof value.name === 'string' && nonnegative(value.contextWindow) && Array.isArray(value.input) && value.input.every(input => input === 'text' || input === 'image');
  }
  function isUsage(value) {
    if (!isObject(value) || value.providerLimits !== 'unavailable') return false;
    const context = value.context;
    if (context !== null && (!isObject(context) || !nonnegative(context.contextWindow) || !(context.tokens === null || nonnegative(context.tokens)) || !(context.percent === null || nonnegative(context.percent)))) return false;
    return value.kind === 'native-session' ? nonnegative(value.inputTokens) && nonnegative(value.outputTokens) && nonnegative(value.cost) : value.kind === 'unavailable' && value.reason === 'not-recorded';
  }
  function isControls(value) {
    return isObject(value) && (value.kind === 'saved' ? value.currentModel === null && value.canChangeModel === false : value.kind === 'live' && (value.currentModel === null || isModel(value.currentModel)) && typeof value.canChangeModel === 'boolean');
  }
  function parseSession(value) {
    if (!isObject(value) || typeof value.id !== 'string' || !value.id || typeof value.name !== 'string' || typeof value.status !== 'string' || typeof value.writable !== 'boolean' || typeof value.html !== 'string' || !Number.isSafeInteger(value.queueCount) || value.queueCount < 0) throw new Error('The chat server returned an invalid session.');
    if (!isControls(value.controls) || !isUsage(value.usage)) throw new Error('The chat server returned invalid session controls.');
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
  function draftFor(id) {
    if (!drafts.has(id)) drafts.set(id, { message: '', attachments: [], error: '' });
    return drafts.get(id);
  }
  function hasPendingSend() { return Array.from(deliveries.values()).some(item => item.kind === 'pending'); }
  function supportsImages() { return selected?.controls.currentModel?.input.includes('image') === true; }
  function updateStatus() {
    status.textContent = closed || !loaded ? '' : !connected || !navigator.onLine ? 'Offline' : !writable() ? 'Read-only' : ['running', 'busy'].includes(selected.status) ? 'Running' : '';
    status.hidden = !status.textContent;
  }
  function updateComposer() {
    const delivery = deliveries.get(selectedId);
    const pending = delivery?.kind === 'pending';
    const ready = !closed && !suspended && !closing && loaded && connected && navigator.onLine && writable();
    const attachments = drafts.get(selectedId)?.attachments || [];
    composer.disabled = !ready || pending || modelMutation !== null;
    send.disabled = composer.disabled || attachments.some(item => item.kind === 'reading') || (attachments.length > 0 && !supportsImages()) || (!composer.value.trim() && !attachments.length);
    attachButton.disabled = composer.disabled || !supportsImages() || attachments.length >= 4;
    imageInput.disabled = attachButton.disabled;
    for (const button of previews.querySelectorAll('button')) button.disabled = composer.disabled;
    closeButton.disabled = closed || suspended || closing || hasPendingSend() || modelMutation?.phase === 'pending';
    $('composer-target').textContent = closed ? 'Chat closed' : selected ? 'To ' + (selected.name || 'Untitled session') : 'Choose a session';
    composer.placeholder = closed ? 'This chat is closed' : !selectedId ? 'Choose a session' : !loaded ? 'Loading...' : !writable() ? 'This session is read-only' : !connected || !navigator.onLine ? 'Reconnect to send a message' : pending ? 'Sending...' : 'Reply...';
    send.setAttribute('aria-label', pending ? 'Sending message' : 'Send message');
    sendNotice.hidden = !delivery;
    sendNotice.textContent = delivery ? delivery.text : '';
    sendNotice.dataset.kind = delivery ? delivery.kind : '';
    const imageError = drafts.get(selectedId)?.error || (attachments.length && loaded && !supportsImages() ? 'Choose a model that accepts images, or remove the images.' : '');
    attachmentError.hidden = !imageError;
    attachmentError.textContent = imageError;
    modelButton.disabled = !ready || !selected.controls.canChangeModel || hasPendingSend() || modelMutation !== null;
    $('model-label').textContent = selected?.controls.currentModel?.name || 'Model';
    modelButton.title = selected?.controls.currentModel ? selected.controls.currentModel.provider + '/' + selected.controls.currentModel.id : 'Choose a model';
    for (const button of modelOptions.querySelectorAll('button')) {
      button.disabled = modelButton.disabled || button.dataset.available !== 'true';
      button.setAttribute('aria-pressed', String(selected?.controls.currentModel?.provider === button.dataset.provider && selected?.controls.currentModel?.id === button.dataset.modelId));
    }
    usageButton.disabled = !loaded || closed || suspended;
    if (!usagePanel.hidden) renderUsage();
    updateStatus();
  }
  function renderList() {
    const query = search.value.trim().toLocaleLowerCase();
    const items = sessions.filter(item => item.kind === view && (!query || (item.name + ' ' + item.status).toLocaleLowerCase().includes(query)));
    const focusedId = list.contains(document.activeElement) ? document.activeElement.dataset.sessionId : null;
    list.replaceChildren();
    $('list-heading').textContent = view === 'session' ? 'Recent chats' : 'Agents';
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
      const state = !item.writable ? 'Read-only' : ['running', 'busy'].includes(item.status) ? 'Running' : 'Idle';
      button.setAttribute('aria-label', (item.name || 'Untitled session') + (state === 'Idle' ? '' : ', ' + state));
      meta.dataset.status = state.toLowerCase();
      meta.setAttribute('title', state);
      meta.setAttribute('aria-hidden', 'true');
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
    if (selectedId) draftFor(selectedId).message = composer.value;
    selectedId = id;
    generation++;
    selected = null;
    loaded = false;
    connected = false;
    followingBottom = true;
    lastHtml = null;
    composing = false;
    composer.value = drafts.get(id)?.message || '';
    closeModelPanel();
    closeUsagePanel();
    closeImage();
    renderAttachments();
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
    const current = { id: selectedId, generation, modelEpoch, controller: new AbortController() };
    sessionRequest = current;
    try {
      const result = parseSession(await request('api/session?id=' + encodeURIComponent(current.id), {}, current.controller));
      if (closed || suspended || current.generation !== generation || current.id !== selectedId) return;
      if (current.modelEpoch !== modelEpoch) return;
      if (result.id !== current.id) throw new Error('The chat server returned a different session.');
      selected = result;
      connected = true;
      title.textContent = result.name || 'Untitled session';
      document.title = title.textContent + ' · Prime Agent';
      if (modelMutation?.phase === 'readback') {
        if (modelMutation.id === selectedId && modelMutation.generation === generation) {
          if (modelMutation.error) modelNotice.textContent = 'Model change was not confirmed. Check the selected model before retrying.';
          else closeModelPanel();
        }
        modelMutation = null;
      }
      queue.hidden = result.queueCount === 0;
      queue.textContent = result.queueCount + ' queued';
      renderTranscript(result.html);
      loaded = true;
      showBanner('', false);
      updateComposer();
    } catch (error) {
      if (closed || suspended || current.generation !== generation || current.id !== selectedId || current.modelEpoch !== modelEpoch) return;
      connected = false;
      status.textContent = 'Disconnected';
      showBanner(errorText(error) + ' Sending is paused.', true);
      if (!loaded) emptyTranscript('Conversation unavailable', 'Retry to load this session. Your draft is kept in this tab.');
      updateComposer();
    } finally {
      sessionRequest = null;
      if (!closed && !suspended) {
        if (current.generation !== generation || current.modelEpoch !== modelEpoch) void refreshSession();
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
  function closeModelPanel() {
    modelPanel.hidden = true;
    modelButton.setAttribute('aria-expanded', 'false');
    if (modelRequest) modelRequest.controller.abort();
    modelRequest = null;
    modelCatalog = null;
    showAllModels = false;
    modelMore.hidden = true;
    modelOptions.replaceChildren();
    modelNotice.textContent = '';
  }
  function closeUsagePanel() {
    usagePanel.hidden = true;
    usageButton.setAttribute('aria-expanded', 'false');
  }
  function renderModels() {
    modelOptions.replaceChildren();
    if (!modelCatalog) return;
    const query = modelSearch.value.trim().toLocaleLowerCase();
    const isCurrent = model => selected?.controls.currentModel?.id === model.id && selected?.controls.currentModel?.provider === model.provider;
    const available = model => modelCatalog.configuredProviders.includes(model.provider);
    const models = modelCatalog.models.filter(model => query
      ? (model.name + ' ' + model.provider + '/' + model.id).toLocaleLowerCase().includes(query)
      : showAllModels || available(model) || isCurrent(model));
    const rank = model => isCurrent(model) ? 0 : available(model) ? 1 : 2;
    models.sort((left, right) => rank(left) - rank(right));
    modelMore.hidden = !!query || showAllModels || !modelCatalog.models.some(model => !available(model) && !isCurrent(model));
    const id = selectedId;
    const currentGeneration = generation;
    for (const model of models) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'model-option';
      const available = modelCatalog.configuredProviders.includes(model.provider);
      button.dataset.available = String(available);
      button.dataset.provider = model.provider;
      button.dataset.modelId = model.id;
      button.disabled = modelButton.disabled || !available;
      button.setAttribute('aria-pressed', String(selected?.controls.currentModel?.id === model.id && selected?.controls.currentModel?.provider === model.provider));
      const name = document.createElement('span');
      name.className = 'model-option-name';
      name.textContent = model.name || model.id;
      const meta = document.createElement('span');
      meta.className = 'model-option-meta';
      meta.textContent = model.provider + '/' + model.id + (!available ? ' · Unavailable' : '');
      if (!available) button.title = 'Check authentication in Prime Agent';
      button.append(name, meta);
      button.addEventListener('click', () => { if (!button.disabled && id === selectedId && currentGeneration === generation) void changeModel(model); });
      modelOptions.append(button);
    }
    if (!models.length) modelOptions.textContent = 'No models match.';
  }
  async function openModelPanel() {
    updateComposer();
    if (modelButton.disabled) return;
    if (!modelPanel.hidden) { closeModelPanel(); return; }
    closeUsagePanel();
    modelPanel.hidden = false;
    modelButton.setAttribute('aria-expanded', 'true');
    modelSearch.value = '';
    modelSearch.focus();
    modelNotice.textContent = 'Loading models...';
    const current = { id: selectedId, generation, controller: new AbortController() };
    modelRequest = current;
    try {
      const result = await request('api/models?id=' + encodeURIComponent(current.id), {}, current.controller);
      if (closed || suspended || modelRequest !== current || current.id !== selectedId || current.generation !== generation) return;
      if (!isObject(result) || result.sessionId !== current.id || !Array.isArray(result.models) || !result.models.every(isModel) || !Array.isArray(result.configuredProviders) || !result.configuredProviders.every(provider => typeof provider === 'string')) throw new Error('The chat server returned an invalid model list.');
      modelCatalog = result;
      modelNotice.textContent = '';
      renderModels();
    } catch (error) {
      if (modelRequest === current && current.id === selectedId && current.generation === generation && !closed && !suspended) modelNotice.textContent = errorText(error);
    } finally { if (modelRequest === current) modelRequest = null; }
  }
  async function changeModel(model) {
    updateComposer();
    if (modelButton.disabled || !modelCatalog?.configuredProviders.includes(model.provider)) return;
    const current = { id: selectedId, generation, phase: 'pending', error: false };
    modelMutation = current;
    modelEpoch++;
    modelNotice.textContent = 'Updating model...';
    updateComposer();
    try {
      const result = await request('api/model', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Chat-Token': csrfToken }, body: JSON.stringify({ sessionId: current.id, provider: model.provider, modelId: model.id }) }, new AbortController());
      if (!isObject(result) || !isModel(result.model)) throw new Error('The chat server did not confirm the model.');
    } catch (error) {
      current.error = true;
      if (current.id === selectedId && current.generation === generation && !closed && !suspended) modelNotice.textContent = errorText(error) + ' Reading the current model before retry.';
    } finally {
      current.phase = 'readback';
      modelEpoch++;
      connected = false;
      if (!current.error && current.id === selectedId && current.generation === generation) modelNotice.textContent = 'Reading the current model...';
      if (sessionRequest) sessionRequest.controller.abort();
      else void refreshSession();
      updateComposer();
    }
  }
  function renderUsage() {
    const content = $('usage-content');
    content.replaceChildren();
    if (!selected) return;
    const usage = selected.usage;
    const context = usage.context;
    const contextText = context && context.tokens !== null
      ? context.tokens.toLocaleString() + ' / ' + context.contextWindow.toLocaleString() + (context.percent !== null ? ' (' + context.percent.toFixed(1) + '%)' : '') + ' · Estimate'
      : 'Estimate unavailable';
    const rows = [
      ['Input', usage.kind === 'native-session' ? usage.inputTokens.toLocaleString() : 'Not recorded'],
      ['Output', usage.kind === 'native-session' ? usage.outputTokens.toLocaleString() : 'Not recorded'],
      ['Cost', usage.kind === 'native-session' ? '$' + usage.cost.toFixed(4) : 'Not recorded'],
      ['Context', contextText],
    ];
    const details = document.createElement('dl');
    for (const [label, value] of rows) {
      const term = document.createElement('dt');
      term.textContent = label;
      const description = document.createElement('dd');
      description.textContent = value;
      details.append(term, description);
    }
    const footnote = document.createElement('p');
    footnote.textContent = 'Own session usage, including cache. Account limits unavailable.';
    content.append(details, footnote);
  }
  function renderAttachments() {
    previews.replaceChildren();
    const id = selectedId;
    const draft = drafts.get(id);
    for (const item of draft?.attachments || []) {
      const box = document.createElement('div');
      box.className = 'attachment-preview';
      if (item.kind === 'ready') {
        const image = document.createElement('img');
        image.src = 'data:' + item.image.mimeType + ';base64,' + item.image.data;
        image.alt = item.name;
        box.append(image);
      } else {
        const label = document.createElement('span');
        label.textContent = 'Reading image...';
        box.append(label);
      }
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'attachment-remove';
      remove.textContent = '×';
      remove.setAttribute('aria-label', 'Remove ' + item.name);
      remove.disabled = composer.disabled;
      remove.addEventListener('click', () => {
        updateComposer();
        if (id !== selectedId || composer.disabled) return;
        draft.attachments = draft.attachments.filter(other => other !== item);
        draft.error = '';
        renderAttachments();
        updateComposer();
      });
      box.append(remove);
      previews.append(box);
    }
  }
  function readImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener('load', () => {
        const result = reader.result;
        const prefix = 'data:' + file.type + ';base64,';
        if (typeof result !== 'string' || !result.startsWith(prefix) || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.slice(prefix.length))) reject(new Error('Cannot read this image.'));
        else resolve({ type: 'image', mimeType: file.type, data: result.slice(prefix.length) });
      });
      reader.addEventListener('error', () => reject(new Error('Cannot read this image.')));
      reader.addEventListener('abort', () => reject(new Error('Image read canceled.')));
      reader.readAsDataURL(file);
    });
  }
  async function finishImage(id, draft, item, file) {
    try {
      const image = await readImage(file);
      if (closed || drafts.get(id) !== draft || !draft.attachments.includes(item)) return;
      const index = draft.attachments.indexOf(item);
      draft.attachments[index] = { kind: 'ready', name: item.name, size: item.size, image };
    } catch (error) {
      if (drafts.get(id) !== draft || !draft.attachments.includes(item)) return;
      draft.attachments = draft.attachments.filter(other => other !== item);
      draft.error = errorText(error);
    } finally {
      if (id === selectedId && !closed) { renderAttachments(); updateComposer(); }
    }
  }
  function addImages(files) {
    updateComposer();
    if (composer.disabled) return;
    const id = selectedId;
    const draft = draftFor(id);
    draft.error = '';
    if (!supportsImages()) draft.error = 'Choose a model that accepts images.';
    else for (const file of files) {
      if (!imageTypes.includes(file.type)) { draft.error = 'Use PNG, JPEG, GIF, or WebP images.'; continue; }
      if (!file.size || file.size > 3 * 1024 * 1024) { draft.error = 'Each image must be 3 MiB or less.'; continue; }
      if (draft.attachments.length >= 4) { draft.error = 'Attach up to 4 images.'; break; }
      if (draft.attachments.reduce((total, item) => total + item.size, 0) + file.size > 8 * 1024 * 1024) { draft.error = 'Images must total 8 MiB or less.'; continue; }
      const item = { kind: 'reading', name: file.name || 'Pasted image', size: file.size };
      draft.attachments.push(item);
      void finishImage(id, draft, item, file);
    }
    renderAttachments();
    updateComposer();
  }
  function closeImage() {
    imageViewer.hidden = true;
    imageFull.removeAttribute('src');
    if (imageFocus && transcript.contains(imageFocus)) imageFocus.focus({ preventScroll: true });
    imageFocus = null;
  }
  function openImage(target) {
    const image = target?.closest?.('img.chat-image') || target?.closest?.('button.chat-image-button')?.querySelector('img.chat-image');
    const src = image?.getAttribute('src');
    if (!image || !transcript.contains(image) || typeof src !== 'string' || !/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(src)) return;
    imageFull.src = src;
    imageFull.alt = image.alt || 'Sent image';
    imageFocus = target?.closest?.('button.chat-image-button') || image;
    imageViewer.hidden = false;
    $('image-close').focus();
  }
  function sameImages(left, right) {
    return left.length === right.length && left.every((image, index) => image.mimeType === right[index].mimeType && image.data === right[index].data);
  }
  async function sendMessage() {
    updateComposer();
    if (send.disabled || composing) return;
    const id = selectedId;
    const message = composer.value;
    const previous = deliveries.get(id);
    const draft = draftFor(id);
    draft.message = message;
    const images = draft.attachments.map(item => item.image);
    const requestId = previous?.kind === 'error' && previous.message === message && sameImages(previous.images, images) ? previous.requestId : crypto.randomUUID();
    deliveries.set(id, { kind: 'pending', requestId, message, images, text: 'Sending...' });
    updateComposer();
    const controller = new AbortController();
    try {
      const result = await request('api/message', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Chat-Token': csrfToken }, body: JSON.stringify({ sessionId: id, message, requestId, ...(images.length ? { images } : {}) }) }, controller);
      if (!isObject(result) || result.accepted !== true) throw new Error('The chat server did not confirm acceptance.');
      deliveries.delete(id);
      if (drafts.get(id) === draft && draft.message === message && sameImages(draft.attachments.map(item => item.image), images)) {
        drafts.delete(id);
        if (selectedId === id) { composer.value = ''; renderAttachments(); }
      }
      if (!closed && selectedId === id) void refreshSession();
    } catch (error) {
      deliveries.set(id, { kind: 'error', requestId, message, images, text: errorText(error) + ' Acceptance is not confirmed. Retry unchanged to check the same submission. Check the transcript before changing the draft.' });
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
    closeModelPanel();
    closeUsagePanel();
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

  modelButton.addEventListener('click', openModelPanel);
  modelSearch.addEventListener('input', renderModels);
  modelMore.addEventListener('click', () => {
    if (modelPanel.hidden || !modelCatalog) return;
    showAllModels = true;
    renderModels();
  });
  $('model-close').addEventListener('click', () => { closeModelPanel(); modelButton.focus(); });
  usageButton.addEventListener('click', () => {
    if (usageButton.disabled) return;
    if (!usagePanel.hidden) { closeUsagePanel(); return; }
    closeModelPanel();
    usagePanel.hidden = false;
    usageButton.setAttribute('aria-expanded', 'true');
    renderUsage();
    $('usage-close').focus();
  });
  $('usage-close').addEventListener('click', () => { closeUsagePanel(); usageButton.focus(); });
  attachButton.addEventListener('click', () => { if (!attachButton.disabled) imageInput.click(); });
  imageInput.addEventListener('change', () => { addImages(Array.from(imageInput.files || [])); imageInput.value = ''; });
  composer.addEventListener('paste', event => {
    const files = Array.from(event.clipboardData?.items || []).filter(item => item.kind === 'file').map(item => item.getAsFile()).filter(Boolean);
    if (files.length) { event.preventDefault(); addImages(files); }
  });
  document.addEventListener('dragover', event => { if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault(); });
  document.addEventListener('drop', event => {
    const files = Array.from(event.dataTransfer?.files || []);
    if (files.length) { event.preventDefault(); addImages(files); }
  });
  transcript.addEventListener('click', event => openImage(event.target));
  $('image-close').addEventListener('click', closeImage);
  imageViewer.addEventListener('click', event => { if (event.target === imageViewer) closeImage(); });
  document.addEventListener('click', event => {
    if (!modelPanel.hidden && !modelPanel.contains(event.target) && !modelButton.contains(event.target)) closeModelPanel();
    if (!usagePanel.hidden && !usagePanel.contains(event.target) && !usageButton.contains(event.target)) closeUsagePanel();
  });
  sidebarToggle.addEventListener('click', () => setSidebar(sidebar.hidden));
  $('hide-sidebar').addEventListener('click', () => { setSidebar(false); sidebarToggle.focus(); });
  backdrop.addEventListener('click', () => { setSidebar(false); sidebarToggle.focus(); });
  document.addEventListener('keydown', event => {
    if (!imageViewer.hidden && event.key === 'Tab') { event.preventDefault(); $('image-close').focus(); return; }
    if (event.key === 'Escape' && !imageViewer.hidden) { closeImage(); return; }
    if (event.key === 'Escape' && !modelPanel.hidden) { closeModelPanel(); modelButton.focus(); return; }
    if (event.key === 'Escape' && !usagePanel.hidden) { closeUsagePanel(); usageButton.focus(); return; }
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
  composer.addEventListener('input', () => { draftFor(selectedId).message = composer.value; updateComposer(); });
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

