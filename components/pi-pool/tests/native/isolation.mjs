import * as childProcess from 'node:child_process';
import childProcessMutable from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const output = process.env.PI_POOL_TEST_OUTPUT_DIR;
const marker = process.env.PI_POOL_TEST_ISOLATION_LOG ?? (output && join(output, `isolation-${process.pid}.jsonl`));
if (!marker) throw new Error('PI_POOL_TEST_OUTPUT_DIR or PI_POOL_TEST_ISOLATION_LOG is required');

function deny(message) {
  appendFileSync(marker, JSON.stringify({ pid: process.pid, violation: message }) + '\n');
  throw new Error(`pi-pool fixture isolation: ${message}`);
}
function checkHost(host) {
  if (!['127.0.0.1', '::1', '[::1]', 'localhost'].includes(host)) deny(`network access denied to ${host}`);
}

for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync']) {
  const original = childProcess[name];
  childProcessMutable[name] = function (...args) {
    const command = [args[0], ...(Array.isArray(args[1]) ? args[1] : [])].join(' ');
    if (/(?:\/usr\/bin\/security|(?:^|\s)security(?:\s|$))/.test(command)) deny('macOS Keychain command denied');
    return Reflect.apply(original, this, args);
  };
}
syncBuiltinESMExports();

const connect = Socket.prototype.connect;
Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (options && typeof options === 'object') {
    if (!options.path) checkHost(options.host ?? 'localhost');
  } else if (typeof options === 'number') {
    checkHost(typeof args[1] === 'string' ? args[1] : 'localhost');
  }
  return Reflect.apply(connect, this, args);
};

const fetchOriginal = globalThis.fetch;
globalThis.fetch = function (input, init) {
  checkHost(new URL(typeof input === 'string' || input instanceof URL ? input : input.url).hostname);
  return fetchOriginal(input, init);
};

export const isolationEnv = {
  PI_POOL_TEST_ISOLATION_LOG: marker,
  PI_POOL_TEST_ALLOW_LOOPBACK: '1',
  PYTHONPATH: join(here, '..', 'isolation'),
  PYTHONDONTWRITEBYTECODE: '1',
  NODE_OPTIONS: `--import ${JSON.stringify(fileURLToPath(import.meta.url))}`,
};
Object.assign(process.env, isolationEnv);

export function assertNoIsolationViolations() {
  if (existsSync(marker)) throw new Error(readFileSync(marker, 'utf8'));
}
