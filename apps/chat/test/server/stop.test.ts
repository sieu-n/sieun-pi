/**
 * Stopping the chat while pi-host restarts beside it. On 2026-10-28, restarting both services hung the chat's stop: its unwatch went to a
 * pi-host that was going away and retried for 30 s, past systemd's 20 s stop timeout, so systemd killed it and the restart took 20 s more.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { App } from "../../server/app.ts";
import { readConfig } from "../../server/config.ts";
import { PiHost } from "../../server/host/pi-host.ts";

const dir = mkdtempSync(join(tmpdir(), "apps-chat-stop-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("the chat stops in under 2 s when pi-host goes away during its unwatch", async () => {
  const socketPath = join(dir, "host.sock");
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk.toString();
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const command = JSON.parse(buffer.slice(0, newline)) as { id: string; type: string };
        buffer = buffer.slice(newline + 1);
        if (command.type === "durable_unwatch") {
          server.close();
          for (const open of sockets) open.destroy();
          return;
        }
        const data = command.type === "durable_threads" ? { threads: [] } : command.type === "durable_entries" ? { entries: [], more: false }
          : command.type === "durable_watch" ? { watch: "w1" } : {};
        socket.write(`${JSON.stringify({ type: "response", id: command.id, success: true, data })}\n`);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  const app = new App({ ...readConfig([]), dataDir: join(dir, "data"), port: 0, fixture: false, box: "test-box", socket: socketPath }, new PiHost(socketPath), () => {});
  await app.start();
  await app.threads.watch("0f1e0000-0000-4000-8000-00000000000a");
  const started = performance.now();
  await app.stop();
  const ms = performance.now() - started;
  assert.ok(ms < 2000, `stop took ${ms.toFixed(0)} ms`);
});
