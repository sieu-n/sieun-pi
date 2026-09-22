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
  const selectedFragment = () => { try { return decodeURIComponent(location.hash.slice(1)); } catch { return ''; } };
  let selectedId = selectedFragment() || document.body.dataset.initialSessionId || '';
  let selected = null;
  let sessions = [];
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
      if (!isObject(item) || typeof item.id !== 'string' || !item.id || ids.has(item.id) || typeof item.name !== 'string' || typeof item.status !== 'string' || typeof item.writable !== 'boolean') throw new Error('The chat server returned an invalid session list.');
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
    status.textContent = closed || !loaded ? '' : !connected || !navigator.onLine ? 'Disconnected' : selected.nativeStatus || (!writable() ? 'Read-only' : '');
    renderWork();
    status.hidden = !status.textContent;
  }
  function updateComposer() {
    const delivery = deliveries.get(selectedId);
    const pending = delivery?.kind === 'pending';
    const ready = !closed && !suspended && !closing && loaded && connected && navigator.onLine && writable();
    const attachments = drafts.get(selectedId)?.attachments || [];
    composer.disabled = !ready || pending || modelMutation !== null || controlPending;
    send.disabled = composer.disabled || attachments.some(item => item.kind === 'reading') || (attachments.length > 0 && !supportsImages()) || (!composer.value.trim() && !attachments.length);
    attachButton.disabled = composer.disabled || !supportsImages() || attachments.length >= 4;
    imageInput.disabled = attachButton.disabled;
    for (const button of previews.querySelectorAll('button')) button.disabled = composer.disabled;
    closeButton.disabled = closed || suspended || closing || hasPendingSend() || modelMutation?.phase === 'pending';
    $('composer-target').textContent = closed ? 'Chat closed' : selected ? 'To ' + (selected.name || 'Untitled session') : 'Choose a session';
    composer.placeholder = closed ? 'This chat is closed' : !selectedId ? 'Choose a session' : !loaded ? 'Loading...' : !writable() ? 'Resume this session in Prime Agent to reply' : !connected || !navigator.onLine ? 'Reconnect to send a message' : pending ? 'Sending...' : 'Ask anything, or follow up';
    send.setAttribute('aria-label', pending ? 'Sending message' : 'Send message');
    sendNotice.hidden = !delivery;
    sendNotice.textContent = delivery ? delivery.text : '';
    sendNotice.dataset.kind = delivery ? delivery.kind : '';
    const imageError = drafts.get(selectedId)?.error || (attachments.length && loaded && !supportsImages() ? 'Choose a model that accepts images, or remove the images.' : '');
    attachmentError.hidden = !imageError;
    attachmentError.textContent = imageError;
    modelButton.disabled = !ready || !selected.controls.canChangeModel || hasPendingSend() || modelMutation !== null || controlPending;
    $('model-label').textContent = selected?.controls.currentModel?.name || 'Model';
    modelButton.title = selected?.controls.currentModel ? selected.controls.currentModel.provider + '/' + selected.controls.currentModel.id : 'Choose a model';
    for (const button of modelOptions.querySelectorAll('button')) {
      button.disabled = modelButton.disabled || button.dataset.available !== 'true';
      button.setAttribute('aria-pressed', String(selected?.controls.currentModel?.provider === button.dataset.provider && selected?.controls.currentModel?.id === button.dataset.modelId));
    }
    usageButton.disabled = !loaded || closed || suspended;
    $('effort-button').disabled = modelButton.disabled;
    $('effort-button').textContent = selected?.controls.kind === 'live' ? selected.controls.thinkingLevel : 'Effort';
    $('account-button').disabled = !ready || controlPending;
    renderAccountWidget();
    $('stop-button').hidden = selected?.status !== 'running';
    $('stop-button').disabled = !ready;
    $('compact-button').disabled = modelButton.disabled;
    const percent = selected?.usage.context?.percent;
    $('context-label').textContent = typeof percent === 'number' ? 'Context ' + Math.round(percent) + '%' : 'Context';
    if (!usagePanel.hidden) renderUsage();
    updateStatus();
  }
  function renderList() {
    const query = search.value.trim().toLocaleLowerCase();
    const items = sessions.filter(item => !query || (item.name + ' ' + item.status).toLocaleLowerCase().includes(query));
    if (list.querySelector('input')) return;
    const focusedId = list.contains(document.activeElement) ? document.activeElement.dataset.sessionId : null;
    list.replaceChildren();

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
      meta.dataset.status = item.nativeStatus === 'failed' || item.readError ? 'failed' : item.status === 'running' ? 'running' : item.unread ? 'unread' : '';
      if (item.readError) button.title = item.readError;
      meta.setAttribute('title', state);
      meta.setAttribute('aria-hidden', 'true');
      button.append(name, meta);
      button.addEventListener('click', () => selectSession(item.id));
      button.title = metadata(item);
      button.addEventListener('keydown', event => { if (event.key === 'F2') { event.preventDefault(); renameSession(item, li); } });
      const time = document.createElement('span'); time.className = 'session-time';
      time.textContent = relativeTime(item.lastAssistant?.timestamp || item.lastActivityAt || item.created);
      time.title = metadata(item); button.append(time);
      const more = document.createElement('button'); more.type = 'button'; more.className = 'row-more';
      more.textContent = '···'; more.setAttribute('aria-label', 'Rename ' + item.name); more.title = 'Rename';
      more.addEventListener('click', () => renameSession(item, li));
      li.className = 'session-row'; li.append(button, more);
      list.append(li);
      if (item.id === focusedId) button.focus({ preventScroll: true });
    }
    $('list-notice').hidden = items.length > 0;
    $('list-notice').textContent = !listLoaded ? 'Loading sessions...' : query ? 'No matches.' : 'No sessions available.';
  }
  function selectSession(id) {
    if (closed) return;
    hideMobileSidebar();
    if (id === selectedId && loaded) return;
    if (selectedId) saveView();
    selectedId = id;
    history.replaceState(null, '', '#' + encodeURIComponent(id));
    commandCatalog = null; commandError = ''; slashDismissed = false;
    closeExtraPanels();
    accountEpoch++; accountRequest?.abort(); accountRequest = null; accountKey = ''; poolListing = null; accountError = '';
    generation++;
    selected = null;
    loaded = false;
    connected = false;
    followingBottom = draftFor(id).followingBottom ?? true;
    lastHtml = null;
    composing = false;
    composer.value = drafts.get(id)?.message || '';
    composer.setSelectionRange(draftFor(id).selectionStart ?? composer.value.length, draftFor(id).selectionEnd ?? composer.value.length);
    closeModelPanel();
    closeUsagePanel();
    closeImage();
    renderAttachments();
    title.textContent = sessions.find(item => item.id === id)?.name || 'Loading session';
    status.textContent = 'Loading...';
    $('queue-details').hidden = true; $('queue-items').replaceChildren();
    latest.hidden = true;
    showBanner('', false);
    emptyTranscript('Loading conversation', 'Reading the saved transcript.');
    renderList();
    updateComposer();
    clearTimeout(sessionTimer);
    if (sessionRequest) sessionRequest.controller.abort();
    else void refreshSession();
    void loadCommands();
  }
  function atBottom() { return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80; }
  function scrollBottom() {
    scroller.scrollTop = scroller.scrollHeight;
    followingBottom = true;
    latest.hidden = true;
  }
  function renderTranscript(html) {
    if (html === lastHtml) return;
    const toBottom = followingBottom;
    const scrollTop = loaded ? scroller.scrollTop : draftFor(selectedId).scrollTop || 0;
    const openDetails = loaded ? disclosureState() : draftFor(selectedId).disclosures || [];
    const toolBodies = new Map(Array.from(transcript.querySelectorAll('details.tool')).flatMap(item => {
      const body = item.querySelector('.tool-content');
      return body && item.dataset.loadedRevision === item.dataset.toolRevision ? [[item.dataset.toolId, { revision: item.dataset.toolRevision, body }]] : [];
    }));
    if (html.trim()) transcript.innerHTML = html;
    else emptyTranscript('No messages yet', selected && selected.writable ? 'Send a message to this session below.' : 'This session has no saved messages.');
    for (const item of transcript.querySelectorAll('details')) {
      item.open = openDetails.includes(disclosureKey(item));
      const cached = toolBodies.get(item.dataset.toolId);
      if (cached && cached.revision === item.dataset.toolRevision) {
        item.querySelector('.tool-content')?.replaceWith(cached.body); item.dataset.loadedRevision = cached.revision;
      }
      if (item.open && item.dataset.toolId) void loadToolDetail(item);
    }
    lastHtml = html;
    if (toBottom) scrollBottom();
    else { scroller.scrollTop = scrollTop; latest.hidden = atBottom(); }
  }
  async function refreshSession() {
    clearTimeout(sessionTimer);
    if (closed || suspended || controlPending || sessionRequest || !selectedId) return;
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
      title.title = metadata(result);
      title.tabIndex = 0;
      const item = sessions.find(item => item.id === result.id);
      if (item) Object.assign(item, { ...result, html: undefined });
      renderList();
      renderQueue();
      document.title = title.textContent + ' · Prime Agent';
      if (modelMutation?.phase === 'readback') {
        if (modelMutation.id === selectedId && modelMutation.generation === generation) {
          if (modelMutation.error) modelNotice.textContent = 'Model change was not confirmed. Check the selected model before retrying.';
          else closeModelPanel();
        }
        modelMutation = null;
      }
      renderTranscript(result.html);
      loaded = true;
      const poolKey = result.controls.kind === 'live' ? result.id + '/' + (result.controls.currentModel?.provider || '') : '';
      if (poolKey && poolKey !== accountKey) void loadAccounts();
      showBanner('', false);
      updateComposer();
      void markVisibleRead();
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
      const order = new Map(sessions.map((item, index) => [item.id, index]));
      sessions = result.sessions.map(item => ({ ...item })).sort((left, right) =>
        (order.get(left.id) ?? -1) - (order.get(right.id) ?? -1) || Date.parse(right.lastActivityAt || right.created || '') - Date.parse(left.lastActivityAt || left.created || ''));
      listLoaded = true;
      $('list-error').hidden = true;
      if (!selectedId && result.initialSessionId) selectSession(result.initialSessionId);
      renderList();
      updateComposer();
      if (!selectedId) {
        title.textContent = 'Prime Agent chat';
        status.textContent = sessions.length ? 'Choose a session' : 'No sessions available';
        emptyTranscript(sessions.length ? 'Choose a session' : 'No sessions available', sessions.length ? 'Select a session from the sidebar.' : 'Sessions appear here when Prime Agent makes them available.');
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
      meta.textContent = model.provider + '/' + model.id + ' · ' + model.input.join(', ') + (model.cost ? ' · $' + model.cost.input + '/$' + model.cost.output + ' per 1M in/out' : '') + (!available ? ' · Unavailable' : '');
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
    footnote.textContent = 'Own session token usage, including cache. Account capacity is in Account.';
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
    if (handleSlash(message)) return;
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
    commandRequest?.abort(); commandRequest = null;
    accountRequest?.abort(); accountRequest = null;
    if (!poolListing) accountKey = '';
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


  let commandCatalog = null;
  let commandError = '';
  let commandEpoch = 0;
  let commandRequest = null;
  let slashIndex = 0;
  let slashDismissed = false;
  let slashMatches = [];
  let poolListing = null;
  let accountEpoch = 0;
  let accountKey = '';
  let accountRequest = null;
  let accountError = '';
  let controlPending = false;
  const readRequests = new Set();
  function post(route, body) {
    return request('api/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Chat-Token': csrfToken }, body: JSON.stringify(body) }, new AbortController());
  }
  async function loadToolDetail(details) {
    if (!details.open || !details.dataset.toolId || details.dataset.loadingRevision === details.dataset.toolRevision || details.dataset.loadedRevision === details.dataset.toolRevision) return;
    const id = selectedId; const revision = details.dataset.toolRevision; const body = details.querySelector('.tool-content');
    if (!body) return;
    details.dataset.loadingRevision = revision; body.textContent = 'Loading native tool details...';
    try {
      const result = await request('api/tool?id=' + encodeURIComponent(id) + '&toolId=' + encodeURIComponent(details.dataset.toolId), {}, new AbortController());
      if (id !== selectedId || !transcript.contains(details) || !details.open || revision !== details.dataset.toolRevision) return;
      if (!isObject(result) || result.sessionId !== id || !isObject(result.tool) || result.tool.id !== details.dataset.toolId || typeof result.tool.output !== 'string') throw new Error('Invalid native tool details.');
      body.replaceChildren();
      for (const [label, value] of [['Arguments', JSON.stringify(result.tool.args, null, 2)], ['Output', result.tool.output]]) {
        const heading = document.createElement('p'); heading.className = 'notice'; heading.textContent = label;
        const pre = document.createElement('pre'); const code = document.createElement('code'); code.textContent = value || (label === 'Output' ? 'No native output yet.' : '{}');
        pre.append(code); body.append(heading, pre);
      }
      details.dataset.loadedRevision = result.tool.revision;
    } catch (error) { if (id === selectedId && transcript.contains(details)) body.textContent = errorText(error) + ' Close and reopen to retry.'; }
    finally { delete details.dataset.loadingRevision; }
  }
  transcript.addEventListener('toggle', event => { if (event.target?.dataset?.toolId) void loadToolDetail(event.target); }, true);
  function metadata(item) {
    const date = value => value ? new Date(value).toLocaleString() : 'Unavailable';
    return [item.name, 'Started ' + date(item.created), 'Last response ' + date(item.lastAssistant?.timestamp),
      item.model || '', item.nativeStatus || '', item.readError || ''].filter(Boolean).join('\n');
  }
  function relativeTime(value) {
    const timestamp = typeof value === 'number' ? value : Date.parse(value || '');
    if (!Number.isFinite(timestamp)) return '';
    const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
    return minutes < 1 ? 'now' : minutes < 60 ? minutes + 'm' : minutes < 1440 ? Math.floor(minutes / 60) + 'h' : Math.floor(minutes / 1440) + 'd';
  }
  function disclosureKey(item) {
    return item.dataset.disclosureId || (item.closest('[data-message-id]')?.dataset.messageId || '') + ':' + item.querySelector('summary')?.textContent;
  }
  function disclosureState() { return Array.from(transcript.querySelectorAll('details')).filter(item => item.open).map(disclosureKey); }
  function saveView() {
    Object.assign(draftFor(selectedId), { message: composer.value, scrollTop: scroller.scrollTop, followingBottom,
      selectionStart: composer.selectionStart, selectionEnd: composer.selectionEnd, disclosures: disclosureState() });
  }
  async function renameSession(item, li) {
    if (closed || li.querySelector('input')) return;
    const input = document.createElement('input'); input.className = 'rename-input'; input.value = item.name;
    input.maxLength = 200; input.setAttribute('aria-label', 'Session name');
    li.replaceChildren(input); input.focus(); input.select();
    input.addEventListener('keydown', async event => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') { li.replaceChildren(); renderList(); return; }
      if (event.key !== 'Enter' || input.disabled) return;
      event.preventDefault(); input.disabled = true;
      try { await post('rename', { sessionId: item.id, name: input.value }); await refreshList(); if (selectedId === item.id) void refreshSession(); }
      catch (error) { $('list-error').hidden = false; $('list-error-text').textContent = errorText(error); }
      finally { li.replaceChildren(); renderList(); }
    });
    input.addEventListener('blur', () => { if (!input.disabled) { li.replaceChildren(); renderList(); } });
  }
  async function loadCommands() {
    const id = selectedId; const epoch = ++commandEpoch;
    commandRequest?.abort(); const controller = new AbortController(); commandRequest = controller;
    commandCatalog = null; commandError = ''; renderSlash();
    try {
      const result = await request('api/commands?id=' + encodeURIComponent(id), {}, controller);
      if (selectedId !== id || epoch !== commandEpoch) return;
      if (!isObject(result) || result.sessionId !== id || !Array.isArray(result.commands) || !result.commands.every(command => isObject(command) && typeof command.name === 'string' && ['skill', 'extension', 'prompt'].includes(command.source))) throw new Error('Invalid native command catalog.');
      commandCatalog = result.commands;
    } catch (error) { if (id === selectedId && epoch === commandEpoch) commandError = errorText(error); }
    if (commandRequest === controller) commandRequest = null;
    if (id === selectedId && epoch === commandEpoch) renderSlash();
  }
  function renderSlash() {
    const panel = $('slash-picker'); panel.replaceChildren();
    const match = /^\/([^\s]*)$/.exec(composer.value);
    panel.hidden = !match || slashDismissed || composing;
    composer.setAttribute('aria-expanded', String(!panel.hidden));
    composer.removeAttribute('aria-activedescendant');
    if (panel.hidden) return;
    if (!commandCatalog) { panel.textContent = commandError || 'Loading native commands...'; return; }
    const controls = [
      { name: 'model', description: 'Choose a native model', source: 'control' },
      { name: 'account', description: 'Choose an account for the next request', source: 'control' },
      { name: 'effort', description: 'Choose native thinking effort', source: 'control' },
      { name: 'rename', description: 'Rename this session', source: 'control' },
      { name: 'stop', description: 'Abort native turn and child runs; pause queued messages', source: 'control' },
      { name: 'compact', description: 'Compact the idle native session', source: 'control' },
    ];
    const query = match[1].toLocaleLowerCase();
    slashMatches = [...controls, ...commandCatalog.filter(command => !controls.some(control => control.name === command.name))]
      .filter(command => (command.name + ' ' + (command.description || '')).toLocaleLowerCase().includes(query));
    slashIndex = Math.min(slashIndex, Math.max(0, slashMatches.length - 1));
    if (!slashMatches.length) panel.textContent = 'No native commands match. Unknown commands are not sent.';
    slashMatches.forEach((command, index) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'slash-option';
      button.id = 'slash-' + index; button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(index === slashIndex));
      button.textContent = '/' + command.name + ' · ' + command.source + (command.description ? ' · ' + command.description : '');
      button.title = button.textContent; button.addEventListener('click', () => chooseSlash(command)); panel.append(button);
      if (index === slashIndex) composer.setAttribute('aria-activedescendant', button.id);
    });
  }
  function chooseSlash(command) {
    composer.value = '/' + command.name + ' '; draftFor(selectedId).message = composer.value;
    slashDismissed = true; renderSlash(); updateComposer(); composer.focus();
    if (command.source === 'control') void handleSlash(composer.value);
    else if (command.source === 'extension') showBanner('This extension needs the Prime Agent terminal. Browser dialogs are unavailable.', false);
  }
  function slashKey(event) {
    if ($('slash-picker').hidden) return false;
    if (event.key === 'Escape') { event.preventDefault(); slashDismissed = true; renderSlash(); return true; }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault(); slashIndex = (slashIndex + (event.key === 'ArrowUp' ? -1 : 1) + slashMatches.length) % Math.max(1, slashMatches.length);
      renderSlash(); document.getElementById('slash-' + slashIndex)?.scrollIntoView({ block: 'nearest' }); return true;
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && slashMatches[slashIndex]) { event.preventDefault(); chooseSlash(slashMatches[slashIndex]); return true; }
    return false;
  }
  function handleSlash(message) {
    if (!message.trimStart().startsWith('/')) return false;
    const name = message.trim().split(/\s/, 1)[0].slice(1);
    if (name === 'model') { void openModelPanel(); if (!modelPanel.hidden) consumeControl(message); return true; }
    if (name === 'account') { void openAccounts(); if (!$('account-panel').hidden) consumeControl(message); return true; }
    if (name === 'effort') { openEffort(); if (!$('effort-panel').hidden) consumeControl(message); return true; }
    if (name === 'rename') {
      const row = Array.from(list.querySelectorAll('button')).find(button => button.dataset.sessionId === selectedId);
      if (row) { renameSession(selected, row.parentElement); consumeControl(message); } return true;
    }
    if (name === 'stop' || name === 'compact') { const id = selectedId; void nativeControl(name).then(applied => { if (applied && id === selectedId) consumeControl(message); }); return true; }
    const command = commandCatalog?.find(command => command.name === name);
    if (!command || command.source === 'extension') {
      showBanner(command ? 'Run this extension in the Prime Agent terminal. Browser dialogs are unavailable.' : commandError || 'Unknown or unavailable native command. Your draft is kept.', false);
      return true;
    }
    return false;
  }
  function consumeControl(message) {
    if (composer.value !== message) return;
    composer.value = ''; draftFor(selectedId).message = ''; slashDismissed = true; renderSlash(); updateComposer();
  }
  function closeExtraPanels() {
    for (const name of ['account', 'effort']) { $(name + '-panel').hidden = true; $(name + '-button').setAttribute('aria-expanded', 'false'); }
    $('slash-picker').hidden = true;
  }
  async function nativeControl(route, fields = {}) {
    if (controlPending || !selected || !connected) return;
    const id = selectedId; controlPending = true; modelEpoch++; sessionRequest?.controller.abort(); updateComposer();
    let failure = '';
    try { await post(route, { sessionId: id, ...fields }); }
    catch (error) { failure = errorText(error); }
    finally { controlPending = false; modelEpoch++; if (id === selectedId) { connected = false; await refreshSession(); updateComposer(); if (failure) showBanner(failure, true); } }
    return !failure;
  }
  function openEffort() {
    if ($('effort-button').disabled) return;
    closeExtraPanels(); closeModelPanel(); closeUsagePanel();
    const panel = $('effort-panel'); panel.hidden = false; $('effort-button').setAttribute('aria-expanded', 'true'); panel.replaceChildren();
    for (const level of selected.controls.availableThinkingLevels) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'model-option'; button.textContent = level;
      button.setAttribute('aria-pressed', String(level === selected.controls.thinkingLevel));
      button.addEventListener('click', async () => { for (const child of panel.querySelectorAll('button')) child.disabled = true; await nativeControl('effort', { level }); closeExtraPanels(); }); panel.append(button);
    }
    panel.querySelector('button')?.focus();
  }
  async function openAccounts() {
    if ($('account-button').disabled) return;
    closeExtraPanels(); closeModelPanel(); closeUsagePanel();
    const panel = $('account-panel'); panel.hidden = false; $('account-button').setAttribute('aria-expanded', 'true');
    if (poolListing) renderAccounts(); else panel.textContent = 'Loading pi-pool...';
    await loadAccounts();
  }
  async function loadAccounts() {
    const id = selectedId; const provider = selected?.controls.currentModel?.provider || '';
    const key = id + '/' + provider;
    if (accountRequest && key === accountKey) return;
    const epoch = ++accountEpoch;
    accountRequest?.abort(); const controller = new AbortController(); accountRequest = controller;
    if (accountKey !== key) poolListing = null;
    accountKey = key; accountError = ''; renderAccountWidget();
    try {
      const result = await request('api/accounts?id=' + encodeURIComponent(id), {}, controller);
      if (id !== selectedId || epoch !== accountEpoch || provider !== (selected?.controls.currentModel?.provider || '')) return;
      if (!isObject(result) || result.sessionId !== id || result.provider !== provider || !['none', 'pool'].includes(result.kind) || result.kind === 'pool' && !Array.isArray(result.rows)) throw new Error('Invalid pi-pool listing.');
      poolListing = result;
      if (!$('account-panel').hidden) renderAccounts();
    } catch (error) {
      if (id === selectedId && epoch === accountEpoch && !controller.signal.aborted) {
        accountError = errorText(error);
        if (!$('account-panel').hidden) { $('account-panel').textContent = accountError; addAccountRefresh(); }
      }
    } finally {
      if (accountRequest === controller) accountRequest = null;
      if (id === selectedId && epoch === accountEpoch) renderAccountWidget();
    }
  }
  function renderAccountWidget() {
    const button = $('account-button');
    if (accountKey !== selectedId + '/' + (selected?.controls.currentModel?.provider || '')) { button.textContent = 'Account'; button.title = 'Account for this session'; return; }
    if (accountError) { button.textContent = 'Pool unavailable'; button.title = accountError; return; }
    if (!poolListing) { button.textContent = 'Pool…'; button.title = 'Loading pi-pool'; return; }
    if (poolListing.kind === 'none') { button.textContent = 'No pool'; button.title = 'No account pool for ' + (poolListing.provider || 'this model'); return; }
    const choice = poolListing.rows.find(row => row.pinned) || poolListing.rows.find(row => row.current) || poolListing.rows.find(row => row.seat);
    const used = value => typeof value === 'number' ? value + '%' : '?';
    const identity = choice ? (choice.pinned ? choice.email.split('@')[0] : 'Pool') + (choice.plan ? ' · ' + choice.plan : '') : 'Pool';
    button.textContent = identity + (choice ? ' · ' + used(choice.session_pct) + '/' + used(choice.weekly_pct) : ' · Usage unavailable');
    button.title = choice ? choice.email + (choice.pinned ? ' · Next request' : ' · Follow the pool') + '\n' + choice.usage + '\nSession/week used; ? means unavailable' + (choice.reason ? '\n' + choice.reason : '') : 'Follow the pool · usage unavailable';
  }
  function addAccountRefresh() { const refresh = document.createElement('button'); refresh.type = 'button'; refresh.className = 'quiet-button'; refresh.textContent = 'Refresh'; refresh.addEventListener('click', openAccounts); $('account-panel').append(refresh); }
  function renderAccounts() {
    const panel = $('account-panel'); panel.replaceChildren();
    if (!poolListing) return;
    if (poolListing.kind === 'none') { renderAccountWidget(); panel.textContent = 'No account pool for ' + (poolListing.provider || 'this model'); return; }
    renderAccountWidget();
    const note = document.createElement('p'); note.className = 'panel-note';
    note.textContent = 'Next provider request · session-tree pin · percentages used. Checked ' + new Date(poolListing.checkedAt).toLocaleTimeString(); panel.append(note);
    const option = (label, target, row) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'model-option'; button.textContent = label;
      button.setAttribute('aria-pressed', String(row ? row.pinned : !poolListing.rows.some(row => row.pinned)));
      button.addEventListener('click', async () => {
        const force = !!row && !row.usable;
        if (force && !confirm('Force this account for the next request? ' + row.email + ': ' + (row.reason || 'Unavailable') + '. This may fail.')) return;
        const id = selectedId; const epoch = accountEpoch;
        for (const child of panel.querySelectorAll('button')) child.disabled = true;
        try { const result = await post('account', { sessionId: id, provider: poolListing.provider, target, force });
          if (id === selectedId && epoch === accountEpoch) { poolListing = result; accountError = ''; renderAccounts(); } }
        catch (error) { if (id === selectedId && epoch === accountEpoch) { panel.textContent = errorText(error); addAccountRefresh(); } }
      }); panel.append(button);
    };
    option('Follow the pool', 'follow');
    for (const row of poolListing.rows) {
      const tags = [row.current && 'current', row.pinned && 'pinned', row.force && 'forced', row.seat && 'seat', row.live && 'live', row.reason].filter(Boolean);
      const percentages = row.session_pct === null || row.weekly_pct === null ? 'Usage unavailable' : 'Session ' + row.session_pct + '% · Week ' + row.weekly_pct + '% used';
      option(row.email + (row.plan ? ' · ' + row.plan : '') + '\n' + row.usage + ' · ' + percentages + '\n' + tags.join(' · '), row.id, row);
    }
    addAccountRefresh();
  }
  function renderWork() {
    const work = selected?.work; const line = $('work-status');
    line.hidden = !loaded || !connected || !navigator.onLine || closed || suspended || selected?.status !== 'running';
    if (line.hidden) return;
    const elapsed = typeof work?.startedAt === 'number' ? Math.max(0, Math.floor((Date.now() - work.startedAt) / 1000)) : null;
    $('work-label').textContent = (work?.label || selected.nativeStatus || 'Native work') + (elapsed === null ? '' : ' · ' + (elapsed < 60 ? elapsed + 's' : Math.floor(elapsed / 60) + 'm ' + elapsed % 60 + 's'));
    line.title = work?.recap || 'Native session is active';
  }
  function renderQueue() {
    const details = $('queue-details'); details.hidden = !selected?.queueCount;
    $('queue-summary').textContent = (selected?.queueCount || 0) + ' queued';
    const content = $('queue-items');
    if (content.querySelector('textarea')) return;
    content.replaceChildren();
    for (const lane of ['steering', 'followUp']) (selected?.queue?.[lane] || []).forEach((text, index) => {
      const row = document.createElement('div'); const preview = document.createElement('span'); preview.textContent = text; row.append(preview);
      const id = selectedId;
      for (const action of ['Edit', 'Remove']) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'quiet-button'; button.textContent = action;
        button.addEventListener('click', () => {
          if (id !== selectedId) return;
          if (action === 'Remove') { void nativeControl('queue', { lane, index, expectedText: text }); return; }
          const input = document.createElement('textarea'); input.value = text; input.maxLength = 32000; input.setAttribute('aria-label', 'Queued message');
          const save = document.createElement('button'); save.type = 'button'; save.textContent = 'Save';
          save.addEventListener('click', async () => { if (id !== selectedId) return; const value = input.value; row.replaceChildren(); await nativeControl('queue', { lane, index, expectedText: text, text: value }); });
          const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel'; cancel.addEventListener('click', () => { row.replaceChildren(); renderQueue(); });
          row.replaceChildren(input, save, cancel); input.focus();
        }); row.append(button);
      }
      content.append(row);
    });
  }
  async function markVisibleRead() {
    const last = selected?.lastAssistant;
    if (!last || !selected.unread || document.hidden || !document.hasFocus() || !loaded || !connected || !atBottom() || readRequests.has(last.entryId)) return;
    const entry = Array.from(transcript.querySelectorAll('[data-message-id]')).find(element => element.dataset.messageId === last.entryId);
    if (!entry) return;
    const rect = entry.getBoundingClientRect(); const viewport = scroller.getBoundingClientRect();
    if (rect.bottom > viewport.bottom + 2 || rect.bottom < viewport.top) return;
    const id = selectedId; readRequests.add(last.entryId);
    try { await post('read', { sessionId: id, entryId: last.entryId });
      if (selectedId === id && selected?.lastAssistant?.entryId === last.entryId) selected.unread = false;
      const item = sessions.find(item => item.id === id); if (item?.lastAssistant?.entryId === last.entryId) item.unread = false; renderList();
    } catch (error) { if (id === selectedId) showBanner('Read marker unavailable. ' + errorText(error), true); }
    finally { readRequests.delete(last.entryId); }
  }
  $('account-button').addEventListener('click', openAccounts);
  $('effort-button').addEventListener('click', openEffort);
  $('stop-button').addEventListener('click', () => nativeControl('stop'));
  $('compact-button').addEventListener('click', () => nativeControl('compact'));
  $('commands-refresh').addEventListener('click', loadCommands);
  window.addEventListener('hashchange', () => { const id = selectedFragment(); if (id && id !== selectedId) selectSession(id); });
  window.addEventListener('focus', markVisibleRead);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeExtraPanels(); });
  document.addEventListener('click', event => {
    for (const name of ['account', 'effort']) if (!$(name + '-panel').hidden && !$(name + '-panel').contains(event.target) && !$(name + '-button').contains(event.target)) { $(name + '-panel').hidden = true; $(name + '-button').setAttribute('aria-expanded', 'false'); }
  });
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
  search.addEventListener('input', renderList);
  $('retry-list').addEventListener('click', refreshList);
  retry.addEventListener('click', refreshSession);
  closeButton.addEventListener('click', closeChat);
  scroller.addEventListener('scroll', () => { followingBottom = atBottom(); latest.hidden = followingBottom || !loaded; void markVisibleRead(); }, { passive: true });
  latest.addEventListener('click', () => { scrollBottom(); void markVisibleRead(); });
  composer.addEventListener('input', () => { draftFor(selectedId).message = composer.value; if (composer.value === '/') void loadCommands(); slashDismissed = false; slashIndex = 0; renderSlash(); updateComposer(); });
  composer.addEventListener('compositionstart', () => { composing = true; renderSlash(); });
  composer.addEventListener('compositionend', () => { composing = false; renderSlash(); });
  composer.addEventListener('keydown', event => {
    if (event.isComposing || composing || event.keyCode === 229) return;
    if (slashKey(event)) return;
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !composing && event.keyCode !== 229) { event.preventDefault(); void sendMessage(); }
  });
  $('composer-form').addEventListener('submit', event => { event.preventDefault(); void sendMessage(); });
  window.addEventListener('offline', () => { if (closed) return; connected = false; showBanner('You are offline. Sending is paused. Your draft is kept.', true); updateComposer(); });
  window.addEventListener('online', () => { void refreshSession(); void refreshList(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { void refreshSession(); void refreshList(); } });
  window.addEventListener('pagehide', () => { saveView(); suspended = true; stopPolling(); updateComposer(); });
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

