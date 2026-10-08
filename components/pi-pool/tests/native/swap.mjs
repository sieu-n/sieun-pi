import { isolationEnv, assertNoIsolationViolations } from './isolation.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { EventEmitter, once } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const poolSource = join(here, '..', '..');
const install = process.argv[2] ?? process.env.PI_POOL_PRIME_AGENT_ROOT;
if (!install) throw new Error('Pass a copied Prime Agent install, or set PI_POOL_PRIME_AGENT_ROOT');
const output = process.env.PI_POOL_TEST_OUTPUT_DIR;
if (!output) throw new Error('PI_POOL_TEST_OUTPUT_DIR is required');
const expectation = process.env.FIXTURE_EXPECT ?? 'swap';
if (!['baseline', 'swap'].includes(expectation)) throw new Error('FIXTURE_EXPECT must be baseline or swap');
// What account c answers: a 429 with a one-hour reset, or the 400 Anthropic sent
// on 2026-10-08 while an account's Consumer Terms were pending.
const failure = process.env.FIXTURE_FAILURE ?? '429';
if (!['429', 'terms'].includes(failure)) throw new Error('FIXTURE_FAILURE must be 429 or terms');
const FAIL_STATUS = failure === 'terms' ? 400 : 429;
const TERMS_MESSAGE = "We've updated our Consumer Terms and Privacy Policy. You'll need to accept them in claude.ai with the email in /status to continue.";
const run = mkdtempSync(join(output, 'swap-'));
console.log(JSON.stringify({ run, expectation, failure }));

const C = 'cccc3333-0000-0000-0000-000000000000';
const D = 'dddd4444-0000-0000-0000-000000000000';
const SESSION = 'fixture-swap-session';
const RESET_SEC = 3600;

function jwt(accountId, label) {
  const claims = { exp: Math.floor(Date.now() / 1000) + 30 * 86400, fixture: label, 'https://api.openai.com/auth': { chatgpt_account_id: accountId } };
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.synthetic`;
}
function jwtLabel(header) {
  try { return JSON.parse(Buffer.from(header.replace(/^Bearer /, '').split('.')[1], 'base64url')).fixture; }
  catch { return 'missing'; }
}
function sse(response, text, n) {
  const item = { id: `msg_${n}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
  const result = { id: `resp_${n}`, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
  const events = [
    { type: 'response.created', response: { id: result.id, status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [], status: 'in_progress' } },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: result },
  ];
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
}

const pool = join(run, 'pool');
const tm = join(run, 'tm');
for (const path of [pool, tm]) mkdirSync(path, { recursive: true });
writeFileSync(join(tm, 'codex-accounts.json'), JSON.stringify({ version: 2, accounts: [C, D].map((id, i) => ({ id, email: `${'cd'[i]}@x`, label: `${'cd'[i]}@x`, tier: 'plus', windows: [] })) }));
for (const [id, label] of [[C, 'c'], [D, 'd']]) {
  mkdirSync(join(tm, 'codex-stores', id.slice(0, 8)), { recursive: true });
  writeFileSync(join(tm, 'codex-stores', id.slice(0, 8), 'auth.json'), JSON.stringify({ tokens: { access_token: jwt(id, label), refresh_token: 'synthetic' } }));
}
const emptyProvider = { pin: null, seat: null, cooldowns: {}, disabled: {} };
writeFileSync(join(pool, 'state.json'), JSON.stringify({ version: 2, providers: { anthropic: emptyProvider, 'openai-codex': { ...emptyProvider, pin: C } }, sessions: {} }));

const requests = [];
const bus = new EventEmitter();
const server = createServer(async (request, response) => {
  for await (const _chunk of request);
  const record = { n: requests.length + 1, at: Date.now(), path: request.url, keyLabel: jwtLabel(request.headers.authorization ?? '') };
  record.status = record.keyLabel === 'c' ? FAIL_STATUS : 200;
  requests.push(record);
  appendFileSync(join(run, 'http.jsonl'), JSON.stringify(record) + '\n');
  bus.emit('request', record);
  if (record.status === 429) {
    response.writeHead(429, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', plan_type: 'plus', resets_at: Math.floor(Date.now() / 1000) + RESET_SEC } }));
  } else if (record.status === 400) {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: TERMS_MESSAGE } }));
  } else sse(response, 'SYNTHETIC_SWAP_OK', record.n);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = server.address().port;

async function prime(name, withExtension) {
  const dir = join(run, name);
  const agentHome = join(dir, 'agent');
  for (const path of [agentHome, join(dir, 'home'), join(dir, 'tmp'), join(dir, 'cwd')]) mkdirSync(path, { recursive: true });
  writeFileSync(join(agentHome, 'auth.json'), '{}');
  writeFileSync(join(agentHome, 'settings.json'), JSON.stringify({
    defaultProvider: 'openai-codex', defaultModel: 'fixture-codex', defaultThinkingLevel: 'off', transport: 'sse',
    retry: { enabled: true, maxRetries: 3, baseDelayMs: 150, provider: { maxRetryDelayMs: 3000, timeoutMs: 3000, waitForUsage: { pauseUntilReset: false, maxWaitMs: 18300000, maxAttempts: 80 } } },
    compaction: { enabled: false }, autoRefine: { enabled: false }, packages: [], mcpServers: {}, quietStartup: true,
  }));
  writeFileSync(join(agentHome, 'models.json'), JSON.stringify({ providers: { 'openai-codex': {
    baseUrl: `http://127.0.0.1:${port}`, api: 'openai-codex-responses', apiKey: `!${join(poolSource, 'bin', 'pi-pool-token')} --provider openai-codex`,
    models: [{ id: 'fixture-codex', reasoning: false, input: ['text'], contextWindow: 100000, maxTokens: 1024 }],
  } } }));
  const env = {
    ...isolationEnv,
    HOME: join(dir, 'home'), TMPDIR: join(dir, 'tmp'), XDG_CONFIG_HOME: join(dir, 'home', '.config'),
    XDG_CACHE_HOME: join(dir, 'home', '.cache'), PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    PI_POOL_DIR: pool, TOKENMAXXING_HOME: tm, PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID: SESSION,
    PRIME_AGENT_CODING_AGENT_DIR: agentHome, PRIME_AGENT_SESSION_DIR: join(agentHome, 'sessions'),
    PRIME_AGENT_INTERNAL_LEGACY_OWNED_WORKER_FRONTEND: '1', PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1',
    NODE_COMPILE_CACHE: join(dir, 'node-cache'), NO_PROXY: '*', TERM: 'dumb',
  };
  const args = [join(install, 'dist/bundle/cli.js'), '--mode', 'rpc', '--offline', '--no-tools', '--no-extensions',
    ...(withExtension ? ['--extension', join(poolSource, 'app', 'extension', 'index.ts')] : []),
    '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--provider', 'openai-codex', '--model', 'fixture-codex', '--thinking', 'off'];
  const child = spawn(process.execPath, args, { cwd: join(dir, 'cwd'), env, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  const events = [];
  let pending = '';
  child.stdout.on('data', chunk => {
    appendFileSync(join(dir, 'stdout.jsonl'), chunk);
    pending += chunk;
    for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      try { const event = JSON.parse(line); events.push(event); bus.emit('event', event); } catch {}
    }
  });
  child.stderr.on('data', chunk => appendFileSync(join(dir, 'stderr.txt'), chunk));
  const waitFor = (predicate, timeout) => {
    const found = events.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise(resolve => {
      const timer = setTimeout(() => { bus.off('event', listener); resolve(undefined); }, timeout);
      const listener = event => { if (predicate(event)) { clearTimeout(timer); bus.off('event', listener); resolve(event); } };
      bus.on('event', listener);
    });
  };
  let commandId = 0;
  const rpc = (type, fields = {}) => {
    const id = `${name}-${++commandId}`;
    const answer = waitFor(event => event.type === 'response' && event.id === id, 20000);
    child.stdin.write(JSON.stringify({ id, type, ...fields }) + '\n');
    return answer;
  };
  await rpc('get_state');
  const startedAt = Date.now();
  const firstRequest = requests.length;
  await rpc('prompt', { message: 'Return SYNTHETIC_SWAP_OK.' });
  const done = await waitFor(event => event.type === 'message_end' && event.message.role === 'assistant' && event.message.stopReason === 'stop', 15000);
  const retryStart = events.find(event => event.type === 'auto_retry_start');
  if (!done) await rpc('abort_retry');
  child.stdin.end();
  const force = setTimeout(() => child.kill('SIGTERM'), 5000);
  await closed;
  clearTimeout(force);
  const assistants = events.filter(event => event.type === 'message_end' && event.message.role === 'assistant').map(event => event.message);
  const result = { name, withExtension, requests: requests.slice(firstRequest), retryStart, assistants: assistants.map(m => ({ stopReason: m.stopReason, errorMessage: m.errorMessage, diagnostics: m.diagnostics })), doneAfterMs: done ? Date.now() - startedAt : null };
  writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2));
  return result;
}

const readLog = () => existsSync(join(pool, 'pi-pool.log')) ? readFileSync(join(pool, 'pi-pool.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
const readState = () => JSON.parse(readFileSync(join(pool, 'state.json'), 'utf8'));
const summary = {};
try {
  if (expectation === 'baseline') {
    const base = await prime('baseline', false);
    summary.baseline = { requests: base.requests.map(r => `${r.keyLabel}:${r.status}`), waitMs: base.retryStart?.delayMs, reason: base.retryStart?.reason, errorMessage: base.assistants[0]?.errorMessage };
    assert.deepEqual(summary.baseline.requests, [`c:${FAIL_STATUS}`], 'without the extension the turn sends no second request');
    if (failure === 'terms') {
      assert.equal(base.retryStart, undefined, 'without the extension Prime treats the terms 400 as permanent and the turn fails');
      assert.match(base.assistants[0].errorMessage, /Consumer Terms/);
    } else {
      assert.equal(base.retryStart?.reason, 'usage');
      assert.ok(base.retryStart.delayMs > (RESET_SEC - 60) * 1000, 'without the extension Prime sleeps until the reset');
    }
  } else {
    const swapped = await prime('swap', true);
    summary.swap = { requests: swapped.requests.map(r => `${r.keyLabel}:${r.status}`), waitMs: swapped.retryStart?.delayMs, doneAfterMs: swapped.doneAfterMs, errorMessage: swapped.assistants[0]?.errorMessage };
    assert.deepEqual(summary.swap.requests, [`c:${FAIL_STATUS}`, 'd:200'], 'request 2 of the same turn uses the other account');
    assert.ok(swapped.retryStart.delayMs < 5000, `Prime retried after ${swapped.retryStart.delayMs}ms, not at the reset`);
    assert.ok(swapped.doneAfterMs < 10000, 'the turn finished on the new account');
    const log = readLog();
    summary.log = log.filter(e => ['limited', 'refused', 'vend'].includes(e.event));
    if (failure === 'terms') {
      assert.match(swapped.assistants[0].errorMessage, /pi-pool: c@x is out of the pool \(needs terms\); the retry uses d@x\./);
      assert.ok(log.some(e => e.event === 'refused' && e.account === 'c@x' && e.reason === 'needs terms' && e.next === 'd@x' && e.session === SESSION));
      assert.ok(log.some(e => e.event === 'vend' && e.account === 'd@x' && e.why === 'cooldown' && e.shadowed === C && e.previous === 'c@x'));
      const provider = readState().providers['openai-codex'];
      assert.equal(provider.cooldown_reasons[C], 'needs terms');
      assert.ok(provider.cooldowns[C] * 1000 > Date.now() + 23 * 3600 * 1000, 'the account stays out for a day unless a check or a sign-in clears it');
    } else {
      assert.match(swapped.assistants[0].errorMessage, /pi-pool: c@x is limited until .*; the retry uses d@x\./);
      assert.doesNotMatch(swapped.assistants[0].errorMessage, /Try again in/);
      assert.ok(log.some(e => e.event === 'limited' && e.account === 'c@x' && e.next === 'd@x' && e.session === SESSION));
      assert.ok(log.some(e => e.event === 'vend' && e.account === 'd@x' && e.why === 'limited' && e.shadowed === C && e.previous === 'c@x'));
      const limit = readState().providers['openai-codex'].limits[C];
      assert.ok(limit.until * 1000 > Date.now() + (RESET_SEC - 60) * 1000, 'the limit lasts until the provider reset');
    }

    const restarted = await prime('restart', true);
    summary.restart = { requests: restarted.requests.map(r => `${r.keyLabel}:${r.status}`) };
    assert.deepEqual(summary.restart.requests, ['d:200'], 'a new Prime process still avoids the account');
  }
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  writeFileSync(join(run, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
}
assertNoIsolationViolations();
