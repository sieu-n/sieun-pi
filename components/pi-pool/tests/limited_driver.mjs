// Runs the extension's message_end on one 429 against the real pool CLI and prints the message it returns.
// node limited_driver.mjs <index.ts> <retryAfterMs>
import { pathToFileURL } from 'node:url';

const [file, retryAfterMs] = process.argv.slice(2);
const { default: extension } = await import(pathToFileURL(file));
const handlers = new Map();
extension({ on: (name, handler) => handlers.set(name, handler), registerCommand: () => {}, appendEntry: () => {} });
const message = {
  role: 'assistant', stopReason: 'error', provider: 'anthropic', timestamp: Date.now(),
  errorMessage: "Provider rate limit exceeded (rate_limit_error, 429): This request would exceed your account's rate limit. Please try again later.",
  diagnostics: [{ type: 'provider_stream_failure', timestamp: Date.now(), details: { kind: 'rate_limit', status: 429, retryAfterMs: Number(retryAfterMs) } }],
};
const result = await handlers.get('message_end')({ type: 'message_end', message }, {});
console.log(JSON.stringify(result?.message ?? message));
process.exit(0);
