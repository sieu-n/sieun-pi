// A token hook slot wait (exit 75) inside a real Prime run: the pi-pool extension hands it to Prime's credential wait, which
// `prime-agent wake` ends, after one 1 s hop, and the run's model call goes out at its slot with no request before it.
// node legacy/prime/pi-pool-extension/native/slot-wake.mjs "$PI_POOL_PRIME_AGENT_ROOT"
import { isolationEnv, assertNoIsolationViolations } from '../../../../packages/pi-pool/test/isolation/isolation.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { EventEmitter, once } from 'node:events';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const poolSource = join(here, '..', '..', '..', '..', 'packages', 'pi-pool');
const install = process.argv[2] ?? process.env.PI_POOL_PRIME_AGENT_ROOT;
if (!install) throw new Error('Pass a copied Prime Agent install, or set PI_POOL_PRIME_AGENT_ROOT');
const output = process.env.PI_POOL_TEST_OUTPUT_DIR;
if (!output) throw new Error('PI_POOL_TEST_OUTPUT_DIR is required');
const run = mkdtempSync(join(output, 'slot-wake-'));
console.log(JSON.stringify({ run }));

const C = 'cccc3333-0000-0000-0000-000000000000';
const SESSION_ENV = 'fixture-queue-tree';
function jwt(accountId) {
  const claims = { exp: Math.floor(Date.now() / 1000) + 30 * 86400, 'https://api.openai.com/auth': { chatgpt_account_id: accountId } };
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
const store = join(pool, 'accounts');
for (const path of [pool, join(store, 'openai-codex')]) mkdirSync(path, { recursive: true });
writeFileSync(join(store, 'openai-codex.json'), JSON.stringify({ version: 1, accounts: [{ id: C, email: 'c@x', label: 'c@x', tier: 'plus', windows: [] }] }));
writeFileSync(join(store, 'openai-codex', `${C}.json`), JSON.stringify({ tokens: { access_token: jwt(C), refresh_token: 'synthetic' } }));
const emptyProvider = { pin: null, cooldowns: {}, disabled: {} };
writeFileSync(join(pool, 'state.json'), JSON.stringify({ version: 2, providers: { anthropic: emptyProvider, 'openai-codex': { ...emptyProvider, pin: C } }, sessions: {} }));
const cliEnv = { ...process.env, ...isolationEnv, PI_POOL_DIR: pool };
delete cliEnv.PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID;
delete cliEnv.PRIME_AGENT_INTERNAL_DAEMON_WORKER_RECOVERY_JOURNAL;
const cli = (...args) => execFileSync('/usr/bin/python3', ['-B', join(poolSource, 'bin', 'pi-pool'), ...args], { env: cliEnv, encoding: 'utf8' });
const queue = () => JSON.parse(cli('queue', '--json'));
// One codex account with 20 s cells, and the current cell taken by another tree: this tree's first request waits for the next cell.
cli('set', 'admit_slot_sec', '20');
const taken = JSON.parse(readFileSync(join(pool, 'state.json'), 'utf8'));
taken.providers['openai-codex'].admissions = { [C]: [[Date.now() / 1000, 'other-tree']] };
writeFileSync(join(pool, 'state.json'), JSON.stringify(taken));

const requests = [];
const server = createServer(async (request, response) => {
  for await (const _chunk of request);
  requests.push(Date.now());
  appendFileSync(join(run, 'http.jsonl'), JSON.stringify({ at: Date.now(), path: request.url }) + '\n');
  sse(response, 'SYNTHETIC_SLOT_OK', requests.length);
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
  retry: { enabled: true, maxRetries: 3, baseDelayMs: 150 }, compaction: { enabled: false }, autoRefine: { enabled: false },
  packages: [], mcpServers: {}, quietStartup: true,
}));
writeFileSync(join(agentHome, 'models.json'), JSON.stringify({ providers: { 'openai-codex': {
  baseUrl: `http://127.0.0.1:${port}`, api: 'openai-codex-responses', apiKey: `!${join(poolSource, 'bin', 'pi-pool-token')} --provider openai-codex`,
  models: [{ id: 'fixture-codex', reasoning: false, input: ['text'], contextWindow: 100000, maxTokens: 1024 }],
} } }));
const env = {
  ...isolationEnv,
  HOME: join(dir, 'home'), TMPDIR: join(dir, 'tmp'), XDG_CONFIG_HOME: join(dir, 'home', '.config'),
  XDG_CACHE_HOME: join(dir, 'home', '.cache'), PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
  PI_POOL_DIR: pool, PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID: SESSION_ENV,
  PRIME_AGENT_CODING_AGENT_DIR: agentHome, PRIME_AGENT_SESSION_DIR: join(agentHome, 'sessions'),
  PRIME_AGENT_INTERNAL_LEGACY_OWNED_WORKER_FRONTEND: '1', PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1',
  NODE_COMPILE_CACHE: join(dir, 'node-cache'), NO_PROXY: '*', TERM: 'dumb',
};
const child = spawn(process.execPath, [join(install, 'dist/bundle/cli.js'), '--mode', 'rpc', '--offline', '--no-tools', '--no-extensions',
  '--extension', join(here, '..', 'index.ts'), '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes',
  '--provider', 'openai-codex', '--model', 'fixture-codex', '--thinking', 'off'], { cwd: join(dir, 'cwd'), env, stdio: ['pipe', 'pipe', 'pipe'] });
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
const waitFor = (predicate, timeout, from = 0) => {
  const found = events.slice(from).find(predicate);
  if (found) return Promise.resolve(found);
  return new Promise(resolve => {
    const timer = setTimeout(() => { bus.off('event', listener); resolve(undefined); }, timeout);
    const listener = event => { if (predicate(event)) { clearTimeout(timer); bus.off('event', listener); resolve(event); } };
    bus.on('event', listener);
  });
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let commandId = 0;
const rpc = (type, fields = {}) => {
  const id = `s-${++commandId}`;
  const answer = waitFor(event => event.type === 'response' && event.id === id, 20000);
  child.stdin.write(JSON.stringify({ id, type, ...fields }) + '\n');
  return answer;
};
const until = async (check, timeout) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (check()) return true; await sleep(200); }
  return check();
};

const summary = {};
try {
  const state = await rpc('get_state');
  summary.session = state.data.sessionId;
  const asked = Date.now();
  await rpc('prompt', { message: 'Return SYNTHETIC_SLOT_OK.' });
  const retries = [];
  bus.on('event', event => { if (event.type === 'auto_retry_start') retries.push({ at: Date.now(), reason: event.reason, delayMs: event.delayMs, errorMessage: event.errorMessage }); });
  const done = await waitFor(event => event.type === 'message_end' && event.message.role === 'assistant' && event.message.stopReason === 'stop', 60000);
  summary.retries = retries;
  summary.requests = requests.map(at => at - asked);
  assert.ok(done, 'the run finished at its slot');
  assert.equal(requests.length, 1, 'no provider request before the slot');
  const credential = retries.filter(retry => retry.reason === 'credential');
  assert.equal(credential.length, 1, 'one credential wait');
  assert.match(credential[0].errorMessage, /this session waits for its slot at .*pi-pool wakes it sooner/, "the extension's credential wait, which `prime-agent wake` ends");
  const hops = retries.filter(retry => retry.reason !== 'credential');
  assert.deepEqual(hops.map(retry => retry.delayMs), [1000], 'one 1 s hop before it');
  assert.ok(credential[0].delayMs > 1000, 'the credential wait sleeps until the slot');
} finally {
  child.stdin.end();
  const force = setTimeout(() => child.kill('SIGTERM'), 5000);
  await closed;
  clearTimeout(force);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  writeFileSync(join(run, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
}
assertNoIsolationViolations();
