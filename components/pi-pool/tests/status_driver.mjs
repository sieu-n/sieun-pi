// Drives the /account extension through a scripted session with a fake clock,
// fake timers and a fake pool CLI, and prints the CLI calls it made.
// node status_driver.mjs <index.ts> '<steps JSON>'
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';

const [file, stepsJson] = process.argv.slice(2);
const steps = JSON.parse(stepsJson);
const calls = [];
const messages = [];
const times = [];
let pending = 0;
const replies = {
  who: { providers: { anthropic: { current: { email: 'a@x', label: 'a@x', session_pct: 10, weekly_pct: 5, gated_pct: 1, next: false } } } },
  ls: { provider: 'anthropic', session: null, rows: [{ id: 'a', email: 'a@x', label: 'a@x', usage: '', session_pct: 10, weekly_pct: 5, gated_pct: 1, usable: true, reason: null, current: true, pinned: false, live: false, score: 1 }] },
};
const childProcess = createRequire(import.meta.url)('node:child_process');
childProcess.execFile = (_bin, args, _options, callback) => {
  const verb = args[1];
  calls.push(verb);
  times.push(now);
  pending += 1;
  setImmediate(() => {
    pending -= 1;
    callback(null, JSON.stringify(replies[verb] ?? {}), '');
  });
};
syncBuiltinESMExports();

let now = 1_000_000;
Date.now = () => now;
const timers = [];
const addTimer = (interval) => (fn, ms) => {
  const timer = { fn, ms, interval, due: now + ms, cleared: false };
  timers.push(timer);
  return timer;
};
globalThis.setTimeout = addTimer(false);
globalThis.setInterval = addTimer(true);
globalThis.clearTimeout = globalThis.clearInterval = (timer) => { if (timer) timer.cleared = true; };

async function settle() {
  for (let quiet = 0; quiet < 3; quiet += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    if (pending > 0) quiet = -1;
  }
}
async function advance(ms) {
  const end = now + ms;
  for (;;) {
    const next = timers.filter((timer) => !timer.cleared && timer.due <= end).sort((a, b) => a.due - b.due)[0];
    if (!next) break;
    now = next.due;
    if (next.interval) next.due += next.ms;
    else next.cleared = true;
    next.fn();
    await settle();
  }
  now = end;
}

const { default: extension } = await import(pathToFileURL(file));
const sessions = new Map();
for (const step of steps) {
  if (step.op === 'start') {
    const handlers = new Map();
    let command;
    extension({ on: (name, handler) => handlers.set(name, handler), registerCommand: (_name, options) => { command = options; } });
    const header = { type: 'session', id: step.name, rlmDepth: step.depth ?? 0, ...(step.depth ? { parentSession: 'parent.jsonl' } : {}) };
    const ctx = {
      hasUI: step.hasUI ?? true,
      model: { provider: 'anthropic', id: 'claude-x' },
      sessionManager: { getSessionId: () => step.name, getHeader: () => header },
      ui: { setWidget: (_key, lines) => { session.widget = lines?.[0] ?? null; }, notify: () => {}, theme: { fg: (_color, text) => text } },
    };
    const session = { handlers, ctx, command: () => command, widget: null };
    sessions.set(step.name, session);
    await handlers.get('session_start')({ type: 'session_start' }, ctx);
    await settle();
  } else if (step.op === 'turns') {
    const session = sessions.get(step.name);
    for (let turn = 0; turn < step.count; turn += 1) {
      await advance(step.every ?? 0);
      await session.handlers.get('turn_end')({ type: 'turn_end' }, session.ctx);
    }
    await settle();
  } else if (step.op === 'concurrent') {
    const session = sessions.get(step.name);
    await Promise.all(Array.from({ length: step.count }, () => session.handlers.get('turn_end')({ type: 'turn_end' }, session.ctx)));
    await settle();
  } else if (step.op === 'model') {
    const session = sessions.get(step.name);
    await session.handlers.get('model_select')({ type: 'model_select', model: session.ctx.model }, session.ctx);
    await settle();
  } else if (step.op === 'account') {
    const session = sessions.get(step.name);
    await session.command().handler(step.target, session.ctx);
    await settle();
  } else if (step.op === 'advance') {
    await advance(step.ms);
  } else if (step.op === 'sleep') {
    // The Mac sleeps: the clock moves and no timer fires until the next advance.
    now += step.ms;
  } else if (step.op === 'reply') {
    replies[step.verb] = step.reply;
  } else if (step.op === 'message') {
    const session = sessions.get(step.name);
    const message = { ...step.message, timestamp: now };
    const out = await session.handlers.get('message_end')({ type: 'message_end', message }, session.ctx);
    messages.push(out?.message ?? null);
    await settle();
  } else if (step.op === 'mark') {
    calls.push(`mark:${step.label}`);
  } else {
    throw new Error(`unknown step ${step.op}`);
  }
}
const widgets = Object.fromEntries([...sessions].map(([name, session]) => [name, session.widget]));
const after = (label) => calls.slice(calls.indexOf(`mark:${label}`) + 1);
const whoCount = (list) => list.filter((verb) => verb === 'who').length;
const marks = Object.fromEntries(calls.filter((verb) => verb.startsWith('mark:')).map((verb) => [verb.slice(5), whoCount(after(verb.slice(5)))]));
console.log(JSON.stringify({ calls, times, who: whoCount(calls), whoAfterMark: marks, widgets, messages }));
