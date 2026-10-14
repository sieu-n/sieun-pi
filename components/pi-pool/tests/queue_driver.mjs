// Drives the extension's turn-queue handlers (input when it has one, context, agent_end) against the
// real pool CLI in the PI_POOL_DIR this process inherits, and prints what happened.
// node queue_driver.mjs <index.ts> '<steps JSON>'
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [file, stepsJson] = process.argv.slice(2);
const steps = JSON.parse(stepsJson);
const CLI = join(new URL('.', import.meta.url).pathname, '..', 'bin', 'pi-pool');
const { default: extension } = await import(pathToFileURL(file));
const sessions = new Map();
const out = { entries: [], context: {}, queues: {} };
const files = join(process.env.PI_POOL_DIR, 'driver-sessions');
mkdirSync(files, { recursive: true });

for (const step of steps) {
  const session = sessions.get(step.name);
  if (step.op === 'start') {
    const handlers = new Map();
    extension({ on: (name, handler) => handlers.set(name, handler), registerCommand: () => {},
      appendEntry: (type, data) => out.entries.push({ session: step.name, type, text: data.text }) });
    let parentSession;
    if (step.parent) {
      parentSession = join(files, `${step.parent}-file.jsonl`);
      writeFileSync(parentSession, JSON.stringify({ type: 'session', id: step.parent }) + '\n');
    }
    const header = { type: 'session', id: step.name, rlmDepth: step.depth ?? 0, ...(parentSession ? { parentSession } : {}) };
    const state = { controller: undefined, idle: true };
    const ctx = {
      hasUI: false,
      model: { provider: 'anthropic', id: 'claude-x' },
      sessionManager: { getSessionId: () => step.name, getHeader: () => header },
      ui: { setWidget: () => {}, notify: () => {}, theme: { fg: (_c, t) => t } },
      get signal() { return state.controller?.signal; },
      isIdle: () => state.idle,
    };
    sessions.set(step.name, { handlers, ctx, state });
  } else if (step.op === 'input') {
    await session.handlers.get('input')?.({ type: 'input', text: 'hi', source: step.source }, session.ctx);
  } else if (step.op === 'context') {
    session.state.controller = new AbortController();
    session.state.idle = false;
    const started = Date.now();
    session.pending = session.handlers.get('context')({ type: 'context', messages: [] }, session.ctx).then(() => Date.now() - started);
  } else if (step.op === 'wait') {
    const ms = await Promise.race([session.pending, new Promise((r) => setTimeout(() => r(null), step.ms))]);
    out.context[step.label] = ms;
  } else if (step.op === 'abort') {
    session.state.controller.abort();
  } else if (step.op === 'end') {
    session.state.idle = true;
    await session.handlers.get('agent_end')({ type: 'agent_end', messages: [] }, session.ctx);
  } else if (step.op === 'queue') {
    out.queues[step.label] = JSON.parse(execFileSync('/usr/bin/python3', ['-B', CLI, 'queue', '--json'], { encoding: 'utf8' }));
  } else if (step.op === 'cli') {
    execFileSync('/usr/bin/python3', ['-B', CLI, ...step.args], { encoding: 'utf8' });
  } else if (step.op === 'clock') {
    const real = Date.now;
    Date.now = () => real() + step.ms;
  } else if (step.op === 'sleep') {
    await new Promise((r) => setTimeout(r, step.ms));
  }
}
console.log(JSON.stringify(out));
process.exit(0);
