/**
 * A pi-host restart while a hand-over waits for a write in flight ends the write fast instead of holding the hand-over for its 30 s
 * (http.ts WRITE_WAIT_MS): a create, which would act twice, fails at once, and a call that can repeat waits only for pi-host to come back.
 * A stand-in pi-host on its own socket closes its connection the way a restart does.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/pi-host-restart.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, test } from "node:test";
import { PiHost } from "../../server/host/pi-host.ts";

const dir = mkdtempSync(join(tmpdir(), "apps-chat-pi-host-restart-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** A pi-host stand-in that answers `answer` commands and closes the connection on any other, as a restart mid-call does. */
function standIn(path: string): Promise<Server> {
  const server = createServer((socket: Socket) => {
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk.toString();
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        const message = JSON.parse(buffer.slice(0, at)) as { id: string; type: string };
        buffer = buffer.slice(at + 1);
        if (message.type === "durable_threads") socket.write(`${JSON.stringify({ type: "response", id: message.id, success: true, data: { threads: [] } })}\n`);
        else socket.destroy();
      }
    });
  });
  return new Promise(resolve => server.listen(path, () => resolve(server)));
}

test("a create in flight when pi-host restarts fails at once", async () => {
  const path = join(dir, "a.sock");
  const server = await standIn(path);
  const host = new PiHost(path);
  try {
    const started = performance.now();
    await assert.rejects(host.create({ name: "x" }), /closed the connection/);
    assert.ok(performance.now() - started < 1000, `the create failed in ${Math.round(performance.now() - started)} ms`);
  } finally {
    await host.close();
    server.close();
  }
});

test("a call that can repeat waits only for pi-host to come back", async () => {
  const path = join(dir, "b.sock");
  let server = await new Promise<Server>(resolve => {
    const first = createServer(socket => socket.destroy());
    first.listen(path, () => resolve(first));
  });
  const host = new PiHost(path);
  try {
    const started = performance.now();
    const call = host.threads();
    await sleep(1500);
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(path, { force: true });
    server = await standIn(path);
    assert.deepEqual(await call, []);
    const took = performance.now() - started;
    assert.ok(took >= 1500 && took < 4000, `the read answered ${Math.round(took)} ms after it was sent`);
  } finally {
    await host.close();
    server.close();
  }
});
