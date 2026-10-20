// Drives session_start and the first context call with a pool CLI that answers only when told, and prints the order of events.
// node start_driver.mjs <index.ts>
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';

const [file] = process.argv.slice(2);
const events = [];
const held = [];
const childProcess = createRequire(import.meta.url)('node:child_process');
childProcess.execFile = (_bin, args, _options, callback) => {
  events.push(`cli ${args[1]}`);
  const reply = args[1] === 'admit' ? { state: 'admitted', kind: 'owner', position: null, total: null } : {};
  held.push(() => callback(null, JSON.stringify(reply), ''));
};
syncBuiltinESMExports();
const answerAll = async () => { while (held.length) { held.shift()(); await new Promise((resolve) => setImmediate(resolve)); } };

const { default: extension } = await import(pathToFileURL(file));
const handlers = new Map();
extension({ on: (name, handler) => handlers.set(name, handler), registerCommand: () => {}, appendEntry: () => {} });
const ctx = {
  hasUI: false,
  model: { provider: 'anthropic', id: 'claude-x' },
  sessionManager: { getSessionId: () => 's1', getHeader: () => ({ type: 'session', id: 's1', rlmDepth: 0 }) },
  ui: { setWidget: () => {}, notify: () => {}, theme: { fg: (_color, text) => text } },
  isIdle: () => true,
};
await handlers.get('session_start')({ type: 'session_start' }, ctx);
events.push('session_start done');
const context = handlers.get('context')({ type: 'context' }, ctx).then(() => events.push('context done'));
for (let round = 0; round < 6; round += 1) { await new Promise((resolve) => setTimeout(resolve, 5)); await answerAll(); }
await context;
console.log(JSON.stringify(events));
process.exit(0);
