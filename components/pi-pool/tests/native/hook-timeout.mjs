import { isolationEnv, assertNoIsolationViolations } from './isolation.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { EventEmitter, once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Prime runs the apiKey command with a 10 s timeout. On 2026-10-08 a Mac in
// lid-closed dark wake slept in the middle of the pool hook, Prime killed it, and
// the turn ended with "Failed to resolve API key", which Prime never retries.
const here = dirname(fileURLToPath(import.meta.url));
const poolSource = join(here, '..', '..');
const install = process.argv[2] ?? process.env.PI_POOL_PRIME_AGENT_ROOT;
if (!install) throw new Error('Pass a copied Prime Agent install, or set PI_POOL_PRIME_AGENT_ROOT');
const output = process.env.PI_POOL_TEST_OUTPUT_DIR;
if (!output) throw new Error('PI_POOL_TEST_OUTPUT_DIR is required');
const expectation = process.env.FIXTURE_EXPECT ?? 'retry';
if (!['baseline', 'retry'].includes(expectation)) throw new Error('FIXTURE_EXPECT must be baseline or retry');
// slow: the first hook run sleeps past the timeout, later runs vend. fail: every run exits 1.
const hookMode = process.env.FIXTURE_HOOK ?? 'slow';
if (!['slow', 'fail'].includes(hookMode)) throw new Error('FIXTURE_HOOK must be slow or fail');
const run = mkdtempSync(join(output, 'hook-timeout-'));
console.log(JSON.stringify({ run, expectation, hookMode }));

const C = 'cccc3333-0000-0000-0000-000000000000';
const SESSION = 'fixture-hook-timeout-session';
const MAX_RETRIES = 3;

function jwt(accountId) {
  const claims = { exp: Math.floor(Date.now() / 1000) + 30 * 86400, fixture: 'c', 'https://api.openai.com/auth': { chatgpt_account_id: accountId } };
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.synthetic`;
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
mkdirSync(join(tm, 'codex-stores', C.slice(0, 8)), { recursive: true });
mkdirSync(pool, { recursive: true });
writeFileSync(join(tm, 'codex-accounts.json'), JSON.stringify({ version: 2, accounts: [{ id: C, email: 'c@x', label: 'c@x', tier: 'plus', windows: [] }] }));
writeFileSync(join(tm, 'codex-stores', C.slice(0, 8), 'auth.json'), JSON.stringify({ tokens: { access_token: jwt(C), refresh_token: 'synthetic' } }));

const requests = [];
const server = createServer(async (request, response) => {
  for await (const _chunk of request);
  requests.push({ at: Date.now(), path: request.url });
  sse(response, 'SYNTHETIC_HOOK_OK', requests.length);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = server.address().port;

const dir = join(run, 'prime');
const agentHome = join(dir, 'agent');
for (const path of [agentHome, join(dir, 'home'), join(dir, 'tmp'), join(dir, 'cwd')]) mkdirSync(path, { recursive: true });
writeFileSync(join(agentHome, 'auth.json'), '{}');
writeFileSync(join(agentHome, 'settings.json'), JSON.stringify({
  defaultProvider: 'openai-codex', defaultModel: 'fixture-codex', defaultThinkingLevel: 'off', transport: 'sse',
  retry: { enabled: true, maxRetries: MAX_RETRIES, baseDelayMs: 150, provider: { maxRetryDelayMs: 3000, timeoutMs: 3000 } },
  compaction: { enabled: false }, autoRefine: { enabled: false }, packages: [], mcpServers: {}, quietStartup: true,
}));
const hookRuns = join(run, 'hook-runs.txt');
const hook = ['/usr/bin/python3', '-B', join(here, 'slow-hook.py'), hookRuns, hookMode, join(poolSource, 'bin', 'pi-pool-token'), '--provider', 'openai-codex'];
writeFileSync(join(agentHome, 'models.json'), JSON.stringify({ providers: { 'openai-codex': {
  baseUrl: `http://127.0.0.1:${port}`, api: 'openai-codex-responses', apiKey: `!${hook.join(' ')}`,
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
const withExtension = expectation === 'retry';
const args = [join(install, 'dist/bundle/cli.js'), '--mode', 'rpc', '--offline', '--no-tools', '--no-extensions',
  ...(withExtension ? ['--extension', join(poolSource, 'app', 'extension', 'index.ts')] : []),
  '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--provider', 'openai-codex', '--model', 'fixture-codex', '--thinking', 'off'];
const child = spawn(process.execPath, args, { cwd: join(dir, 'cwd'), env, stdio: ['pipe', 'pipe', 'pipe'] });
const closed = once(child, 'close');
const bus = new EventEmitter();
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
  const id = `hook-${++commandId}`;
  const answer = waitFor(event => event.type === 'response' && event.id === id, 20000);
  child.stdin.write(JSON.stringify({ id, type, ...fields }) + '\n');
  return answer;
};

const summary = {};
try {
  await rpc('get_state');
  const startedAt = Date.now();
  await rpc('prompt', { message: 'Return SYNTHETIC_HOOK_OK.' });
  const settled = event => (event.type === 'message_end' && event.message.role === 'assistant' && event.message.stopReason === 'stop')
    || (event.type === 'auto_retry_end' && !event.success);
  const end = await waitFor(settled, 60000);
  // Without a retry the failed turn emits nothing after agent_end; give Prime a moment to start one.
  if (!end) await waitFor(event => event.type === 'auto_retry_start', 3000);
  child.stdin.end();
  const force = setTimeout(() => child.kill('SIGTERM'), 5000);
  await closed;
  clearTimeout(force);
  const assistants = events.filter(event => event.type === 'message_end' && event.message.role === 'assistant').map(event => event.message);
  const retries = events.filter(event => event.type === 'auto_retry_start');
  Object.assign(summary, {
    requests: requests.length,
    hookRuns: existsSync(hookRuns) ? readFileSync(hookRuns, 'utf8').trim().split('\n').length : 0,
    retries: retries.length,
    retryEnd: events.find(event => event.type === 'auto_retry_end') ?? null,
    finishedAfterMs: end ? Date.now() - startedAt : null,
    assistants: assistants.map(m => ({ stopReason: m.stopReason, errorMessage: m.errorMessage, diagnostics: (m.diagnostics ?? []).map(d => d.type) })),
  });
  const first = assistants[0];
  assert.equal(first?.stopReason, 'error', 'the first request fails while the hook runs');
  assert.match(first.errorMessage, /^Failed to resolve API key for provider "openai-codex" from shell command: .*pi-pool-token/);
  if (expectation === 'baseline') {
    assert.deepEqual(first.diagnostics?.map(d => d.type), ['agent_lifecycle_failure']);
    assert.equal(retries.length, 0, 'without the extension Prime never retries a failed hook');
    assert.equal(requests.length, 0);
    assert.equal(assistants.length, 1, 'the turn ends on the hook failure');
  } else if (hookMode === 'slow') {
    assert.match(first.errorMessage, / pi-pool: the token hook gave no token; the retry uses a new hook run\.$/);
    assert.ok(!first.diagnostics?.some(d => d.type === 'agent_lifecycle_failure'), 'the hook failure is no longer a lifecycle crash');
    assert.equal(retries.length, 1, 'Prime retries the turn once');
    assert.equal(assistants.at(-1).stopReason, 'stop', 'the retried turn finishes');
    assert.equal(summary.hookRuns, 2, 'the retry runs the hook again');
    assert.equal(requests.length, 1, 'the retry reaches the provider');
  } else {
    assert.equal(retries.length, MAX_RETRIES, 'a hook that keeps failing gets the bounded retries');
    assert.equal(summary.retryEnd?.success, false, 'then the turn ends with the error');
    assert.equal(requests.length, 0);
    assert.equal(summary.hookRuns, MAX_RETRIES + 1);
  }
} finally {
  if (child.exitCode === null) child.kill('SIGKILL');
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  writeFileSync(join(run, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
}
assertNoIsolationViolations();
