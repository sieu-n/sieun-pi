// Guards 11-08: during a reload's hand-over the running chat passes every write on to the successor's own port with the Host it came with
// (src/chat-handoff.ts). The successor's loopback host was empty until its take resolved, so it answered each with 421 "Unexpected host.", and
// board writes and cross-host sends failed from 14:56:10Z to 14:57:19Z and from 15:51:40Z to 15:52:41Z.
import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { startChatServer } from "../src/chat-server.ts";
import type { ChatBackend } from "../src/chat-backend.ts";
import type { EarlyShell } from "../src/early-shell.ts";

const PUBLIC_PORT = 45182;

function post(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "POST", agent: false,
      headers: { host: `127.0.0.1:${PUBLIC_PORT}`, origin: `http://127.0.0.1:${PUBLIC_PORT}`, "content-type": "application/json" } }, res => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on("error", reject); req.end("{}");
  });
}

test("a successor answers a passed-on write with the service's Host before it took the port", { timeout: 20_000 }, async t => {
  // The shell works like HandoffParent.shell: the successor's own port answers at once, and the service's socket only once the gate opens.
  let own: Server | undefined;
  let ownPort!: (port: number) => void;
  const ownPortKnown = new Promise<number>(resolve => { ownPort = resolve; });
  let open!: () => void;
  const gate = new Promise<void>(resolve => { open = resolve; });
  const early: EarlyShell = {
    server: createServer(),
    async settled() {},
    async take(handler) {
      own = createServer(handler);
      await new Promise<void>(resolve => own!.listen(0, "127.0.0.1", resolve));
      ownPort((own.address() as AddressInfo).port);
      await gate;
      early.server.on("request", handler);
      await new Promise<void>(resolve => early.server.listen(0, "127.0.0.1", resolve));
    },
  };
  const asset = { body: Buffer.from(""), etag: "e", contentType: "text/plain" };
  const starting = startChatServer({ backend: { close: async () => {} } as unknown as ChatBackend, bundle: { js: asset, css: asset, version: "test" }, port: PUBLIC_PORT,
    early, capability: "cap", csrfToken: "token", stopToken: "stop",
    identity: { pid: process.pid, instanceId: "test", socketPath: "/isolated-root.sock" }, onStop: async () => {} });
  t.after(async () => { open(); own?.close(); await (await starting).close(); });
  const port = await ownPortKnown;
  // api/service-stop refuses a request without its token with 403, after the host check passed.
  assert.equal(await post(port, "/cap/api/service-stop"), 403);
  open();
  await starting;
});
