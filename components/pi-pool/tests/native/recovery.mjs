import { isolationEnv, assertNoIsolationViolations } from './isolation.mjs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter, once } from 'node:events';
import { checkResult } from './assertions.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const install = process.env.PI_POOL_PRIME_AGENT_ROOT;
if (!install) throw new Error('PI_POOL_PRIME_AGENT_ROOT must name a copied install');
const output = process.env.PI_POOL_TEST_OUTPUT_DIR;
if (!output) throw new Error('PI_POOL_TEST_OUTPUT_DIR is required');
mkdirSync(output, { recursive: true });
const node = process.execPath;
const names = process.argv.slice(2);
const cases = ['prompt-hook-recover', 'prompt-auth-recover', 'prompt-hook-exhaust', 'prompt-auth-cancel', 'iteration-hook-recover', 'compact-hook-recover', 'compact-auth-recover', 'compact-transient', 'overflow-hook-recover', 'overflow-auth-recover', 'overflow-transient', 'tool-hook-recover', 'threshold-hook-recover', 'threshold-auth-recover', 'threshold-transient', 'compact-hook-exhaust', 'threshold-hook-exhaust', 'overflow-hook-exhaust', 'threshold-split-auth-recover'];
const scenarios = names.length ? names : cases.flatMap(name => [name, `${name}-claude`]);
if (scenarios.some(name => !cases.includes(name.replace(/-claude$/, '')))) throw new Error('Unknown scenario');
const run = mkdtempSync(join(output, 'run-'));
console.log(JSON.stringify({ run }));

function jwtLabel(value) {
  try { return JSON.parse(Buffer.from(value.split('.')[1], 'base64url')).fixture; }
  catch { return 'missing'; }
}
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


function anthropicSse(response, text, count) {
  const message = { id: `msg_${count}`, type: 'message', role: 'assistant', model: 'fixture-codex', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1500, output_tokens: 0 } };
  const events = [
    { type: 'message_start', message },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } },
    { type: 'message_stop' },
  ];
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(events.map(event => `event: ${event.type}
data: ${JSON.stringify(event)}

`).join(''));
}


function toolSse(response, provider, count, inputTokens) {
  let events;
  if (provider === 'anthropic') {
    const message = { id: `msg_${count}`, type: 'message', role: 'assistant', model: 'fixture-codex', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 0 } };
    events = [
      { type: 'message_start', message },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `call_${count}`, name: 'fixture_echo', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } },
      { type: 'message_stop' },
    ];
  } else {
    const item = { id: `fc_${count}`, call_id: `call_${count}`, type: 'function_call', name: 'fixture_echo', arguments: '{}' };
    events = [
      { type: 'response.created', response: { id: `resp_${count}`, status: 'in_progress' } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
      { type: 'response.function_call_arguments.done', output_index: 0, arguments: '{}' },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: `resp_${count}`, status: 'completed', output: [item], usage: { input_tokens: inputTokens, output_tokens: 20, total_tokens: inputTokens + 20 } } },
    ];
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(events.map(event => `event: ${event.type}
data: ${JSON.stringify(event)}

`).join(''));
}

async function scenario(name) {
  const caseName = name.replace(/-claude$/, '');
  const provider = name.endsWith('-claude') ? 'anthropic' : 'openai-codex';
  const usesTools = caseName.startsWith('tool-') || caseName.startsWith('threshold-');
  const api = provider === 'anthropic' ? 'anthropic-messages' : 'openai-codex-responses';
  const dir = join(run, name);
  const agentHome = join(dir, 'agent');
  for (const path of [dir, agentHome, join(dir, 'home'), join(dir, 'tmp'), join(dir, 'cwd')]) mkdirSync(path, { recursive: true });
  const events = [];
  const requests = [];
  const bus = new EventEmitter();
  let state = { keyLabel: 'old', failNext: caseName === 'prompt-hook-recover' ? 1 : 0, alwaysFail: ['prompt-hook-exhaust', 'prompt-cancel'].includes(caseName) };
  const saveState = () => writeFileSync(join(dir, 'control.json'), JSON.stringify(state));
  saveState();
  let phase = caseName.startsWith('compact-') || caseName.startsWith('overflow-') || caseName.startsWith('threshold-') ? 'seed' : 'test';
  let testRequests = 0;
  let sequence = 0;
  let releaseFirstResponse;
  const splitInitialIds = new Set();
  let releaseSplit;
  let splitBarrierTimer;
  let splitBarrierError;
  const splitBarrier = new Promise(resolve => { releaseSplit = resolve; });
  const server = createServer(async (request, response) => {
    let bodyText = '';
    for await (const chunk of request) bodyText += chunk;
    const keyLabel = jwtLabel(request.headers.authorization ?? request.headers['x-api-key'] ?? '');
    const requestBody = JSON.parse(bodyText);
    writeFileSync(join(dir, `request-${sequence + 1}.json`), JSON.stringify(requestBody, null, 2));
    const isSummary = bodyText.includes('<conversation>');
    const slice = isSummary ? bodyText.includes('PREFIX of a turn') ? 'prefix' : 'history' : undefined;
    const wireBlocks = provider === 'anthropic' ? (requestBody.messages ?? []).flatMap(message => Array.isArray(message.content) ? message.content : []) : requestBody.input ?? [];
    const wireToolCalls = wireBlocks.filter(block => block.type === (provider === 'anthropic' ? 'tool_use' : 'function_call'));
    const wireToolResults = wireBlocks.filter(block => block.type === (provider === 'anthropic' ? 'tool_result' : 'function_call_output'));
    const record = { isSummary, slice, wireToolCallIds: wireToolCalls.map(block => block.call_id ?? block.id), wireToolResultIds: wireToolResults.map(block => block.call_id ?? block.tool_use_id), hasToolResultText: wireToolResults.some(block => JSON.stringify(block).includes('SYNTHETIC_TOOL_OK')), n: ++sequence, method: request.method, path: request.url, phase, keyLabel, bodyBytes: bodyText.length, bodyHash: createHash('sha256').update(bodyText).digest('hex'), requestId: request.headers['x-acp-model-request-id'], idempotencyKey: request.headers['idempotency-key'], headerLabel: request.headers['x-fixture-key'] };
    requests.push(record);
    bus.emit('request', record);
    if (caseName === 'iteration-hook-recover' && sequence === 1) {
      await new Promise(resolve => { releaseFirstResponse = resolve; });
      state.failNext = 1; saveState();
    }
    if (phase === 'test') testRequests++;
    let status = 200;
    if (phase === 'test' && (!caseName.startsWith('overflow-') || testRequests > 1) && (!caseName.startsWith('threshold-') || isSummary) && (caseName.includes('auth-recover') || caseName === 'prompt-auth-cancel') && keyLabel !== 'new') {
      status = 401;
      if (caseName === 'threshold-split-auth-recover') {
        if (!splitBarrierTimer && splitInitialIds.size < 2) {
          splitBarrierTimer = setTimeout(() => {
            splitBarrierError = 'Two distinct native summary IDs did not reach the barrier';
            releaseSplit();
          }, 2000);
        }
        splitInitialIds.add(record.requestId);
        if (splitInitialIds.size === 2 && !splitInitialIds.has(undefined)) {
          clearTimeout(splitBarrierTimer);
          state.keyLabel = 'new';
          saveState();
          releaseSplit();
        }
        await splitBarrier;
      }
      state.keyLabel = 'new';
      saveState();
    }
    if (phase === 'test' && caseName === 'compact-transient' && testRequests === 1) status = 503;
    if (phase === 'test' && caseName.startsWith('overflow-')) {
      if (testRequests === 1) {
        status = 400;
        if (caseName === 'overflow-hook-recover') { state.failNext = 1; saveState(); }
        if (caseName === 'overflow-hook-exhaust') { state.alwaysFail = true; saveState(); }
      } else if (caseName === 'overflow-transient' && testRequests === 2) status = 503;
    }
    if (phase === 'test' && caseName === 'threshold-transient' && testRequests === 2) status = 503;
    record.status = status;
    appendFileSync(join(dir, 'http.jsonl'), JSON.stringify(record) + '\n');
    if (status !== 200) {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { type: status === 401 ? 'authentication_error' : status === 400 ? 'invalid_request_error' : 'server_error', code: status === 400 ? 'context_length_exceeded' : undefined, message: status === 400 ? 'maximum context length exceeded' : `synthetic ${status}` } }));
    } else {
      const text = phase === 'seed' ? 'Synthetic seed response.' : 'SYNTHETIC_RECOVERY_OK';
      if (phase === 'test' && usesTools && testRequests === 1) {
        if (caseName.includes('hook-recover')) { state.failNext = 1; saveState(); }
        if (caseName === 'threshold-hook-exhaust') { state.alwaysFail = true; saveState(); }
        toolSse(response, provider, sequence, caseName.startsWith('threshold-') ? 99000 : 1500);
      } else if (provider === 'anthropic') anthropicSse(response, text, sequence);
      else sse(response, text, sequence);
    }
    bus.emit('request', record);
  });
  server.on('upgrade', (request, socket) => {
    appendFileSync(join(dir, 'upgrades.jsonl'), JSON.stringify({ path: request.url }) + '\n');
    socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  writeFileSync(join(agentHome, 'auth.json'), '{}');
  writeFileSync(join(agentHome, 'settings.json'), JSON.stringify({
    defaultProvider: provider, defaultModel: 'fixture-codex', defaultThinkingLevel: 'off', transport: 'sse',
    retry: { enabled: process.env.PI_POOL_TEST_RETRY_ENABLED !== 'false', maxRetries: Number(process.env.PI_POOL_TEST_MAX_RETRIES ?? 3), baseDelayMs: caseName.includes('cancel') ? 1000 : 150, provider: { maxRetryDelayMs: 3000, timeoutMs: 3000 } },
    compaction: { enabled: false, reserveTokens: 2048, keepRecentTokens: caseName === 'threshold-split-auth-recover' ? 6 : 100 },
    autoRefine: { enabled: false }, packages: [], mcpServers: {}, quietStartup: true,
  }));
  writeFileSync(join(agentHome, 'models.json'), JSON.stringify({ providers: { [provider]: {
    baseUrl: `http://127.0.0.1:${port}`, api, apiKey: `!/usr/bin/python3 '${join(root, 'hook.py')}' '${dir}'`,
    headers: { 'x-fixture-key': `!/usr/bin/python3 '${join(root, 'header.py')}' '${dir}'` },
    models: [{ id: 'fixture-codex', reasoning: false, input: ['text'], contextWindow: 100000, maxTokens: 1024 }],
  } } }));
  const env = {
    ...isolationEnv,
    HOME: join(dir, 'home'), TMPDIR: join(dir, 'tmp'), XDG_CONFIG_HOME: join(dir, 'home', '.config'),
    XDG_CACHE_HOME: join(dir, 'home', '.cache'), PATH: `${dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    PRIME_AGENT_CODING_AGENT_DIR: agentHome, PRIME_AGENT_SESSION_DIR: join(agentHome, 'sessions'),
    PRIME_AGENT_INTERNAL_LEGACY_OWNED_WORKER_FRONTEND: '1', PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1',
    NODE_COMPILE_CACHE: join(dir, 'node-cache'), NO_PROXY: '*', TERM: 'dumb',
  };
  const args = [join(install, 'dist/bundle/cli.js'), '--mode', 'rpc', '--offline', ...(usesTools ? ['--no-builtin-tools', '--extension', join(root, 'fixture-extension.mjs')] : ['--no-tools']), '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--provider', provider, '--model', 'fixture-codex', '--thinking', 'off'];
  writeFileSync(join(dir, 'launch.json'), JSON.stringify({ command: node, args, cwd: join(dir, 'cwd'), env }, null, 2));
  const child = spawn(node, args, { cwd: join(dir, 'cwd'), env, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  let pending = '';
  let commandId = 0;
  child.stdout.on('data', chunk => {
    appendFileSync(join(dir, 'stdout.jsonl'), chunk);
    pending += chunk;
    while (pending.includes('\n')) {
      const end = pending.indexOf('\n');
      const line = pending.slice(0, end); pending = pending.slice(end + 1);
      try {
        const event = JSON.parse(line);
        events.push(event); bus.emit('event', event);
      } catch {}
    }
  });
  child.stderr.on('data', chunk => appendFileSync(join(dir, 'stderr.txt'), chunk));
  function waitFor(predicate, from = 0, timeout = 25000) {
    const found = events.slice(from).find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`timeout in ${name}`)), timeout);
      const listener = event => { if (predicate(event)) finish(undefined, event); };
      function finish(error, value) { clearTimeout(timer); bus.off('event', listener); error ? reject(error) : resolve(value); }
      bus.on('event', listener);
    });
  }
  async function rpc(type, fields = {}) {
    const id = `command-${++commandId}`;
    const answer = waitFor(event => event.type === 'response' && event.id === id);
    child.stdin.write(JSON.stringify({ id, type, ...fields }) + '\n');
    return answer;
  }
  const observeWindow = () => new Promise(resolve => setTimeout(resolve, 1500));
  const notes = {};
  try {
    notes.initialState = await rpc('get_state');
    if (phase === 'seed') {
      for (let turn = 0; turn < 3; turn++) {
        const start = events.length;
        await rpc('prompt', { message: `Seed turn ${turn}. ` + 'Synthetic conversation detail. '.repeat(150) });
        await waitFor(event => event.type === 'agent_end', start);
      }
      phase = 'test';
      state.failNext = caseName === 'compact-hook-recover' ? 1 : 0;
      state.alwaysFail = caseName === 'compact-hook-exhaust';
      saveState();
      if (caseName.startsWith('overflow-') || caseName.startsWith('threshold-')) {
        await rpc('set_auto_compaction', { enabled: true });
        const start = events.length;
        await rpc('prompt', { message: 'Continue after synthetic context overflow.' });
        await waitFor(event => event.type === 'compaction_end', start);
        await observeWindow();
      } else {
        notes.compact = await rpc('compact', { customInstructions: 'Return a short synthetic summary.' });
      }
      notes.compactHookRecoveredOnDisk = JSON.parse(readFileSync(join(dir, 'control.json'), 'utf8')).failNext === 0;
      await observeWindow();
    } else {
      const start = events.length;
      await rpc('prompt', { message: 'Return SYNTHETIC_RECOVERY_OK.' });
      if (caseName === 'iteration-hook-recover') {
        if (!releaseFirstResponse) await once(bus, 'request');
        await rpc('follow_up', { message: 'Return the final synthetic answer.' });
        releaseFirstResponse();
        await waitFor(event => event.type === 'agent_end', start);
        await observeWindow();
      } else if (caseName === 'prompt-auth-cancel') {
        await waitFor(event => event.type === 'auto_retry_start' || event.type === 'agent_end', start);
        notes.abort = await rpc('abort_retry');
        state.alwaysFail = false; state.failNext = 0; state.keyLabel = 'new'; saveState();
        await observeWindow();
      } else {
        const waitsForRetry = caseName === 'prompt-hook-exhaust' && process.env.PI_POOL_TEST_RETRY_ENABLED !== 'false' && Number(process.env.PI_POOL_TEST_MAX_RETRIES ?? 3) > 0;
        await waitFor(event => waitsForRetry ? event.type === 'auto_retry_end' : event.type === 'auto_retry_end' || event.type === 'agent_end', start);
        await observeWindow();
      }
    }
    notes.finalState = await rpc('get_state');
    notes.finalMessages = await rpc('get_messages');
  } catch (error) {
    notes.fixtureError = String(error);
  } finally {
    clearTimeout(splitBarrierTimer);
    releaseSplit();
    child.stdin.end();
    const force = setTimeout(() => child.kill('SIGTERM'), 5000);
    const [code, signal] = await closed;
    clearTimeout(force);
    notes.exit = { code, signal };
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  const hook = existsSync(join(dir, 'hook.jsonl')) ? readFileSync(join(dir, 'hook.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  const compactEvents = events.filter(event => ['auto_retry_start','auto_retry_end','compaction_start','compaction_end','auth_stale','tool_execution_start','tool_execution_end'].includes(event.type));
  const messages = events.filter(event => event.type === 'message_end' && event.message.role === 'assistant').map(event => ({
    stopReason: event.message.stopReason, usage: event.message.usage, errorMessage: event.message.errorMessage, diagnostics: event.message.diagnostics,
    text: event.message.content.filter(block => block.type === 'text').map(block => block.text).join(''),
  }));
  notes.splitBarrierError = splitBarrierError;
  const sessionFile = notes.finalState?.data?.sessionFile;
  const entries = sessionFile && existsSync(sessionFile) ? readFileSync(sessionFile, 'utf8').trim().split('\n').map(JSON.parse) : [];
  notes.persistence = { sessionFile, header: entries[0], entryCount: entries.length,
    initialSessionId: notes.initialState?.data?.sessionId, finalSessionId: notes.finalState?.data?.sessionId,
    compactions: entries.filter(entry => entry.type === 'compaction'),
    messageRoles: entries.filter(entry => entry.type === 'message').map(entry => entry.message.role),
    toolCalls: entries.filter(entry => entry.type === 'message' && entry.message.role === 'assistant').flatMap(entry => entry.message.content.filter(block => block.type === 'toolCall')),
    toolResults: entries.filter(entry => entry.type === 'message' && entry.message.role === 'toolResult'),
    finalAssistant: entries.filter(entry => entry.type === 'message' && entry.message.role === 'assistant').at(-1),
  };
  notes.persistence.firstKeptEntry = entries.find(entry => entry.id === notes.persistence.compactions.at(-1)?.firstKeptEntryId);
  writeFileSync(join(dir, 'persisted-transcript.json'), JSON.stringify(entries, null, 2));
  const report = { name, endpoint: `http://127.0.0.1:${port}`, hook, requests, events: compactEvents, messages, notes };
  writeFileSync(join(dir, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ name, hookCalls: hook.length, requests: requests.length, stopReasons: messages.map(message => message.stopReason), retries: compactEvents.filter(event => event.type === 'auto_retry_start').length, compactSuccess: notes.compact?.success, fixtureError: notes.fixtureError }));
  return report;
}

const results = [];
for (const name of scenarios) results.push(await scenario(name));
writeFileSync(join(run, 'results.json'), JSON.stringify(results, null, 2));
writeFileSync(join(output, 'latest-run.txt'), run + '\n');
const expectation = process.env.FIXTURE_EXPECT ?? 'recovery';
if (!['baseline', 'recovery'].includes(expectation)) throw new Error('FIXTURE_EXPECT must be baseline or recovery');
const assertions = results.map(result => {
  try {
    checkResult(result, expectation);
    const persisted = result.notes.persistence;
    if (!persisted?.entryCount || persisted.header.type !== 'session') throw new Error('Missing native saved transcript');
    if (persisted.initialSessionId !== persisted.finalSessionId || persisted.header.id !== persisted.finalSessionId) throw new Error('Session identity changed');
    if (result.events.some(event => event.type === 'compaction_end' && event.result) && !persisted.compactions.length) throw new Error('Successful compaction missing from native transcript');
    if (/^(tool|threshold)-/.test(result.name) && (persisted.toolCalls.length !== 1 || persisted.toolResults.length !== 1)) throw new Error('Persisted tool call/result count differs from one');
    return { name: result.name, passed: true };
  }
  catch (error) { return { name: result.name, passed: false, error: error.message }; }
});
writeFileSync(join(run, 'assertions.json'), JSON.stringify({ expectation, assertions }, null, 2));
console.log(JSON.stringify({ expectation, passed: assertions.filter(item => item.passed).length, total: assertions.length }));
if (assertions.some(item => !item.passed)) process.exitCode = 1;

assertNoIsolationViolations();
