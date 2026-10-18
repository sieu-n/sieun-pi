import { startEarlyChild } from "./early-shell-start.mjs";

// The early shell starts before tsx and the service load (src/early-shell-start.mjs).
globalThis.__chatEarlyShell = startEarlyChild(process.argv.slice(2));
const { register } = await import("tsx/esm/api");
register();

try {
  const { runChatCommand } = await import("./chat-service.ts");
  await runChatCommand(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  const written = new Promise(resolve => process.stderr.write("sieun-pi chat: " + message + "\n", resolve));
  const sent = process.connected ? new Promise(resolve => process.send({ error: message }, resolve)) : null;
  // A failed serve may already hold the usage database lock, a daemon keeper and the page build worker, which keep it running unseen.
  // It exits once the error reached its log and its starter.
  if (process.argv[2] === "serve") { await Promise.all([written, sent]); process.exit(1); }
} finally {
  if (process.connected) process.disconnect();
}
