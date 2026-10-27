// Guards the second hop of a relay the 10-22 messaging audit found unrecorded: 768 messages to 263 stopped subagents went through their parents
// from 10-19 to 10-22, and nothing said whether or when a parent passed one on (sieun-pi agent-outbox.ts relay branch).
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { relayRecord } from "../src/chat-sources.ts";
import { relayHops } from "../src/subagent-relay.ts";

const RELAYED = Date.parse("2026-10-22T01:16:36Z");
const METAL_QUEUE = "01a16f2e-0000-7000-8000-000000000001";
const NEVER = "01a16f2e-0000-7000-8000-000000000002";

test("a relayed subagent that runs after its relay gets one line with the wait, and its record goes; one that has not run keeps its record", async t => {
  const dir = await mkdtemp(join(tmpdir(), "relay-hop-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "relayed.json");
  await writeFile(path, JSON.stringify({ [METAL_QUEUE]: RELAYED, [NEVER]: RELAYED }));
  const record = relayRecord(path);
  const lines: string[] = [];
  const rows = [{ sessionId: METAL_QUEUE, sessionName: "metal agent queue", lastActivityAt: RELAYED + 95_000 }, { sessionId: NEVER, lastActivityAt: RELAYED - 5_000 }];
  await relayHops(record, rows, line => { lines.push(line); });
  await relayHops(record, rows, line => { lines.push(line); });
  assert.deepEqual(lines, ["relay: 01a16f2e (metal agent queue) ran at 2026-10-22T01:18:11.000Z, 95 s after its message went through its parent"], "one line, once");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { [NEVER]: RELAYED });
});
