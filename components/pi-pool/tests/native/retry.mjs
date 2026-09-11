import { assertNoIsolationViolations } from './isolation.mjs';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const bundleDir = join(process.argv[2], 'dist/bundle');
const bundle = readdirSync(bundleDir).find(name => name.endsWith('.js') && readFileSync(join(bundleDir, name), 'utf8').includes('async function completeWithProviderRetry('));
const { completeWithProviderRetry, requestAuthFailureStream } = await import(pathToFileURL(join(bundleDir, bundle)));
const model = { provider: 'openai-codex', api: 'openai-codex-responses', id: 'fixture' };
const unavailable = await requestAuthFailureStream(model, { reason: 'command_unavailable', error: 'Synthetic unavailable credentials' }).result();
const login = await requestAuthFailureStream(model, { reason: 'login_required', error: 'Synthetic login required' }).result();
const providerFailure = kind => ({ ...unavailable, diagnostics: [{ type: 'provider_stream_failure', details: { kind } }] });
const lifecycle = { ...unavailable, diagnostics: [{ type: 'agent_lifecycle_failure' }] };
const policy = { enabled: true, maxRetries: 3, baseDelayMs: 1, maxRetryDelayMs: 100 };
let checked = 0;
for (const [enabled, maxRetries, expected] of [[false, 3, 1], [true, 0, 1], [true, 1, 2], [true, 3, 4]]) {
  let attempts = 0;
  await completeWithProviderRetry(async () => { attempts++; return unavailable; }, { policy: { ...policy, enabled, maxRetries } });
  assert.equal(attempts, expected);
  checked++;
}
for (const [message, expected] of [[login, 1], [lifecycle, 1], [providerFailure('invalid_request'), 1], [providerFailure('permission'), 1], [providerFailure('refusal'), 1], [providerFailure('auth'), 2]]) {
  let attempts = 0;
  await completeWithProviderRetry(async () => { attempts++; return message; }, { policy });
  assert.equal(attempts, expected);
  checked++;
}
const sequence = [unavailable, providerFailure('server_error'), unavailable, { ...unavailable, diagnostics: [], stopReason: 'stop' }];
let attempts = 0;
const recovered = await completeWithProviderRetry(async () => sequence[attempts++], { policy });
assert.equal(attempts, 4, 'mixed failures consume one budget');
assert.equal(recovered.stopReason, 'stop');
const controller = new AbortController();
attempts = 0;
const cancelled = await completeWithProviderRetry(async () => { attempts++; controller.abort(); return unavailable; }, { policy, signal: controller.signal });
assert.equal(cancelled.stopReason, 'aborted');
assert.equal(attempts, 1);
console.log(JSON.stringify({ passed: checked + 2 }));

assertNoIsolationViolations();
