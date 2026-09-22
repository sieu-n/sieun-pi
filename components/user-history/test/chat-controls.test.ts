import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ChatReadState } from "../src/chat-read-state.ts";
import { parsePoolListing, parsePoolResolution } from "../src/chat-pool.ts";
import { previewTitle, transcriptMessages } from "../src/chat-backend.ts";
import { renderChatMessages } from "../src/page.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

test("skill-only or truncated previews never display injected markup", () => {
  assert.equal(previewTitle('<skill name="proof" location="/private/skill.md">\nInstructions'), 'Untitled session');
  assert.equal(previewTitle('<skill name="proof" location="/private/skill.md">\nInstructions\n</skill>\n\nActual request'), 'Actual request');
  assert.equal(previewTitle('Ordinary user message'), 'Ordinary user message');
  assert.equal(previewTitle(''), 'Untitled session');
});

test("native error-only and aborted messages remain visible without thinking", () => {
  for (const stopReason of ['error', 'aborted'] as const) {
    const messages = transcriptMessages([{ id: 'failure', type: 'message', parentId: null, timestamp: new Date().toISOString(), message: {
      role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE THINKING' }], api: 'test', provider: 'test', model: 'test',
      stopReason, errorMessage: 'Native ' + stopReason, timestamp: 100, usage,
    } }]);
    assert.equal(messages[0]?.outcome, stopReason);
    const html = renderChatMessages(messages);
    assert(html.includes('Native ' + stopReason)); assert(!html.includes('PRIVATE THINKING'));
  }
});

test("native tool details stay collapsed and tool payload HTML stays inert", () => {
  const messages = transcriptMessages([
    { id: 'call', type: 'message', parentId: null, timestamp: new Date().toISOString(), message: { role: 'assistant',
      content: [{ type: 'toolCall', id: 'tool-1', name: 'proof', arguments: { text: '<script>bad()</script>' } }],
      api: 'test', provider: 'test', model: 'test', stopReason: 'toolUse', timestamp: 100, usage } },
    { id: 'result', type: 'message', parentId: 'call', timestamp: new Date().toISOString(), message: { role: 'toolResult', toolCallId: 'tool-1', toolName: 'proof',
      content: [{ type: 'text', text: '<img src=x onerror=bad()>\nSecond line' }], isError: false, timestamp: 200, details: { durationMs: 42 } } },
  ]);
  assert.equal(messages[0]?.tools?.[0]?.durationMs, 42);
  const html = renderChatMessages(messages);
  assert(html.includes('<details class="tool"')); assert(!html.includes('<details open')); assert(!html.includes('<script>'));
  assert(html.includes('&lt;img')); assert(html.includes('0.0s')); assert(html.includes('complete'));
  assert(!html.includes('Second line')); assert(!html.includes('bad()&lt;/script'));
  assert(html.includes('data-tool-id="tool-1"')); assert(html.includes('Open to load native arguments and output.'));
});

test("pool boundary omits secrets and patch health, preserves unavailable percentages", () => {
  const listing = parsePoolListing({ provider: 'anthropic', session: 'sid', patched: false, secret: 'omit', rows: [{
    id: 'account', email: 'a@example.test', usage: 'stale', session_pct: -1, weekly_pct: null, usable: false,
    reason: 'reauth', current: true, pinned: false, force: false, live: true, seat: true, score: null, token: 'omit',
  }] }, 'anthropic', 'sid');
  assert.equal(listing.kind, 'pool');
  if (listing.kind !== 'pool') return;
  assert.equal(listing.rows[0]?.session_pct, null); assert.equal(listing.rows[0]?.reason, 'reauth');
  assert(!JSON.stringify(listing).includes('omit')); assert(!JSON.stringify(listing).includes('patched'));
  assert.throws(() => parsePoolListing({ provider: 'wrong', session: 'sid', rows: [] }, 'anthropic', 'sid'));
  assert.throws(() => parsePoolListing({ provider: 'anthropic', session: 'other', rows: [] }, 'anthropic', 'sid'));
});

test("read markers initialize once, avoid writes on reads, and merge independent listeners monotonically", async () => {
  const base = process.env.HISTORY_TEST_ARTIFACTS_DIR ?? join(process.cwd(), '.test-artifacts'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'read-state-')); const path = join(root, 'read.json');
  try {
    const one = new ChatReadState(path); const two = new ChatReadState(path);
    const initial = await one.snapshot(); const before = await stat(path);
    assert.equal((await two.snapshot()).baseline, initial.baseline);
    assert.equal((await stat(path)).mtimeMs, before.mtimeMs);
    await Promise.all([one.mark('one', { entryId: 'new', timestamp: 20 }), two.mark('two', { entryId: 'other', timestamp: 10 })]);
    await two.mark('one', { entryId: 'old', timestamp: 1 });
    const state = await one.snapshot(); assert.equal(state.sessions.one?.entryId, 'new'); assert.equal(state.sessions.two?.entryId, 'other');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await mkdir(path + '.lock'); await writeFile(path + '.lock/pid', '2147483647');
    await one.mark('three', { entryId: 'recovered', timestamp: 30 }); assert.equal((await one.snapshot()).sessions.three?.entryId, 'recovered');
    await writeFile(path, '{broken'); await assert.rejects(one.snapshot()); assert.equal(await readFile(path, 'utf8'), '{broken');
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("separate listener processes cannot overwrite each other's read markers", async () => {
  const base = process.env.HISTORY_TEST_ARTIFACTS_DIR ?? join(process.cwd(), '.test-artifacts'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'read-processes-')); const path = join(root, 'read.json');
  try {
    await new ChatReadState(path).snapshot();
    const script = `import { ChatReadState } from ${JSON.stringify(new URL('../src/chat-read-state.ts', import.meta.url).href)};
      const state = new ChatReadState(process.argv[1]);
      for (let i = 1; i <= 8; i++) await state.mark(process.argv[2], { entryId: String(i), timestamp: i });`;
    await Promise.all(['a', 'b', 'c'].map(id => promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, path, id])));
    const state = await new ChatReadState(path).snapshot();
    for (const id of ['a', 'b', 'c']) assert.equal(state.sessions[id]?.timestamp, 8);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('who resolution validates selected session/provider and omits unrelated provider data', () => {
  const result = parsePoolResolution({ session: 'sid', providers: { anthropic: { account: 'effective', email: 'email', reason: 'seat_move', pinned: false, shadowed: ['secret'], at: 1 }, 'openai-codex': { error: '/private/credentials' } } }, 'anthropic', 'sid');
  assert.deepEqual(result, { kind: 'resolved', accountId: 'effective', source: 'seat_move', pinned: false });
  assert.deepEqual(parsePoolResolution({ session: 'sid', providers: { anthropic: { error: '/private/credentials' } } }, 'anthropic', 'sid'), { kind: 'unavailable' });
  assert.throws(() => parsePoolResolution({ session: 'other', providers: {} }, 'anthropic', 'sid'));
});

test('tool-only messages omit empty text blocks and use compact tool rows', () => {
  const html = renderChatMessages([{ id: 'call', role: 'assistant', text: '', streaming: false, images: [], tools: [{ id: 'tool', name: 'proof', status: 'running', summary: 'Executing', args: {}, output: '', revision: '1' }] }]);
  assert(html.includes('class="response tool-only"')); assert(!html.includes('class="block"'));
  const ordinary = renderChatMessages([{ id: 'text', role: 'assistant', text: 'Real reply', streaming: false, images: [] }]);
  assert(!ordinary.includes('tool-only')); assert(ordinary.includes('class="block"'));
});
