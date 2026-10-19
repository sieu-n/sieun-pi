// Starts the chat server the way sieun-pi-chat.service does: on systemd's socket at fd 3, with the early shell's process started first
// (chat-service-cli.mjs), then tsx and startChatServer with that early shell. Prints "up <url>" or "failed <message>".
import { startEarlyChild } from "../../src/early-shell-start.mjs";

const early = startEarlyChild(["serve", "--data-dir", process.argv[2]]);
const { register } = await import("tsx/esm/api");
register();
const { startChatServer } = await import("../../src/chat-server.ts");
// "busy": the thread stands still 1 s while the hand-over waits, as the rest of a real start does.
if (process.argv[3] === "busy") setTimeout(() => { const until = Date.now() + 1000; while (Date.now() < until) { /* catalog */ } }, 0);
const asset = { body: Buffer.from(""), etag: "e", contentType: "text/plain" };
try {
  const server = await startChatServer({ backend: { close: async () => {} }, bundle: { js: asset, css: asset, version: "test" }, port: 0, listenFd: 3, early,
    capability: "cap", csrfToken: "tok", stopToken: "stop", identity: { pid: process.pid, instanceId: "test", socketPath: "/isolated-root.sock" }, onStop: async () => {} });
  process.stdout.write(`up ${server.url}\n`);
} catch (error) {
  process.stdout.write(`failed ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
