// A token hook slot wait (exit 75) in a `prime-agent -p` run, whose session sits in a client-owned daemon worker: `prime-agent
// wake <session>` from another client must end the extension's credential wait ("timer"), and the run's one model call goes out
// right after the wake, well before its slot. On 11-22 Prime test.48 answered "none" for such trees on us-metal02 (six 01a20069
// trees booked into claude3's 04:43:48Z cells slept to their old cells), since its supervisor skipped client-owned workers.
// node legacy/prime/pi-pool-extension/native/client-owned-wake.mjs <prime-agent binary>
import { isolationEnv, assertNoIsolationViolations } from '../../../../packages/pi-pool/test/isolation/isolation.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const poolSource = join(here, '..', '..', '..', '..', 'packages', 'pi-pool');
const binary = process.argv[2] ?? process.env.PI_POOL_PRIME_AGENT_BINARY;
if (!binary) throw new Error('Pass a prime-agent binary, or set PI_POOL_PRIME_AGENT_BINARY');
const output = process.env.PI_POOL_TEST_OUTPUT_DIR;
if (!output) throw new Error('PI_POOL_TEST_OUTPUT_DIR is required');
const run = mkdtempSync(join(output, 'client-owned-wake-'));
console.log(JSON.stringify({ run }));

const C = 'cccc3333-0000-0000-0000-000000000000';
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
writeFileSync(join(pool, 'state.json'), JSON.stringify({ version: 2, providers: { anthropic: emptyProvider, 'openai-codex': emptyProvider }, sessions: {} }));

const requests = [];
const server = createServer(async (request, response) => {
  for await (const _chunk of request);
  requests.push(Date.now());
  sse(response, 'SYNTHETIC_SLOT_OK', requests.length);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = server.address().port;

const dir = join(run, 'prime');
const agentHome = join(dir, 'agent');
for (const path of [join(agentHome, 'extensions'), join(dir, 'home'), join(dir, 'tmp'), join(dir, 'cwd'), join(dir, 'bin')]) mkdirSync(path, { recursive: true });
symlinkSync(join(here, '..'), join(agentHome, 'extensions', 'pi-pool'));
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
// The pool's own wakes run `prime-agent` from PATH, so they reach this daemon and never the machine's.
writeFileSync(join(dir, 'bin', 'prime-agent'), `#!/bin/sh\nexec ${JSON.stringify(binary)} "$@"\n`, { mode: 0o755 });
// TMPDIR names the daemon socket, so this daemon and its clients never meet the machine's daemon.
const env = {
  ...isolationEnv,
  HOME: join(dir, 'home'), TMPDIR: join(dir, 'tmp'), XDG_CONFIG_HOME: join(dir, 'home', '.config'), XDG_CACHE_HOME: join(dir, 'home', '.cache'),
  PATH: `${join(dir, 'bin')}:${dirname(process.execPath)}:/usr/bin:/bin`, USER: process.env.USER ?? 'fixture',
  PI_POOL_DIR: pool, PRIME_AGENT_CODING_AGENT_DIR: agentHome, PRIME_AGENT_SESSION_DIR: join(agentHome, 'sessions'),
  PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', NO_PROXY: '*', TERM: 'dumb',
};
delete env.NODE_OPTIONS;
const cli = (...args) => execFileSync('/usr/bin/python3', ['-B', join(poolSource, 'bin', 'pi-pool'), ...args], { env, encoding: 'utf8' });
// One codex account with 120 s cells, and the current cell taken by another tree: the run's first request waits for the next cell.
cli('set', 'admit_slot_sec', '120');
const taken = JSON.parse(readFileSync(join(pool, 'state.json'), 'utf8'));
taken.providers['openai-codex'].admissions = { [C]: [[Date.now() / 1000, 'other-tree']] };
writeFileSync(join(pool, 'state.json'), JSON.stringify(taken));

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, timeout) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = check(); if (value) return value; await sleep(200); }
  return check();
};
const daemon = spawn(binary, ['--mode', 'daemon'], { cwd: join(dir, 'cwd'), env, stdio: ['ignore', 'pipe', 'pipe'] });
daemon.stdout.on('data', chunk => appendFileSync(join(dir, 'daemon.log'), chunk));
daemon.stderr.on('data', chunk => appendFileSync(join(dir, 'daemon.log'), chunk));
let print;
const summary = {};
try {
  const socket = join(dir, 'tmp', `prime-agent-${process.getuid()}`, 'daemon.sock');
  const up = await until(() => { try { return readFileSync(join(dir, 'daemon.log'), 'utf8').includes('listening on'); } catch { return false; } }, 30000);
  assert.ok(up, `the isolated daemon listens on ${socket}`);
  print = spawn(binary, ['-p', 'Return SYNTHETIC_SLOT_OK.'], { cwd: join(dir, 'cwd'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let printed = '';
  print.stdout.on('data', chunk => { printed += chunk; });
  const printClosed = once(print, 'close');
  const poolLog = () => { try { return readFileSync(join(pool, 'pi-pool.log'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };
  const waited = await until(() => poolLog().find(event => event.event === 'wait' && event.vend === null), 60000);
  assert.ok(waited, 'the hook put the tree in a slot wait');
  summary.slotAt = waited.slot_at;
  const session = waited.session;
  // The extension's 1 s hop hands the wait to Prime's credential wait, whose failure line names pi-pool's wake.
  const inWait = await until(() => {
    try { return readFileSync(join(agentHome, 'sessions', `${session}.jsonl`), 'utf8').includes('pi-pool wakes it sooner'); } catch { return false; }
  }, 30000);
  assert.ok(inWait, "the run sits in the extension's credential wait");
  // Free the cell first, so the woken run's next ask gets a token: without the wake it sleeps to its slot, 120 s out.
  const free = JSON.parse(readFileSync(join(pool, 'state.json'), 'utf8'));
  free.providers['openai-codex'].admissions = {};
  for (const rec of Object.values(free.sessions ?? {})) if (rec && typeof rec === 'object') delete rec.wait;
  writeFileSync(join(pool, 'state.json'), JSON.stringify(free));
  const woke = await new Promise(resolve => {
    const child = spawn(binary, ['wake', session], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.on('close', code => resolve({ code, out: out.trim() }));
  });
  const wokeAt = Date.now();
  summary.woke = woke;
  assert.equal(JSON.parse(woke.out.split('\n').at(-1)).woke, 'timer', `prime-agent wake ends the client-owned run's credential wait: ${woke.out}`);
  const [code] = await Promise.race([printClosed, sleep(60000).then(() => [-1])]);
  summary.requests = requests.map(at => at - wokeAt);
  summary.printed = printed.trim();
  assert.equal(code, 0, 'the print run finished');
  assert.match(printed, /SYNTHETIC_SLOT_OK/);
  assert.equal(requests.length, 1, 'one provider request');
  assert.ok(requests[0] - wokeAt < 30000, `the request went out ${requests[0] - wokeAt} ms after the wake, not at the slot`);
} finally {
  // The print run goes first: a print client that loses its daemon starts a new one.
  if (print && print.exitCode === null) {
    print.kill('SIGTERM');
    await once(print, 'close').catch(() => {});
  }
  const stop = async (pid, closed) => {
    try { process.kill(pid, 'SIGTERM'); } catch { return; }
    const force = setTimeout(() => { try { process.kill(pid, 'SIGKILL'); } catch {} }, 10000);
    await closed;
    clearTimeout(force);
  };
  await stop(daemon.pid, daemon.exitCode === null ? once(daemon, 'close').catch(() => {}) : Promise.resolve());
  // Workers this daemon started, by the pids its descriptors name.
  const workers = join(agentHome, 'daemon-workers');
  for (const root of (() => { try { return readdirSync(workers); } catch { return []; } })()) {
    for (const name of (() => { try { return readdirSync(join(workers, root)); } catch { return []; } })()) {
      if (!/^[0-9a-f]+\.json$/.test(name)) continue;
      let pid;
      try { pid = JSON.parse(readFileSync(join(workers, root, name), 'utf8')).pid; } catch { continue; }
      if (Number.isInteger(pid)) await stop(pid, until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 12000));
    }
  }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  writeFileSync(join(run, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
}
assertNoIsolationViolations();
