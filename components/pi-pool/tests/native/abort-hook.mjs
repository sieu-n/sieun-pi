import { isolationEnv, assertNoIsolationViolations } from './isolation.mjs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { EventEmitter, once } from 'node:events';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = dirname(fileURLToPath(import.meta.url));
const output = process.env.PI_POOL_TEST_OUTPUT_DIR;
if (!output) throw new Error('PI_POOL_TEST_OUTPUT_DIR is required');
mkdirSync(output, { recursive: true });
const run = mkdtempSync(join(output, 'abort-run-'));
const install = process.env.PI_POOL_PRIME_AGENT_ROOT;
if (!install) throw new Error('PI_POOL_PRIME_AGENT_ROOT must name a copied install');
const node = process.execPath;
const expectation = process.env.FIXTURE_EXPECT ?? 'recovery';
const warm = process.argv.includes('--warm');
let phase = warm ? 'seed' : 'test';
let hookCalls = 0;
const agentHome = join(run, 'agent');
for (const path of [agentHome, join(run, 'home'), join(run, 'tmp'), join(run, 'cwd')]) mkdirSync(path, { recursive: true });
const timeline = [];
const events = [];
const bus = new EventEmitter();
const start = performance.now();
let releaseHook;
let requestCount = 0;
const mark = (type, fields = {}) => {
  const event = { type, elapsedMs: Math.round(performance.now() - start), ...fields };
  timeline.push(event);
  appendFileSync(join(run, 'timeline.jsonl'), JSON.stringify(event) + '\n');
  return event;
};
function sse(response, text, count) {
  const item = { id: `msg_${count}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
  const result = { id: `resp_${count}`, status: 'completed', output: [item], usage: { input_tokens: 1500, output_tokens: 20, total_tokens: 1520 } };
  const events = [
    { type: 'response.created', response: { id: result.id, status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [], status: 'in_progress' } },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: result },
  ];
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(events.map(event => `event: ${event.type}
data: ${JSON.stringify(event)}

`).join(''));
}



const server = createServer(async (request, response) => {
  if (request.url === '/hook') {
    hookCalls++;
    if (phase === 'seed') {
      const payload = { 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-fixture-only' } };
      response.end(`eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.synthetic`);
      return;
    }
    mark('hook_started');
    releaseHook = () => {
      mark('hook_released_success');
      const payload = { 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-fixture-only' } };
      response.end(`eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.synthetic`);
    };
    bus.emit('hook_started');
    return;
  }
  for await (const chunk of request) {}
  mark('provider_request', { path: request.url, phase });
  if (phase === 'seed') { sse(response, 'SYNTHETIC_WARMED', 1); return; }
  requestCount++;
  response.writeHead(503, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: { type: 'server_error', message: 'synthetic abort probe' } }));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const endpoint = `http://127.0.0.1:${server.address().port}`;
writeFileSync(join(agentHome, 'auth.json'), '{}');
writeFileSync(join(agentHome, 'settings.json'), JSON.stringify({ defaultProvider: 'openai-codex', defaultModel: 'fixture-codex', transport: 'sse', retry: { enabled: false, maxRetries: 0 }, compaction: { enabled: false }, autoRefine: { enabled: false }, packages: [], mcpServers: {}, quietStartup: true }));
writeFileSync(join(agentHome, 'models.json'), JSON.stringify({ providers: { 'openai-codex': { baseUrl: endpoint, api: 'openai-codex-responses', apiKey: `!/usr/bin/python3 '${join(root, 'blocked-hook.py')}' '${endpoint}/hook' '${join(run, 'owner-completed.txt')}'`, models: [{ id: 'fixture-codex', reasoning: false, input: ['text'], contextWindow: 100000, maxTokens: 1024 }] } } }));
const env = { ...isolationEnv, HOME: join(run, 'home'), TMPDIR: join(run, 'tmp'), XDG_CONFIG_HOME: join(run, 'home', '.config'), XDG_CACHE_HOME: join(run, 'home', '.cache'), PATH: `${dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin`, PRIME_AGENT_CODING_AGENT_DIR: agentHome, PRIME_AGENT_SESSION_DIR: join(agentHome, 'sessions'), PRIME_AGENT_INTERNAL_LEGACY_OWNED_WORKER_FRONTEND: '1', PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', NODE_COMPILE_CACHE: join(run, 'node-cache'), NO_PROXY: '*', TERM: 'dumb' };
const args = [join(install, 'dist/bundle/cli.js'), '--mode', 'rpc', '--offline', '--no-session', '--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--provider', 'openai-codex', '--model', 'fixture-codex', '--thinking', 'off'];
writeFileSync(join(run, 'launch.json'), JSON.stringify({ node, args, env }, null, 2));
const child = spawn(node, args, { env, cwd: join(run, 'cwd'), stdio: ['pipe', 'pipe', 'pipe'] });
const closed = once(child, 'close');
let buffer = '';
child.stdout.on('data', chunk => {
  appendFileSync(join(run, 'stdout.jsonl'), chunk);
  buffer += chunk;
  while (buffer.includes('\n')) {
    const index = buffer.indexOf('\n');
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    try {
      const event = JSON.parse(line);
      events.push(event); bus.emit('event', event);
      if (event.type === 'response' && event.command === 'abort') mark('abort_acknowledged');
    } catch {}
  }
});
child.stderr.on('data', chunk => appendFileSync(join(run, 'stderr.txt'), chunk));
function waitFor(predicate) {
  const existing = events.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Native RPC deadline exceeded')), 15000);
    const listener = event => { if (predicate(event)) finish(undefined, event); };
    function finish(error, value) { clearTimeout(timer); bus.off('event', listener); error ? reject(error) : resolve(value); }
    bus.on('event', listener);
  });
}
let sequence = 0;
function rpc(type, fields = {}) {
  const id = `command-${++sequence}`;
  const response = waitFor(event => event.type === 'response' && event.id === id);
  child.stdin.write(JSON.stringify({ id, type, ...fields }) + '\n');
  return response;
}
let error;
let finalState;
try {
  await rpc('get_state');
  if (warm) {
    await rpc('prompt', { message: 'Warm the native provider transport.' });
    await waitFor(event => event.type === 'agent_end');
    await rpc('get_state');
    phase = 'test';
  }
  const started = once(bus, 'hook_started');
  await rpc('prompt', { message: 'Do not make a provider request after the pending abort.' });
  await started;
  mark('abort_sent_while_hook_blocked');
  const aborted = rpc('abort');
  const release = setTimeout(() => releaseHook(), 200);
  await aborted;
  clearTimeout(release);
  if (!timeline.some(event => event.type === 'hook_released_success')) releaseHook();
  await new Promise(resolve => setTimeout(resolve, 500));
  finalState = await rpc('get_state');
  assert.equal(finalState.data.isStreaming, false);
  assert.equal(readFileSync(join(run, 'owner-completed.txt'), 'utf8').trim().split('\n').length, warm ? 2 : 1, 'the in-flight credential owner finishes after abort');
  if (expectation === 'recovery') {
    assert.equal(requestCount, 0, 'abort must prevent any provider request after hook release');
    assert.equal(hookCalls, warm ? 2 : 1, 'abort cannot start another credential attempt');
    assert.equal(events.filter(event => event.type === 'auto_retry_start').length, 0);
  }
  else assert(timeline.find(event => event.type === 'abort_acknowledged').elapsedMs >= timeline.find(event => event.type === 'hook_released_success').elapsedMs, 'sync baseline cannot acknowledge abort before the hook returns');
} catch (caught) {
  error = caught.message;
} finally {
  child.stdin.end();
  const force = setTimeout(() => child.kill('SIGTERM'), 4000);
  const [code, signal] = await closed;
  clearTimeout(force);
  mark('native_exit', { code, signal });
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
const result = { run, endpoint, expectation, warm, hookCalls, requestCount, timeline, finalState, error };
writeFileSync(join(run, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
if (error) process.exitCode = 1;

assertNoIsolationViolations();
