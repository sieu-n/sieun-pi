// d7 11-04: at 00:53:27Z the chat's main thread spent 1,038 ms in the spawn of a `pi-pool lead` CLI run (the turn queue's lead list, written
// each tick), with 2.51 runnable threads a core on us-metal02, and d7 read a 1.07 s loop stall for 00:53Z. The service's own short pool commands
// now go through hookd's socket, so the chat forks no process for them.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { leadSessions, markOwnerTurn, poolQueueNow } from "../src/chat-pool.ts";

test("the lead list, the queue read and an owner turn go through hookd and start no pi-pool process", async t => {
  const dir = mkdtempSync(join(tmpdir(), "pool-quick-"));
  const ran = join(dir, "cli-ran");
  const cli = join(dir, "pi-pool");
  writeFileSync(cli, `#!/bin/sh\necho "$@" >> ${ran}\necho '{}'\n`);
  chmodSync(cli, 0o755);
  const argv: string[][] = [];
  const server = createServer(connection => {
    let request = Buffer.alloc(0);
    connection.on("error", () => {});
    connection.on("data", (chunk: Buffer) => {
      request = Buffer.concat([request, chunk]);
      const fields = request.toString("utf8").split("\0");
      const argc = Number(fields[5]);
      if (fields.length < 7 + argc || fields.length - 1 < 7 + argc + Number(fields[6 + argc])) return;
      argv.push(fields.slice(6, 6 + argc));
      connection.write(`J ${JSON.stringify({ code: 0, out: fields[6] === "queue" ? '{"queued": []}' : "", err: "" })}\n`);
    });
  });
  await new Promise<void>(resolve => server.listen(join(dir, "hook.sock"), resolve));
  t.after(() => server.close());
  const env = { PI_POOL_DIR: process.env.PI_POOL_DIR, PI_POOL_BIN: process.env.PI_POOL_BIN };
  process.env.PI_POOL_DIR = dir;
  process.env.PI_POOL_BIN = cli;
  t.after(() => { for (const [name, value] of Object.entries(env)) if (value === undefined) delete process.env[name]; else process.env[name] = value; });

  await leadSessions(["s1", "s2"]);
  assert.deepEqual(await poolQueueNow(), { queued: [] });
  await markOwnerTurn("s3");
  assert.deepEqual(argv.map(args => args[0]), ["lead", "queue", "owner-turn"]);
  assert.deepEqual(argv[0], ["lead", "s1", "s2"]);
  assert.equal(existsSync(ran), false, "no pi-pool process ran");
});
