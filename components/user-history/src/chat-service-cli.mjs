import { existsSync } from "node:fs";
import { startEarlyChild } from "./early-shell-start.mjs";

// The early shell starts before tsx and the service load (src/early-shell-start.mjs).
globalThis.__chatEarlyShell = startEarlyChild(process.argv.slice(2));
// A release runs the service from its bundle (src/chat-service-bundle.mjs) with no tsx: tsx compiles each .ts file on its first import, keyed
// on the file's path, so every start in a new release folder compiled them all again, and its hooks then also hash each loaded .mjs.
const bundle = new URL("./chat-service.bundle.mjs", import.meta.url);
const bundled = existsSync(bundle);
if (!bundled) (await import("tsx/esm/api")).register();

try {
  const { runChatCommand } = await import(bundled ? bundle.href : "./chat-service.ts");
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
