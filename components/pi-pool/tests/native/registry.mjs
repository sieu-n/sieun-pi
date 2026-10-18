import { assertNoIsolationViolations } from './isolation.mjs';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { readdirSync, readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';

const install = process.argv[2];
const bundleDir = join(install, 'dist/bundle');
const bundle = readdirSync(bundleDir).find(name => name.endsWith('.js') && readFileSync(join(bundleDir, name), 'utf8').includes('async getApiKeyAndHeaders(model'));
const { ModelRegistry, AuthStorage } = await import(pathToFileURL(join(bundleDir, bundle)));
const provider = 'openai-codex';
const model = { provider, id: 'fixture' };
function registryFor(authStorage, command) {
  return Object.assign(Object.create(ModelRegistry.prototype), {
    authStorage, providerRequestConfigs: new Map([[provider, { apiKey: command }]]),
    modelRequestHeaders: new Map(), lastProviderAuthSourceTokens: new Map(), staleProviderRequestAuthSources: new Map(),
  });
}
let nativeLookups = 0;
const registry = registryFor({
  async getApiKeyWithSourceToken() { nativeLookups++; throw new Error('synthetic stale native login'); },
  getProviderHeaders() { return undefined; },
}, '!/usr/bin/printf synthetic-pool-key');
const result = await registry.getApiKeyAndHeaders(model);
assert.equal(result.ok, true, 'a usable pool key must not depend on native fallback refresh');
assert.equal(result.apiKey, 'synthetic-pool-key');
assert.equal(nativeLookups, 0);
assert.equal(registry.getCurrentProviderAuthSourceToken(provider).source, 'models_json_command');

const native = AuthStorage.inMemory({ [provider]: { type: 'api_key', key: 'synthetic-native-key' } });
const fallback = registryFor(native, '!/usr/bin/false');
const nativeToken = native.getCurrentAuthSourceToken(provider);
assert.equal((await fallback.getApiKeyAndHeaders(model)).apiKey, 'synthetic-native-key');
assert.deepEqual(fallback.getCurrentProviderAuthSourceToken(provider), nativeToken, 'fallback preserves its own fingerprint');
fallback.markProviderAuthSourceStale(nativeToken);
assert.equal(fallback.staleProviderRequestAuthSources.size, 0, 'rejecting fallback does not stale the hook');
assert.equal(native.getAvailableAuthCandidate(provider, { includeFallback: false }).hasStaleCandidate, true);
const stale = await fallback.getApiKeyAndHeaders(model);
assert.equal(stale.ok, false);
assert.equal(stale.reason, 'login_required', 'a known-stale native source is not an opaque temporary command failure');

const unavailable = registryFor(AuthStorage.inMemory(), '!/usr/bin/false');
const missing = await unavailable.getApiKeyAndHeaders(model);
assert.equal(missing.reason, 'command_unavailable');
assert(!missing.error.includes('/usr/bin/false'));
assert.equal(unavailable.lastProviderAuthSourceTokens.size, 0);
console.log(JSON.stringify({ passed: 4, nativeLookups, fallbackSource: nativeToken.source, staleReason: stale.reason }));

const outputDir = process.env.PI_POOL_TEST_OUTPUT_DIR;
if (!outputDir) throw new Error('PI_POOL_TEST_OUTPUT_DIR is required');
const scratch = mkdtempSync(join(outputDir, 'registry-abort-'));
let release;
let started;
const hookStarted = new Promise(resolve => { started = resolve; });
const server = createServer((_request, response) => {
  release = () => response.end('synthetic owner result');
  started();
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const ownerFile = join(scratch, 'owner-completed');
const script = join(scratch, 'owner.mjs');
writeFileSync(script, `import { get } from 'node:http';
import { writeFileSync } from 'node:fs';
get('http://127.0.0.1:${server.address().port}', response => {
  response.resume();
  response.on('end', () => { writeFileSync(${JSON.stringify(ownerFile)}, 'completed'); process.exit(1); });
});
`);
let fallbackLookups = 0;
const abortRegistry = registryFor({
  async getApiKeyWithSourceToken() { fallbackLookups++; throw new Error('fallback must not run after abort'); },
}, `!${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`);
const controller = new AbortController();
try {
  const pending = abortRegistry.getApiKeyAndHeaders(model, { signal: controller.signal });
  await hookStarted;
  controller.abort();
  release();
  const cancelled = await pending;
  assert.equal(readFileSync(ownerFile, 'utf8'), 'completed', 'failed in-flight owner finishes after abort');
  assert.equal(cancelled.reason, 'cancelled');
  assert.equal(fallbackLookups, 0, 'failed hook after abort cannot start native fallback');
  assert.equal(abortRegistry.lastProviderAuthSourceTokens.size, 0);
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
console.log(JSON.stringify({ failedHookAbort: 'passed', fallbackLookups }));

assertNoIsolationViolations();
