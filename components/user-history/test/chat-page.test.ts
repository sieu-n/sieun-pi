import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Script, createContext } from 'node:vm';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { renderChatPage, chatContentSecurityPolicy } from '../src/chat-page.ts';
import type { ChatModel, ChatView } from '../src/chat-backend.ts';

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
  assert(!elements.some(n => ['iframe', 'a', 'link', 'base', 'object', 'embed'].includes(n.tagName)));
  assert.equal(elements.filter(n => n.tagName === 'img').length, 1, 'only the empty image viewer is in the page');
  assert(elements.find(n => n.tagName === 'img')?.attrs.some(a => a.name === 'id' && a.value === 'image-full'));
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
  for (const id of ['model-panel', 'usage-panel', 'image-viewer', 'attachment-error']) assert(byId(id)?.attrs.some(a => a.name === 'hidden'));
  for (const id of ['model-button', 'usage-button', 'attach-button', 'model-close', 'usage-close', 'image-close']) assert.equal(byId(id)?.tagName, 'button');
  assert.equal(byId('image-input')?.attrs.find(a => a.name === 'type')?.value, 'file');
  assert(!rendered.includes('Local chat · Drafts stay in this tab'));
  for (const id of ['composer-target', 'composer-help']) assert(byId(id)?.attrs.some(a => a.name === 'class' && a.value.includes('sr-only')));
});

type InputFile = { name: string; type: string; size: number };
type Event = {
  key?: string; shiftKey?: boolean; isComposing?: boolean; keyCode?: number; persisted?: boolean;
  target?: Element;
  clipboardData?: { items: { kind: string; getAsFile: () => InputFile | null }[] };
  dataTransfer?: { types?: string[]; files?: InputFile[] };
  preventDefault: () => void;
};
class Events {
  listeners = new Map<string, ((event: Event) => unknown)[]>();
  addEventListener(name: string, callback: (event: Event) => unknown): void {
    this.listeners.set(name, [...this.listeners.get(name) ?? [], callback]);
  }
  emit(name: string, fields: Omit<Partial<Event>, 'preventDefault'> = {}): boolean {
    let prevented = false;
    const event: Event = { ...(this instanceof Element ? { target: this } : {}), ...fields, preventDefault: () => { prevented = true; } };
    for (const callback of this.listeners.get(name) ?? []) callback(event);
    return prevented;
  }
}
class Element extends Events {
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  children: Element[] = [];
  className = '';
  tagName = 'div';
  files: InputFile[] = [];
  src = '';
  alt = '';
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
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string): void { this.attributes.delete(name); if (name === 'src') this.src = ''; }
  click(): void { if (!this.disabled) this.emit('click'); }
  append(...children: Element[]): void { this.children.push(...children); }
  replaceChildren(...children: Element[]): void { this.text = ''; this.innerHTML = ''; this.children = children; }
  contains(element: Element | null): boolean { return this === element || this.children.some(child => child.contains(element)); }
  matches(selector: string): boolean {
    const [tag, className] = selector.split('.');
    return (!tag || this.tagName === tag) && (!className || this.className.split(' ').includes(className));
  }
  closest(selector: string): Element | null { return this.matches(selector) ? this : null; }
  querySelectorAll(selector: string): Element[] { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector: string): Element | null { return this.querySelectorAll(selector)[0] ?? null; }
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
    createElement(tagName: string) { const element = new Element(); element.tagName = tagName; return element; },
  });
  const documentState: { activeElement: Element | null } = document;
  for (const node of nodes(parse(rendered))) {
    if (!('tagName' in node)) continue;
    const id = node.attrs.find(a => a.name === 'id')?.value;
    const element = node.tagName === 'body' ? document.body : new Element();
    element.tagName = node.tagName;
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
  const imageReads: { file: InputFile; resolve: (data?: string) => void; reject: () => void }[] = [];
  class FileReader extends Events {
    result: string | null = null;
    readAsDataURL(file: InputFile): void {
      imageReads.push({ file, resolve: (data = 'aW1hZ2U=') => {
        this.result = 'data:' + file.type + ';base64,' + data;
        this.emit('load');
      }, reject: () => { this.emit('error'); } });
    }
  }
  const context = createContext({
    document, window, navigator, AbortController, Error, TypeError, DOMException, FileReader,
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
  const upload = (files: InputFile[]) => { el('image-input').files = files; el('image-input').emit('change'); };
  const chooseModel = (id: string) => {
    const button = el('model-options').children.find(item => item.dataset.modelId === id);
    assert(button, id); button.click();
  };
  return { el, document, window, navigator, requests, flush, findRequest, select, type, advance, timers, imageReads, upload, chooseModel };
}
const initialId = 'session/a?b';
const secondId = 'other#session';
const agentId = 'agent/<opaque>';
const sessionPath = (id: string) => 'api/session?id=' + encodeURIComponent(id);
const visionModel = { provider: 'native', id: 'vision', name: 'Native vision', contextWindow: 200000, input: ['text', 'image'] } satisfies ChatModel;
const textModel = { provider: 'native', id: 'text', name: 'Native text', contextWindow: 100000, input: ['text'] } satisfies ChatModel;
const otherModel = { ...visionModel, provider: 'unconfigured', id: 'other', name: 'Other model' } satisfies ChatModel;
const usage = { kind: 'native-session', inputTokens: 1200, outputTokens: 450, cost: 0.045, context: { tokens: 3000, contextWindow: 200000, percent: 1.5 }, providerLimits: 'unavailable' } satisfies ChatView['usage'];
const controls = { kind: 'live', currentModel: visionModel, canChangeModel: true } satisfies ChatView['controls'];
const session = (id = initialId, extra = {}) => ({ id, name: id === initialId ? 'First conversation' : 'Second conversation', status: 'idle', writable: true, html: '<article class="pair">Saved transcript</article>', queueCount: 0, controls, usage, ...extra });
const modelsPath = (id: string) => 'api/models?id=' + encodeURIComponent(id);
const catalog = (id = initialId) => ({ sessionId: id, models: [visionModel, textModel, otherModel], configuredProviders: ['native'] });
const imageFile = (extra = {}) => ({ name: 'image.png', type: 'image/png', size: 512, ...extra });
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
  assert.equal(client.el('send-notice').hidden, true);
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
  assert.match(client.el('send-notice').textContent, /Retry unchanged to check the same submission/);
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


test('model catalog opens with usable models and current first; search and More models expose the full catalog', async () => {
  const client = startClient();
  await ready(client);
  assert.equal(client.el('model-label').textContent, visionModel.name);
  assert.equal(client.el('model-panel').hidden, true);
  assert(!client.requests.some(request => request.path.startsWith('api/models')));
  client.el('model-button').click();
  client.findRequest(modelsPath(initialId)).resolve({ ...catalog(), models: [otherModel, textModel, visionModel] });
  await client.flush();
  const options = client.el('model-options').children;
  assert.equal(options.length, 2);
  assert.deepEqual(options.map(option => option.dataset.modelId), [visionModel.id, textModel.id]);
  assert.equal(options[0]?.attributes.get('aria-pressed'), 'true');
  assert.equal(client.el('model-more').hidden, false);
  client.el('model-search').value = otherModel.id;
  client.el('model-search').emit('input');
  assert.equal(client.el('model-options').children.length, 1);
  assert.equal(client.el('model-options').children[0]?.dataset.modelId, otherModel.id);
  assert.equal(client.el('model-options').children[0]?.disabled, true);
  assert.equal(client.el('model-more').hidden, true);
  client.el('model-search').value = '';
  client.el('model-search').emit('input');
  assert.equal(client.el('model-options').children.length, 2);
  client.el('model-more').click();
  const expanded = client.el('model-options').children;
  assert.equal(expanded.length, 3);
  assert.deepEqual(expanded.map(option => option.dataset.modelId), [visionModel.id, textModel.id, otherModel.id]);
  assert.equal(expanded[2]?.disabled, true);
  assert.match(expanded[2]?.textContent ?? '', /Unavailable/);
  assert.equal(client.el('model-more').hidden, true);
  client.chooseModel(otherModel.id);
  assert(!client.requests.some(request => request.path === 'api/model'));
  client.document.emit('keydown', { key: 'Escape' });
  assert.equal(client.el('model-panel').hidden, true);
  client.el('model-button').click();
  client.findRequest(modelsPath(initialId)).resolve(catalog());
  await client.flush();
  assert.equal(client.el('model-options').children.length, 2, 'reopening starts with the compact model list');
});

test('a current model remains first in the compact catalog even when its provider is unavailable', async () => {
  const client = startClient();
  client.findRequest('api/sessions').resolve(sessionList);
  client.findRequest(sessionPath(initialId)).resolve(session(initialId, { controls: { ...controls, currentModel: otherModel } }));
  await client.flush();
  client.el('model-button').click();
  client.findRequest(modelsPath(initialId)).resolve(catalog());
  await client.flush();
  const options = client.el('model-options').children;
  assert.equal(options.length, 3);
  assert.equal(options[0]?.dataset.modelId, otherModel.id);
  assert.equal(options[0]?.disabled, true);
  assert.equal(options[0]?.attributes.get('aria-pressed'), 'true');
  assert.equal(client.el('model-more').hidden, true);
});

test('stale model catalogs and detached option handlers cannot act on a new selection', async () => {
  const client = startClient({ abortRequests: false });
  await ready(client);
  client.el('model-button').click();
  const stale = client.findRequest(modelsPath(initialId));
  client.select(secondId);
  client.findRequest(sessionPath(secondId)).resolve(session(secondId, { controls: { ...controls, currentModel: textModel } }));
  await client.flush();
  client.el('model-button').click();
  client.findRequest(modelsPath(secondId)).resolve(catalog(secondId));
  await client.flush();
  const currentOption = client.el('model-options').children[0];
  assert(currentOption);
  stale.resolve({ ...catalog(), models: [{ ...visionModel, name: 'STALE MODEL' }] });
  await client.flush();
  assert(!client.el('model-options').textContent.includes('STALE MODEL'));
  assert.equal(client.el('model-label').textContent, textModel.name);
  client.select(initialId);
  client.findRequest(sessionPath(initialId)).resolve(session());
  await client.flush();
  currentOption.emit('click');
  assert(!client.requests.some(request => request.path === 'api/model'));
});

test('model changes target the selected session and require fresh readback before reenabling controls', async () => {
  const client = startClient({ abortRequests: false });
  await ready(client);
  client.el('model-button').click();
  client.findRequest(modelsPath(initialId)).resolve(catalog());
  await client.flush();
  client.advance(2000);
  const oldRead = client.findRequest(sessionPath(initialId));
  client.chooseModel(textModel.id);
  const change = client.findRequest('api/model');
  assert.equal(change.options.method, 'POST');
  assert.equal(change.options.headers?.['X-Chat-Token'], 'test-token');
  assert.deepEqual(JSON.parse(change.options.body ?? ''), { sessionId: initialId, provider: 'native', modelId: 'text' });
  assert.equal(client.el('model-button').disabled, true);
  assert.equal(client.el('message').disabled, true);
  change.resolve({ model: textModel });
  await client.flush();
  assert.equal(client.el('model-label').textContent, visionModel.name, 'POST result never updates selection directly');
  assert.equal(client.el('model-button').disabled, true);
  oldRead.resolve(session());
  await client.flush();
  assert.equal(client.el('model-button').disabled, true, 'a pre-mutation read cannot unlock controls');
  const readback = client.findRequest(sessionPath(initialId));
  assert.notEqual(readback, oldRead);
  readback.resolve(session(initialId, { controls: { ...controls, currentModel: textModel } }));
  await client.flush();
  assert.equal(client.el('model-label').textContent, textModel.name);
  assert.equal(client.el('model-button').disabled, false);
  assert.equal(client.el('model-panel').hidden, true);
});

test('model mutation results cannot replace another session model and busy or sending sessions cannot change models', async () => {
  const client = startClient();
  await ready(client);
  client.el('model-button').click();
  client.findRequest(modelsPath(initialId)).resolve(catalog());
  await client.flush();
  client.chooseModel(textModel.id);
  const change = client.findRequest('api/model');
  client.select(secondId);
  client.findRequest(sessionPath(secondId)).resolve(session(secondId));
  await client.flush();
  change.resolve({ model: textModel });
  await client.flush();
  assert.equal(client.el('model-label').textContent, visionModel.name);
  assert.equal(client.el('model-button').disabled, true);
  assert.equal(client.el('model-panel').hidden, true);
  client.findRequest(sessionPath(secondId)).resolve(session(secondId));
  await client.flush();
  assert.equal(client.el('model-button').disabled, false);
  client.type('Pending message');
  client.el('composer-form').emit('submit');
  assert.equal(client.el('model-button').disabled, true);
  client.select(initialId);
  client.findRequest(sessionPath(initialId)).resolve(session());
  await client.flush();
  assert.equal(client.el('model-button').disabled, true, 'a send in another session also blocks default-changing model mutations');
  client.findRequest('api/message').resolve({ accepted: true });
  await client.flush();
  assert.equal(client.el('model-button').disabled, false);
  client.advance(2000);
  client.findRequest(sessionPath(initialId)).resolve(session(initialId, { status: 'running', controls: { ...controls, canChangeModel: false } }));
  await client.flush();
  assert.equal(client.el('model-button').disabled, true);
  assert.equal(client.el('session-status').textContent, 'Running');
});

test('uncertain model changes read back before retry and never retry the mutation automatically', async () => {
  const client = startClient();
  await ready(client);
  client.el('model-button').click();
  client.findRequest(modelsPath(initialId)).resolve(catalog());
  await client.flush();
  client.chooseModel(textModel.id);
  client.findRequest('api/model').reject(new TypeError('fetch failed'));
  await client.flush();
  assert.equal(client.el('model-button').disabled, true);
  assert.match(client.el('model-notice').textContent, /Reading the current model before retry/);
  client.findRequest(sessionPath(initialId)).resolve({ error: 'Cannot read session' }, 503);
  await client.flush();
  assert.equal(client.el('model-button').disabled, true);
  client.el('retry-session').click();
  client.findRequest(sessionPath(initialId)).resolve(session(initialId, { controls: { ...controls, currentModel: textModel } }));
  await client.flush();
  assert.equal(client.el('model-button').disabled, false);
  assert.equal(client.el('model-label').textContent, textModel.name);
  assert.equal(client.requests.filter(request => request.path === 'api/model').length, 1);
  assert(!client.el('model-notice').textContent.includes('Reading'));
  assert.match(client.el('model-notice').textContent, /Model change was not confirmed/);
});

test('usage popup shows only selected session totals and labels unavailable quotas and context estimates', async () => {
  const client = startClient();
  await ready(client);
  assert.equal(client.el('usage-panel').hidden, true);
  client.el('usage-button').click();
  const usageText = client.el('usage-content').textContent;
  assert.deepEqual(client.el('usage-content').querySelectorAll('dt').map(item => item.textContent), ['Input', 'Output', 'Cost', 'Context']);
  assert.deepEqual(client.el('usage-content').querySelectorAll('dd').map(item => item.textContent), ['1,200', '450', '$0.0450', '3,000 / 200,000 (1.5%) · Estimate']);
  assert.match(usageText, /Own session usage, including cache\. Account limits unavailable/);
  client.select(secondId);
  client.findRequest(sessionPath(secondId)).resolve(session(secondId, { usage: { kind: 'unavailable', reason: 'not-recorded', context: null, providerLimits: 'unavailable' } }));
  await client.flush();
  assert.equal(client.el('usage-panel').hidden, true);
  client.el('usage-button').click();
  assert.match(client.el('usage-content').textContent, /Not recorded/);
  assert(!client.el('usage-content').textContent.includes('1,200'));
  assert.match(client.el('usage-content').textContent, /Estimate unavailable/);
});

test('file reads stay with their original draft across session switches', async () => {
  const client = startClient();
  await ready(client);
  client.type('First image draft');
  client.upload([imageFile()]);
  assert.equal(client.el('send').disabled, true, 'wait for the file read');
  client.select(secondId);
  client.findRequest(sessionPath(secondId)).resolve(session(secondId));
  await client.flush();
  client.type('Second text draft');
  client.imageReads[0]?.resolve();
  await client.flush();
  assert.equal(client.el('attachment-previews').children.length, 0);
  assert.equal(client.el('message').value, 'Second text draft');
  client.select(initialId);
  client.findRequest(sessionPath(initialId)).resolve(session());
  await client.flush();
  assert.equal(client.el('attachment-previews').children.length, 1);
  assert.equal(client.el('attachment-previews').querySelector('img')?.src, 'data:image/png;base64,aW1hZ2U=');
  assert.equal(client.el('message').value, 'First image draft');
  assert.equal(client.el('send').disabled, false);
});

test('image-only messages send native image content and acceptance removes previews without permanent notices', async () => {
  const client = startClient();
  await ready(client);
  client.upload([imageFile()]);
  client.imageReads[0]?.resolve();
  await client.flush();
  assert.equal(client.el('send').disabled, false);
  client.el('composer-form').emit('submit');
  const send = client.findRequest('api/message');
  assert.deepEqual(JSON.parse(send.options.body ?? ''), { sessionId: initialId, message: '', requestId: 'request-1', images: [{ type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }] });
  assert.equal(client.el('attach-button').disabled, true);
  assert.equal(client.el('attachment-previews').querySelector('button')?.disabled, true);
  send.resolve({ accepted: true });
  await client.flush();
  assert.equal(client.el('attachment-previews').children.length, 0);
  assert.equal(client.el('send-notice').hidden, true);
});

test('nonvision models reject image paste and preserve existing images until a vision model is chosen or images removed', async () => {
  const client = startClient();
  await ready(client);
  client.upload([imageFile()]);
  client.imageReads[0]?.resolve();
  await client.flush();
  client.advance(2000);
  client.findRequest(sessionPath(initialId)).resolve(session(initialId, { controls: { ...controls, currentModel: textModel } }));
  await client.flush();
  client.type('Text with an existing image');
  assert.equal(client.el('send').disabled, true);
  assert.equal(client.el('attach-button').disabled, true);
  assert.match(client.el('attachment-error').textContent, /model that accepts images/);
  client.el('composer-form').emit('submit');
  assert(!client.requests.some(request => request.path === 'api/message'));
  assert.equal(client.el('message').emit('paste', { clipboardData: { items: [{ kind: 'file', getAsFile: () => imageFile() }] } }), true);
  assert.equal(client.imageReads.length, 1);
  client.el('attachment-previews').querySelector('button')?.click();
  assert.equal(client.el('send').disabled, false, 'removing incompatible images allows the text draft');
});

test('image retries retain request IDs for unchanged payloads and replacing an image creates a new submission', async () => {
  const client = startClient();
  await ready(client);
  client.upload([imageFile()]);
  client.imageReads[0]?.resolve();
  await client.flush();
  client.el('composer-form').emit('submit');
  const first = JSON.parse(client.findRequest('api/message').options.body ?? '');
  client.findRequest('api/message').reject(new TypeError('fetch failed'));
  await client.flush();
  assert.equal(client.el('attachment-previews').children.length, 1);
  client.select(secondId);
  client.findRequest(sessionPath(secondId)).resolve(session(secondId));
  await client.flush();
  client.select(initialId);
  client.findRequest(sessionPath(initialId)).resolve(session());
  await client.flush();
  client.el('composer-form').emit('submit');
  assert.deepEqual(JSON.parse(client.findRequest('api/message').options.body ?? ''), first);
  client.findRequest('api/message').reject(new TypeError('fetch failed again'));
  await client.flush();
  client.el('retry-session').click();
  client.findRequest(sessionPath(initialId)).resolve(session());
  await client.flush();
  client.el('attachment-previews').querySelector('button')?.click();
  client.upload([imageFile()]);
  client.imageReads[1]?.resolve('bmV3');
  await client.flush();
  client.el('composer-form').emit('submit');
  const changed = JSON.parse(client.findRequest('api/message').options.body ?? '');
  assert.notEqual(changed.requestId, first.requestId);
  assert.equal(changed.images[0].data, 'bmV3');
});

test('file validation enforces image type, per-file size, total size, and count before reads', async () => {
  const client = startClient();
  await ready(client);
  client.upload([imageFile({ type: 'image/svg+xml' }), imageFile({ size: 3 * 1024 * 1024 + 1 }), imageFile({ size: 0 })]);
  assert.equal(client.imageReads.length, 0);
  assert.equal(client.el('attachment-error').hidden, false);
  client.upload([imageFile({ size: 3 * 1024 * 1024 }), imageFile({ size: 3 * 1024 * 1024 }), imageFile({ size: 3 * 1024 * 1024 })]);
  assert.equal(client.imageReads.length, 2);
  assert.match(client.el('attachment-error').textContent, /8 MiB/);
  client.upload([imageFile(), imageFile(), imageFile()]);
  assert.equal(client.imageReads.length, 4);
  assert.match(client.el('attachment-error').textContent, /4 images/);
  assert.equal(client.el('attach-button').disabled, true);
  for (const read of client.imageReads) read.resolve();
  await client.flush();
  assert.equal(client.el('attachment-previews').children.length, 4);
});

test('paste and drop read local files only, and removed pending reads cannot return to the draft', async () => {
  const client = startClient();
  await ready(client);
  assert.equal(client.el('message').emit('paste', { clipboardData: { items: [{ kind: 'file', getAsFile: () => imageFile() }] } }), true);
  client.el('attachment-previews').querySelector('button')?.click();
  client.imageReads[0]?.resolve();
  await client.flush();
  assert.equal(client.el('attachment-previews').children.length, 0);
  assert.equal(client.document.emit('dragover', { dataTransfer: { types: ['Files'] } }), true);
  assert.equal(client.document.emit('drop', { dataTransfer: { files: [imageFile({ name: 'dropped.png' })] } }), true);
  client.imageReads[1]?.resolve();
  await client.flush();
  assert.equal(client.el('attachment-previews').querySelector('img')?.alt, 'dropped.png');
  assert.equal(client.requests.length, 2, 'no image upload or external fetch occurs');
});

test('read-only and pending-send sessions reject upload, paste, and drop', async () => {
  const client = startClient();
  await ready(client);
  client.type('Pending text');
  client.el('composer-form').emit('submit');
  client.upload([imageFile()]);
  client.el('message').emit('paste', { clipboardData: { items: [{ kind: 'file', getAsFile: () => imageFile() }] } });
  client.document.emit('drop', { dataTransfer: { files: [imageFile()] } });
  assert.equal(client.imageReads.length, 0);
  client.select(secondId);
  client.findRequest(sessionPath(secondId)).resolve(session(secondId, { writable: false, controls: { kind: 'saved', currentModel: null, canChangeModel: false } }));
  await client.flush();
  client.upload([imageFile()]);
  client.document.emit('drop', { dataTransfer: { files: [imageFile()] } });
  assert.equal(client.el('attach-button').disabled, true);
  assert.equal(client.imageReads.length, 0);
});

test('sent image buttons open validated data images, close with Escape, and reject external sources', async () => {
  const client = startClient();
  await ready(client);
  const button = new Element(); button.tagName = 'button'; button.className = 'chat-image-button';
  const image = new Element(); image.tagName = 'img'; image.className = 'chat-image';
  image.setAttribute('src', 'data:image/png;base64,aW1hZ2U=');
  image.alt = 'Saved image';
  button.append(image);
  client.el('transcript').append(button);
  client.el('transcript').emit('click', { target: button });
  assert.equal(client.el('image-viewer').hidden, false);
  assert.equal(client.el('image-full').src, 'data:image/png;base64,aW1hZ2U=');
  assert.equal(client.document.emit('keydown', { key: 'Tab' }), true);
  client.document.emit('keydown', { key: 'Escape' });
  assert.equal(client.el('image-viewer').hidden, true);
  assert.equal(client.el('image-full').src, '');
  image.setAttribute('src', 'https://evil.invalid/image.png');
  client.el('transcript').emit('click', { target: image });
  assert.equal(client.el('image-viewer').hidden, true);
});

test('idle header status stays hidden and sidebar status is a labelled dot without visible metadata', async () => {
  const client = startClient();
  await ready(client);
  assert.equal(client.el('session-status').hidden, true);
  const first = client.el('session-list').children[0]?.children[0];
  assert(first);
  const dot = first.children[1];
  assert.equal(dot?.textContent, '');
  assert.equal(first.attributes.get('aria-label'), 'First conversation');
  assert.equal(client.el('session-list').children[1]?.children[0]?.attributes.get('aria-label'), 'Second conversation, Running');
  assert.equal(dot?.attributes.get('aria-label'), undefined);
  assert.equal(dot?.attributes.get('aria-hidden'), 'true');
  assert.equal(client.el('list-heading').textContent, 'Recent chats');
  assert.equal(dot?.attributes.get('title'), 'Idle');
  assert.equal(dot?.dataset.status, 'idle');
  client.el('view-agents').click();
  assert.equal(client.el('session-list').children[0]?.children[0]?.attributes.get('aria-label'), 'Research agent, Read-only');
});


test('model controls reject malformed data and never offer a catalog from a different session', async () => {
  const client = startClient();
  await ready(client);
  client.el('model-button').click();
  client.findRequest(modelsPath(initialId)).resolve(catalog(secondId));
  await client.flush();
  assert.equal(client.el('model-options').children.length, 0);
  assert.match(client.el('model-notice').textContent, /invalid model list/);
  client.el('model-close').click();
  client.advance(2000);
  client.findRequest(sessionPath(initialId)).resolve(session(initialId, { controls: { kind: 'live', currentModel: {}, canChangeModel: true } }));
  await client.flush();
  assert.equal(client.el('model-button').disabled, true);
  assert.equal(client.el('message').disabled, true);
  assert.match(client.el('connection-text').textContent, /invalid session controls/);
});

test('choosing a model after switching uses the new selection in the authenticated mutation', async () => {
  const client = startClient();
  await ready(client);
  client.select(secondId);
  client.findRequest(sessionPath(secondId)).resolve(session(secondId));
  await client.flush();
  client.el('model-button').click();
  client.findRequest(modelsPath(secondId)).resolve(catalog(secondId));
  await client.flush();
  client.chooseModel(textModel.id);
  assert.deepEqual(JSON.parse(client.findRequest('api/model').options.body ?? ''), { sessionId: secondId, provider: textModel.provider, modelId: textModel.id });
});
