import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import test from 'node:test';

let active;
const childProcess = createRequire(import.meta.url)('node:child_process');
childProcess.execFile = (_bin, args, _options, callback) => {
  active.calls.push(args.slice(1));
  const reply = active.reply(args.slice(1));
  queueMicrotask(() => callback(null, JSON.stringify(reply), ''));
};
syncBuiltinESMExports();
const { default: extension } = await import('../app/extension/index.ts');

const auto = { mode: 'auto' };
const manual = { mode: 'manual', account_id: 'off-id' };
const row = (overrides = {}) => ({
  id: 'auto-id', email: 'auto@x', label: 'Auto account', usage: '', session_pct: 10, weekly_pct: 5, gated_pct: 1,
  disabled: false, usable: true, reason: null, current: true, pinned: false, live: false, score: 1, ...overrides,
});
const off = row({ id: 'off-id', email: 'off@x', label: 'Off account', disabled: true, usable: false, reason: 'disabled', current: false, score: null });
const current = (selected) => ({
  id: selected.id, email: selected.email, label: selected.label,
  session_pct: 10, weekly_pct: 5, gated_pct: 1, next: false,
});

function session({ selection = auto, provider = 'anthropic', rows = [row(), off], info = {}, replies = {}, choose = 0 } = {}) {
  const handlers = new Map();
  let command;
  const state = { calls: [], widgets: [], prompts: [], notices: [], confirmations: 0, selection };
  state.reply = ([verb, ...args]) => {
    if (verb in replies) return replies[verb];
    if (verb === 'ls') return { provider, session: 'session-id', selection: state.selection, rows };
    if (verb === 'who') return { providers: { [provider]: {
      selection: state.selection, current: current(rows.find((candidate) => candidate.id === state.selection.account_id) ?? rows[0]), ...info,
    } } };
    if (verb === 'use') {
      state.selection = args[0] === '--follow' ? auto : { mode: 'manual', account_id: args[0] };
      return { selection: state.selection };
    }
    return {};
  };
  active = state;
  extension({ on: (name, handler) => handlers.set(name, handler), registerCommand: (_name, options) => { command = options; } });
  const ctx = {
    hasUI: true, model: { provider, id: 'test-model' },
    sessionManager: { getSessionId: () => 'session-id', getHeader: () => ({ rlmDepth: 0 }) },
    ui: {
      theme: { fg: (_color, text) => text },
      setWidget: (_key, lines) => state.widgets.push(lines?.[0]),
      notify: (text, level) => state.notices.push({ text, level }),
      select: async (title, options) => { state.prompts.push({ title, options }); return options[choose]; },
      confirm: async () => { state.confirmations += 1; return false; },
    },
  };
  return {
    state, command: () => command,
    account: (args = '') => command.handler(args, ctx),
    footer: () => handlers.get('model_select')({ model: ctx.model }, ctx),
    message: async (message) => (await handlers.get('message_end')({ message }, ctx))?.message,
  };
}

function failure(status, provider = 'anthropic') {
  return {
    role: 'assistant', stopReason: 'error', provider, timestamp: Date.now(),
    errorMessage: `Original provider error ${status}. Try again in 30 minutes.`,
    diagnostics: [{ type: 'provider_stream_failure', details: { status, kind: status === 429 ? 'rate_limit' : 'invalid_request', retryAfterMs: 1_800_000 } }],
  };
}

for (const provider of ['anthropic', 'openai-codex']) {
  test(`${provider} picker names Auto, Manual, current identity and Off eligibility`, async () => {
    const run = session({ provider, choose: 2 });
    await run.account();
    const [prompt] = run.state.prompts;
    assert.match(prompt.title, /Auto Auto account/);
    assert.match(prompt.options[0], /^Auto /);
    assert.match(prompt.options[2], /^Manual Off account/);
    assert.match(prompt.options[2], /Off, Auto ineligible/);
    assert.deepEqual(run.state.calls.find(([verb]) => verb === 'use'), ['use', 'off-id', '--provider', provider, '--session', 'session-id']);
    assert.equal(run.state.confirmations, 0);
    assert.match(run.state.widgets.at(-1), /^account Manual Off account /);
  });

  test(`${provider} typed Off pick is immediate and follow returns Auto`, async () => {
    const run = session({ provider });
    await run.account('off-id');
    assert.equal(run.state.selection.mode, 'manual');
    assert.equal(run.state.confirmations, 0);
    assert.match(run.state.widgets.at(-1), /Manual Off account/);
    await run.account('follow');
    assert.deepEqual(run.state.selection, auto);
    assert.match(run.state.widgets.at(-1), /^account Auto Auto account /);
  });

  for (const status of [429, 400, 403]) {
    test(`${provider} Manual ${status} keeps provider text, reset and diagnostics`, async () => {
      const verb = status === 429 ? 'limited' : 'refused';
      const run = session({ provider, selection: manual, replies: { [verb]: {
        selection: manual, account: 'Off account', until: 12345, reason: 'consumer_terms', next: null, retry_at: null,
      } } });
      const original = failure(status, provider);
      const result = await run.message(original);
      assert.deepEqual(result.diagnostics, original.diagnostics);
      assert.ok(result.errorMessage.startsWith(original.errorMessage));
      assert.match(result.errorMessage, /Manual off-id remains selected/);
      assert.doesNotMatch(result.errorMessage, /retry uses|waits for its slot|out of the pool/);
      assert.deepEqual(run.state.calls.map(([verb]) => verb), [verb]);
    });
  }

  test(`${provider} Manual hook failure keeps lifecycle failure despite a stale wait`, async () => {
    const run = session({ provider, selection: manual, info: { error: 'consumer_terms', current: null, wait: { account: 'auto-id', slot_at: 12345 } } });
    const message = {
      ...failure(403, provider),
      errorMessage: `Failed to resolve API key for provider "${provider}" from shell command: /x/bin/pi-pool-token`,
      diagnostics: [{ type: 'agent_lifecycle_failure', details: { reason: 'hook failed' } }],
    };
    const result = await run.message(message);
    assert.deepEqual(result.diagnostics, message.diagnostics);
    assert.ok(result.errorMessage.startsWith(message.errorMessage));
    assert.match(result.errorMessage, /Manual off-id remains selected/);
    assert.deepEqual(run.state.calls.map(([verb]) => verb), ['who']);
    await run.footer();
    assert.match(run.state.widgets.at(-1), /^account Manual off-id · consumer_terms$/);
  });

  test(`${provider} Manual hook waits for its selected account without changing identity`, async () => {
    const slotAt = Date.now() / 1000 + 120;
    const run = session({ provider, selection: manual, info: { wait: { account: manual.account_id, slot_at: slotAt } } });
    const result = await run.message({
      ...failure(403, provider),
      errorMessage: `Failed to resolve API key for provider "${provider}" from shell command: /x/bin/pi-pool-token`,
      diagnostics: [{ type: 'agent_lifecycle_failure', details: { reason: 'hook failed' } }],
    });
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].type, 'provider_stream_failure');
    assert.equal(result.diagnostics[0].details.status, 429);
    assert.ok(result.diagnostics[0].details.retryAfterMs > 0);
    assert.match(result.errorMessage, /Manual Off account remains selected; this session waits for its slot/);
    assert.deepEqual(run.state.calls.map(([verb]) => verb), ['who']);
    assert.deepEqual(run.state.selection, manual);
  });

  test(`${provider} Manual auth refusal wins over a matching old wait`, async () => {
    const run = session({ provider, selection: manual, info: { error: 'needs-reauth', wait: { account: manual.account_id, slot_at: 12345 } } });
    const message = {
      ...failure(403, provider),
      errorMessage: `Failed to resolve API key for provider "${provider}" from shell command: /x/bin/pi-pool-token`,
      diagnostics: [{ type: 'agent_lifecycle_failure' }],
    };
    const result = await run.message(message);
    assert.deepEqual(result.diagnostics, message.diagnostics);
    assert.match(result.errorMessage, /needs-reauth/);
    assert.doesNotMatch(result.errorMessage, /waits for its slot/);
  });
}

test('Manual footer ignores an old vend and its proposed next account', async () => {
  const run = session({ selection: manual, info: { current: { ...current(row()), next: 'another@x' } } });
  await run.footer();
  assert.equal(run.state.widgets.at(-1), 'account Manual off-id · no pooled account');
});

test('Auto still rotates a 429 and strips the old reset', async () => {
  const run = session({ replies: { limited: { selection: auto, account: 'auto@x', until: 12345, next: 'next@x', retry_at: null } } });
  const result = await run.message(failure(429));
  assert.equal(result.diagnostics[0].details.retryAfterMs, undefined);
  assert.doesNotMatch(result.errorMessage, /Try again in 30 minutes/);
  assert.match(result.errorMessage, /the retry uses next@x/);
});

test('Auto still turns an account refusal into a rate-limit retry', async () => {
  const run = session({ replies: { refused: { selection: auto, account: 'auto@x', reason: 'consumer_terms', next: 'next@x', retry_at: null } } });
  const result = await run.message(failure(403));
  assert.equal(result.diagnostics[0].details.kind, 'rate_limit');
  assert.match(result.errorMessage, /the retry uses next@x/);
});

test('Auto still retries a transient hook failure', async () => {
  const run = session();
  const result = await run.message({
    ...failure(403), errorMessage: 'Failed to resolve API key for provider "anthropic" from shell command: /x/bin/pi-pool-token',
    diagnostics: [{ type: 'agent_lifecycle_failure' }],
  });
  assert.deepEqual(result.diagnostics, []);
  assert.match(result.errorMessage, /the retry uses a new hook run/);
});

test('Unknown selection cannot reclassify a hook failure as retryable', async () => {
  const run = session({ replies: { who: { providers: { anthropic: { current: null } } } } });
  assert.equal(await run.message({
    ...failure(403), errorMessage: 'Failed to resolve API key for provider "anthropic" from shell command: /x/bin/pi-pool-token',
    diagnostics: [{ type: 'agent_lifecycle_failure' }],
  }), undefined);
});

test('Argument completions label Auto and Manual choices explicitly', async () => {
  const run = session();
  const choices = await run.command().getArgumentCompletions();
  assert.ok(choices.some((choice) => choice.value === 'follow' && choice.label === 'Auto'));
  assert.ok(choices.some((choice) => choice.value === 'Off account' && choice.label === 'Manual Off account'));
});

test('Blocked Manual footer names the selected account and its actual error', async () => {
  const run = session({ selection: manual, info: { error: 'organization_disabled', current: { ...current(off), next: 'next@x' } } });
  await run.footer();
  assert.equal(run.state.widgets.at(-1), 'account Manual Off account · organization_disabled');
});

test('Manual picker title names the chosen identity even without a vend', async () => {
  const run = session({ selection: manual, rows: [row({ current: false }), off] });
  await run.account();
  assert.match(run.state.prompts[0].title, /Manual Off account$/);
});

test('Manual reply ignores proposed fallback and slot hints', async () => {
  const run = session({ selection: manual, replies: { refused: {
    selection: manual, account: 'off-id', reason: 'consumer_terms', next: 'next@x', retry_at: 12345,
  } } });
  const original = failure(403);
  const result = await run.message(original);
  assert.deepEqual(result.diagnostics, original.diagnostics);
  assert.doesNotMatch(result.errorMessage, /retry uses|waits for its slot/);
});

test('Unknown health reply mode cannot strip a provider reset', async () => {
  const run = session({ replies: { limited: { account: 'off-id', until: 12345, next: 'next@x' } } });
  assert.equal(await run.message(failure(429)), undefined);
});

test('Manual healthy footer never suggests a next account', async () => {
  const run = session({ selection: manual, info: { current: { ...current(off), next: 'next@x' } } });
  await run.footer();
  assert.match(run.state.widgets.at(-1), /^account Manual Off account /);
  assert.doesNotMatch(run.state.widgets.at(-1), /next@x|→/);
});

test('Auto leaves a provider request error untouched when it is not an account refusal', async () => {
  const run = session({ replies: { refused: { selection: auto, reason: null, next: null, retry_at: null } } });
  assert.equal(await run.message(failure(400)), undefined);
});

test('Manual keeps a provider request error unchanged even without an account refusal', async () => {
  const run = session({ selection: manual, replies: { refused: { selection: manual, reason: null, next: null, retry_at: null } } });
  const original = failure(400);
  const result = await run.message(original);
  assert.deepEqual(result.diagnostics, original.diagnostics);
  assert.ok(result.errorMessage.startsWith(original.errorMessage));
});
