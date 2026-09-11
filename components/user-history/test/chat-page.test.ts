import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Script, createContext } from 'node:vm';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { renderChatPage, chatContentSecurityPolicy } from '../src/chat-page.ts';

type Node = DefaultTreeAdapterMap['node'];
function nodes(node: Node): Node[] {
  return [node, ...('childNodes' in node ? node.childNodes.flatMap(nodes) : [])];
}
const rendered = renderChatPage({ initialSessionId: 'session/a?b', csrfToken: 'test-token' });
function inlineScript(html: string): string {
  const source = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert(source);
  return source;
}

test('chat has exact CSP hashes and untrusted configuration cannot escape attributes', () => {
  const attack = '\"><script>ATTACK()</script><img src="https://evil.invalid">&\'';
  const html = renderChatPage({ initialSessionId: attack, csrfToken: attack });
  const elements = nodes(parse(html)).filter(n => 'tagName' in n);
  const body = elements.find(n => n.tagName === 'body');
  assert.equal(body?.attrs.find(a => a.name === 'data-initial-session-id')?.value, attack);
  assert.equal(body?.attrs.find(a => a.name === 'data-chat-token')?.value, attack);
  assert.equal(elements.filter(n => n.tagName === 'script').length, 1);
  assert.equal(elements.filter(n => n.tagName === 'style').length, 1);
  assert(!elements.some(n => ['img', 'iframe', 'a', 'link', 'base', 'object', 'embed'].includes(n.tagName)));
  for (const el of elements) for (const attr of el.attrs) assert(!/^(on|src$|href$|srcdoc$|style$|action$|formaction$)/i.test(attr.name));
  const css = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1];
  assert(css);
  const js = inlineScript(html);
  assert(!js.includes('ATTACK'));
  assert.equal(js, inlineScript(rendered));
  new Script(js);
  assert(chatContentSecurityPolicy.includes("script-src 'sha256-" + createHash('sha256').update(js).digest('base64') + "'"));
  assert(chatContentSecurityPolicy.includes("style-src 'sha256-" + createHash('sha256').update(css).digest('base64') + "'"));
  assert(chatContentSecurityPolicy.includes("connect-src 'self'"));
  assert(chatContentSecurityPolicy.includes("form-action 'none'"));
  assert(!chatContentSecurityPolicy.includes('unsafe-'));
  const policy = elements.find(n => n.tagName === 'meta' && n.attrs.some(a => a.name === 'http-equiv'))?.attrs.find(a => a.name === 'content')?.value;
  assert.equal(policy, chatContentSecurityPolicy);
});

test('page has labelled controls, disabled initial composer, and no unrelated session controls', () => {
  const elements = nodes(parse(rendered)).filter(n => 'tagName' in n);
  const byId = (id: string) => elements.find(n => n.attrs.some(a => a.name === 'id' && a.value === id));
  assert.equal(byId('message')?.tagName, 'textarea');
  assert(byId('message')?.attrs.some(a => a.name === 'disabled'));
  assert(byId('send')?.attrs.some(a => a.name === 'disabled'));
  for (const id of ['message', 'session-search']) assert(elements.some(n => n.tagName === 'label' && n.attrs.some(a => a.name === 'for' && a.value === id)));
  assert.equal(byId('send-notice')?.attrs.find(a => a.name === 'role')?.value, 'status');
  for (const label of ['New session', 'Delete session', 'Model settings', 'Steer']) assert(!rendered.includes(label));
  assert(rendered.includes('Busy sessions process your message after the current turn.'));
});

type Event = { key?: string; shiftKey?: boolean; isComposing?: boolean; keyCode?: number; persisted?: boolean; preventDefault: () => void };
class Events {
  listeners = new Map<string, ((event: Event) => unknown)[]>();
  addEventListener(name: string, callback: (event: Event) => unknown): void {
    this.listeners.set(name, [...this.listeners.get(name) ?? [], callback]);
  }
  emit(name: string, fields: Omit<Partial<Event>, 'preventDefault'> = {}): boolean {
    let prevented = false;
    const event: Event = { ...fields, preventDefault: () => { prevented = true; } };
    for (const callback of this.listeners.get(name) ?? []) callback(event);
    return prevented;
  }
}
class Element extends Events {
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  children: Element[] = [];
  className = '';
  hidden = false;
  disabled = false;
  value = '';
  type = '';
  placeholder = '';
  innerHTML = '';
  scrollTop = 0;
  scrollHeight = 1000;
  clientHeight = 300;
  open = false;
  text = '';
  onFocus: (element: Element) => void = () => {};
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.text = value; this.children = []; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  append(...children: Element[]): void { this.children.push(...children); }
  replaceChildren(...children: Element[]): void { this.text = ''; this.innerHTML = ''; this.children = children; }
  contains(element: Element | null): boolean { return this === element || this.children.some(child => child.contains(element)); }
  querySelectorAll(): Element[] { return []; }
  focus(): void { this.onFocus(this); }
}

type PendingRequest = {
  path: string;
  options: { method?: string; body?: string; headers?: Record<string, string>; signal: AbortSignal; mode: string; redirect: string; cache: string; credentials: string };
  resolve: (body: unknown, status?: number) => void;
  reject: (error: Error) => void;
};
function startClient({ abortRequests = true }: { abortRequests?: boolean } = {}) {
  const elements = new Map<string, Element>();
  const document = Object.assign(new Events(), {
    body: new Element(), hidden: false, title: '', activeElement: null,
    getElementById(id: string) { const value = elements.get(id); assert(value, id); return value; },
    createElement() { return new Element(); },
  });
  const documentState: { activeElement: Element | null } = document;
  for (const node of nodes(parse(rendered))) {
    if (!('tagName' in node)) continue;
    const id = node.attrs.find(a => a.name === 'id')?.value;
    const element = node.tagName === 'body' ? document.body : new Element();
    element.onFocus = focused => { documentState.activeElement = focused; };
    for (const attr of node.attrs) {
      element.setAttribute(attr.name, attr.value);
      if (attr.name.startsWith('data-')) element.dataset[attr.name.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] = attr.value;
      if (attr.name === 'disabled') element.disabled = true;
      if (attr.name === 'hidden') element.hidden = true;
    }
    if (id) elements.set(id, element);
  }
  const window = new Events();
  const navigator = { onLine: true };
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const requests: PendingRequest[] = [];
  let timerId = 0;
  let requestId = 0;
  const context = createContext({
    document, window, navigator, AbortController, Error, TypeError, DOMException,
    crypto: { randomUUID: () => 'request-' + ++requestId },
    matchMedia: () => ({ matches: false }),
    setTimeout(callback: () => void, delay: number) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id: number) { timers.delete(id); },
    fetch(path: string, options: PendingRequest['options']) {
      return new Promise((resolve, reject) => {
        requests.push({ path, options, resolve: (body, status = 200) => resolve({ ok: status >= 200 && status < 300, status, json: async () => body }), reject });
        if (abortRequests) options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    },
  });
  new Script(inlineScript(rendered)).runInContext(context);
  const el = (id: string) => { const element = elements.get(id); assert(element, id); return element; };
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const findRequest = (path: string) => { const req = requests.findLast(item => item.path === path); assert(req, path); return req; };
  const select = (id: string) => {
    const button = el('session-list').children.flatMap(li => li.children).find(item => item.dataset.sessionId === id);
    assert(button, id); button.emit('click');
  };
  const type = (message: string) => { el('message').value = message; el('message').emit('input'); };
  const advance = (delay: number) => {
    for (const [id, timer] of Array.from(timers)) if (timer.delay === delay) { timers.delete(id); timer.callback(); }
  };
  return { el, document, window, navigator, requests, flush, findRequest, select, type, advance, timers };
}
const initialId = 'session/a?b';
const secondId = 'other#session';
const agentId = 'agent/<opaque>';
const sessionPath = (id: string) => 'api/session?id=' + encodeURIComponent(id);
const session = (id = initialId, extra = {}) => ({ id, name: id === initialId ? 'First conversation' : 'Second conversation', status: 'idle', writable: true, html: '<article class="pair">Saved transcript</article>', queueCount: 0, ...extra });
const sessionList = { sessions: [
  { id: initialId, name: 'First conversation', kind: 'session', status: 'idle', writable: true },
  { id: secondId, name: 'Second conversation', kind: 'session', status: 'busy', writable: true },
  { id: agentId, name: 'Research agent', kind: 'agent', parentId: initialId, status: 'saved', writable: false },
], initialSessionId: initialId };
async function ready(client: ReturnType<typeof startClient>): Promise<void> {
  client.findRequest('api/sessions').resolve(sessionList);
  client.findRequest(sessionPath(initialId)).resolve(session());
  await client.flush();
}

test('selected transcript and list poll separately without overlapping requests', async () => {
  const client = startClient();
  assert.equal(client.requests.length, 2);
  assert.equal(client.el('message').disabled, true);
  await ready(client);
  assert.equal(client.el('message').disabled, false);
  assert.equal(client.el('send').disabled, true);
  assert.equal(client.el('session-title').textContent, 'First conversation');
  assert.equal(client.el('conversation').scrollTop, 1000);
  client.advance(2000);
  client.advance(2000);
  client.el('retry-session').emit('click');
  assert.equal(client.requests.filter(r => r.path === sessionPath(initialId)).length, 2);
  assert.equal(client.requests.filter(r => r.path === 'api/sessions').length, 1);
  client.findRequest(sessionPath(initialId)).resolve(session());
  await client.flush();
  client.advance(10000);
  client.advance(10000);
  client.el('retry-list').emit('click');
  assert.equal(client.requests.filter(r => r.path === 'api/sessions').length, 2);
  for (const req of client.requests) {
    assert(!req.path.startsWith('/'));
    assert.equal(req.options.mode, 'same-origin');
    assert.equal(req.options.redirect, 'error');
    assert.equal(req.options.cache, 'no-store');
    assert.equal(req.options.credentials, 'omit');
  }
});

test('a stale fetch cannot replace a new selection; only the selected transcript polls', async () => {
  const client = startClient({ abortRequests: false });
  client.findRequest('api/sessions').resolve(sessionList);
  await client.flush();
  const first = client.findRequest(sessionPath(initialId));
  client.select(secondId);
  assert.equal(first.options.signal.aborted, true);
  assert.equal(client.requests.length, 2, 'replacement fetch waits for the old request to settle');
  first.resolve(session(initialId, { html: 'STALE TRANSCRIPT' }));
  await client.flush();
  assert.equal(client.el('session-title').textContent, 'Second conversation');
  assert.notEqual(client.el('transcript').innerHTML, 'STALE TRANSCRIPT');
  client.findRequest(sessionPath(secondId)).resolve(session(secondId));
  await client.flush();
  client.advance(2000);
  assert.equal(client.requests.filter(r => r.path === sessionPath(initialId)).length, 1);
  assert.equal(client.requests.filter(r => r.path === sessionPath(secondId)).length, 2);
});

test('drafts and pending sends keep their original target across session switches', async () => {
  const client = startClient();
  await ready(client);
  client.type('First draft');
  client.select(secondId);
  await client.flush();
  client.findRequest(sessionPath(secondId)).resolve(session(secondId));
  await client.flush();
  assert.equal(client.el('message').value, '');
  client.type('Second draft');
  client.select(initialId);
  await client.flush();
  client.findRequest(sessionPath(initialId)).resolve(session());
  await client.flush();
  assert.equal(client.el('message').value, 'First draft');
  client.el('composer-form').emit('submit');
  const post = client.findRequest('api/message');
  assert.equal(post.options.method, 'POST');
  assert.equal(post.options.headers?.['X-Chat-Token'], 'test-token');
  assert.deepEqual(JSON.parse(post.options.body ?? ''), { sessionId: initialId, message: 'First draft', requestId: 'request-1' });
  assert.equal(client.el('send').disabled, true);
  client.select(secondId);
  await client.flush();
  client.findRequest(sessionPath(secondId)).resolve(session(secondId));
  await client.flush();
  post.resolve({ accepted: true });
  await client.flush();
  assert.equal(client.el('message').value, 'Second draft');
  assert.equal(client.el('send-notice').hidden, true);
  client.select(initialId);
  await client.flush();
  client.findRequest(sessionPath(initialId)).resolve(session(initialId, { queueCount: 2 }));
  await client.flush();
  assert.equal(client.el('message').value, '');
  assert.match(client.el('send-notice').textContent, /^Accepted by Prime Agent\./);
  assert.match(client.el('send-notice').textContent, /does not mean the work is complete/);
  assert.equal(client.el('queue-count').textContent, '2 queued');
});

test('Enter sends, Shift+Enter and IME do not; blank drafts never send', async () => {
  const client = startClient();
  await ready(client);
  client.type('  \n ');
  client.el('message').emit('keydown', { key: 'Enter' });
  assert(!client.requests.some(r => r.path === 'api/message'));
  client.type('Message');
  assert.equal(client.el('message').emit('keydown', { key: 'Enter', shiftKey: true }), false);
  assert.equal(client.el('message').emit('keydown', { key: 'Enter', isComposing: true }), false);
  assert.equal(client.el('message').emit('keydown', { key: 'Enter', keyCode: 229 }), false);
  client.el('message').emit('compositionstart');
  assert.equal(client.el('message').emit('keydown', { key: 'Enter' }), false);
  client.el('composer-form').emit('submit');
  assert(!client.requests.some(r => r.path === 'api/message'));
  client.el('message').emit('compositionend');
  assert.equal(client.el('message').emit('keydown', { key: 'Enter' }), true);
  assert.equal(client.requests.filter(r => r.path === 'api/message').length, 1);
});

test('failed sends retain drafts, disclose uncertainty, and never resend on reconnect', async () => {
  const client = startClient();
  await ready(client);
  client.type('Keep this draft');
  client.el('composer-form').emit('submit');
  client.findRequest('api/message').reject(new TypeError('fetch failed'));
  await client.flush();
  assert.equal(client.el('message').value, 'Keep this draft');
  assert.match(client.el('send-notice').textContent, /Acceptance is not confirmed/);
  assert.match(client.el('send-notice').textContent, /Retrying an unchanged draft checks the same submission/);
  assert.equal(client.el('send').disabled, true);
  client.el('retry-session').emit('click');
  client.findRequest(sessionPath(initialId)).resolve(session());
  await client.flush();
  assert.equal(client.el('send').disabled, false);
  assert.equal(client.requests.filter(r => r.path === 'api/message').length, 1);
  client.window.emit('offline');
  assert.equal(client.el('message').disabled, true);
  assert.equal(client.el('message').value, 'Keep this draft');
});

test('read-only agent selection and list search do not enable sending', async () => {
  const client = startClient();
  await ready(client);
  client.el('view-agents').emit('click');
  assert.equal(client.el('session-list').children.length, 1);
  client.select(agentId);
  await client.flush();
  client.findRequest(sessionPath(agentId)).resolve(session(agentId, { name: 'Research agent', writable: false }));
  await client.flush();
  assert.equal(client.el('message').disabled, true);
  assert.match(client.el('session-status').textContent, /Read-only/);
  client.el('session-search').value = 'nothing matches';
  client.el('session-search').emit('input');
  assert.equal(client.el('session-list').children.length, 0);
  assert.equal(client.el('list-notice').textContent, 'No matches.');
});

test('poll updates do not scroll readers away from older messages', async () => {
  const client = startClient();
  await ready(client);
  client.el('conversation').scrollTop = 120;
  client.el('conversation').emit('scroll');
  assert.equal(client.el('latest').hidden, false);
  client.advance(2000);
  client.findRequest(sessionPath(initialId)).resolve(session(initialId, { html: '<p>Updated transcript</p>' }));
  await client.flush();
  assert.equal(client.el('conversation').scrollTop, 120);
  client.el('latest').emit('click');
  assert.equal(client.el('conversation').scrollTop, 1000);
  client.advance(2000);
  client.el('conversation').scrollHeight = 1500;
  client.findRequest(sessionPath(initialId)).resolve(session(initialId, { html: '<p>More new messages</p>' }));
  await client.flush();
  assert.equal(client.el('conversation').scrollTop, 1500);
});

test('invalid or mismatched server sessions never reach the transcript', async () => {
  const client = startClient();
  client.findRequest('api/sessions').resolve(sessionList);
  client.findRequest(sessionPath(initialId)).resolve(session(secondId, { html: 'WRONG SESSION' }));
  await client.flush();
  assert.equal(client.el('message').disabled, true);
  assert.notEqual(client.el('transcript').innerHTML, 'WRONG SESSION');
  assert.match(client.el('connection-text').textContent, /different session/);
  client.el('retry-session').emit('click');
  client.findRequest(sessionPath(initialId)).resolve(session(initialId, { queueCount: -1, html: 'INVALID SESSION' }));
  await client.flush();
  assert.notEqual(client.el('transcript').innerHTML, 'INVALID SESSION');
  assert.match(client.el('connection-text').textContent, /invalid session/);
});

test('close chat authenticates, stops polling, and keeps the transcript readable', async () => {
  const client = startClient();
  await ready(client);
  client.el('close-chat').emit('click');
  const close = client.findRequest('api/close');
  assert.equal(close.options.method, 'POST');
  assert.equal(close.options.headers?.['X-Chat-Token'], 'test-token');
  assert.equal(client.el('message').disabled, true);
  close.resolve({ closed: true });
  await client.flush();
  assert.match(client.el('connection-text').textContent, /Prime Agent sessions keep running/);
  assert.equal(client.el('transcript').innerHTML, session().html);
  const count = client.requests.length;
  client.advance(2000);
  client.advance(10000);
  client.window.emit('online');
  assert.equal(client.requests.length, count);
  assert.equal(client.el('message').disabled, true);
});


test('a timed-out send keeps its draft without replay and GET failures can retry', async () => {
  const client = startClient();
  await ready(client);
  client.type('Timed out draft');
  client.el('composer-form').emit('submit');
  assert.equal(client.el('close-chat').disabled, true);
  client.advance(35000);
  await client.flush();
  assert.equal(client.el('message').value, 'Timed out draft');
  assert.match(client.el('send-notice').textContent, /Acceptance is not confirmed/);
  assert.equal(client.el('close-chat').disabled, false);
  client.advance(2000);
  client.findRequest(sessionPath(initialId)).resolve({ error: 'Session unavailable' }, 503);
  await client.flush();
  assert.match(client.el('connection-text').textContent, /Session unavailable/);
  assert.equal(client.el('message').disabled, true);
  client.el('retry-session').emit('click');
  client.findRequest(sessionPath(initialId)).resolve(session());
  await client.flush();
  assert.equal(client.el('message').disabled, false);
  assert.equal(client.requests.filter(r => r.path === 'api/message').length, 1);
});


test('unchanged uncertain submissions reuse their request ID across retries and selection changes', async () => {
  const client = startClient();
  await ready(client);
  const posted = () => JSON.parse(client.findRequest('api/message').options.body ?? '');
  client.type('Only one queued message');
  client.el('composer-form').emit('submit');
  const first = posted();
  client.advance(35000);
  await client.flush();
  assert.equal(client.el('message').value, first.message);
  client.el('retry-session').emit('click');
  client.findRequest(sessionPath(initialId)).resolve(session(initialId, { status: 'busy', queueCount: 1 }));
  await client.flush();
  assert.equal(client.requests.filter(r => r.path === 'api/message').length, 1, 'reconnect does not retry');
  client.el('composer-form').emit('submit');
  assert.deepEqual(posted(), first, 'explicit timeout retry uses the same submission');
  client.findRequest('api/message').resolve({ error: 'Delivery result unavailable' }, 502);
  await client.flush();
  client.select(secondId);
  await client.flush();
  client.findRequest(sessionPath(secondId)).resolve(session(secondId));
  await client.flush();
  client.type('Other session draft');
  client.select(initialId);
  await client.flush();
  client.findRequest(sessionPath(initialId)).resolve(session());
  await client.flush();
  assert.equal(client.el('message').value, first.message);
  client.el('composer-form').emit('submit');
  assert.deepEqual(posted(), first, 'HTTP error and switching do not replace the submission ID');
  client.findRequest('api/message').resolve({ accepted: true });
  await client.flush();
  assert.equal(client.el('message').value, '');
  client.type(first.message);
  client.el('composer-form').emit('submit');
  assert.notEqual(posted().requestId, first.requestId, 'a new send after acceptance gets a new ID');
  assert.equal(posted().message, first.message);
});

test('editing a failed draft creates a new submission and preserves its ID on further retry', async () => {
  const client = startClient();
  await ready(client);
  const posted = () => JSON.parse(client.findRequest('api/message').options.body ?? '');
  client.type('Original payload');
  client.el('composer-form').emit('submit');
  const original = posted();
  client.findRequest('api/message').reject(new TypeError('fetch failed'));
  await client.flush();
  client.el('retry-session').emit('click');
  client.findRequest(sessionPath(initialId)).resolve(session());
  await client.flush();
  client.type('Edited payload');
  client.el('composer-form').emit('submit');
  const edited = posted();
  assert.notEqual(edited.requestId, original.requestId);
  assert.equal(edited.message, 'Edited payload');
  client.findRequest('api/message').reject(new TypeError('fetch failed again'));
  await client.flush();
  client.el('retry-session').emit('click');
  client.findRequest(sessionPath(initialId)).resolve(session());
  await client.flush();
  client.el('composer-form').emit('submit');
  assert.deepEqual(posted(), edited);
});


test('BFCache suspension aborts reads without closing and restoration reconnects before sending', async () => {
  const client = startClient();
  await ready(client);
  client.type('Draft kept through browser Back');
  client.advance(2000);
  client.advance(10000);
  const sessionRead = client.findRequest(sessionPath(initialId));
  const listRead = client.findRequest('api/sessions');
  client.window.emit('pagehide', { persisted: true });
  assert.equal(sessionRead.options.signal.aborted, true);
  assert.equal(listRead.options.signal.aborted, true);
  assert.equal(client.el('message').disabled, true);
  await client.flush();
  const suspendedCount = client.requests.length;
  client.advance(2000);
  client.advance(10000);
  client.window.emit('online');
  client.document.emit('visibilitychange');
  assert.equal(client.requests.length, suspendedCount);
  assert.equal(client.timers.size, 0, 'aborted read finalizers do not schedule polling while suspended');
  client.window.emit('pageshow', { persisted: true });
  assert.equal(client.requests.length, suspendedCount + 2);
  assert.equal(client.el('message').disabled, true, 'restoration requires a fresh session read');
  client.findRequest(sessionPath(initialId)).resolve(session());
  client.findRequest('api/sessions').resolve(sessionList);
  await client.flush();
  assert.equal(client.el('message').disabled, false);
  assert.equal(client.el('message').value, 'Draft kept through browser Back');
  assert.equal(client.el('close-chat').disabled, false);
  client.el('composer-form').emit('submit');
  assert.equal(client.requests.filter(r => r.path === 'api/message').length, 1);
});

test('BFCache restoration never reopens an explicitly closed chat', async () => {
  const client = startClient();
  await ready(client);
  client.el('close-chat').emit('click');
  client.findRequest('api/close').resolve({ closed: true });
  await client.flush();
  const closedCount = client.requests.length;
  client.window.emit('pagehide', { persisted: true });
  client.window.emit('pageshow', { persisted: true });
  await client.flush();
  client.advance(2000);
  client.advance(10000);
  assert.equal(client.requests.length, closedCount);
  assert.equal(client.el('message').disabled, true);
  assert.equal(client.el('close-chat').disabled, true);
  assert.match(client.el('connection-text').textContent, /Chat closed/);
});


test('chat grid assigns stable rows so a hidden connection banner cannot displace the composer', () => {
  const css = /<style>([\s\S]*?)<\/style>/.exec(rendered)?.[1];
  assert(css);
  assert.match(css, /\.chat\s*\{[^}]*grid-template-rows:\s*auto auto minmax\(0, 1fr\) auto/);
  for (const [selector, row] of [['chat-header', 1], ['connection-banner', 2], ['conversation', 3], ['composer-region', 4]]) {
    assert.match(css, new RegExp('\\.' + selector + '\\s*\\{[^}]*grid-row:\\s*' + row + ';'));
  }
});
