import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dutyJobHost, savedChat } from "../src/chat-duty-job.ts";
import type { JobRegistry } from "../src/chat-sources.ts";

// 10-17 21:00:50Z: the first check-in slot of the new chat "YouTube index gaps" (01a14b8d) started no job: "the catalog cannot list the chat:
// Timed out after 30000ms waiting for the Prime Agent daemon response to "list"" at load 70 after a reboot. The chat's own session file names it.
const CHAT = "01a14b8d-c276-77a6-affe-302ad42b09d7";
const CWD = "/Users/sieunpark/Documents/Github/auto-sns-agent";
const header = JSON.stringify({ type: "session", version: 3, id: CHAT, timestamp: "2026-10-17T20:29:03.990Z", cwd: CWD, rlmDepth: 0 });
const info = (name: string) => JSON.stringify({ type: "session_info", id: "ea339379", parentId: "6d9daa2c", timestamp: "2026-10-17T20:30:32.308Z", name });

test("savedChat: the header's cwd and the first session_info name; null for a file with no header", async () => {
  const dir = await mkdtemp(join(tmpdir(), "saved-chat-"));
  const file = join(dir, `${CHAT}.jsonl`);
  await writeFile(file, [header, JSON.stringify({ type: "model_change" }), info("YouTube index gaps"), info("renamed later")].join("\n") + "\n");
  assert.deepEqual(await savedChat(file), { name: "YouTube index gaps", cwd: CWD });
  await writeFile(join(dir, "bad.jsonl"), info("x") + "\n");
  assert.equal(await savedChat(join(dir, "bad.jsonl")), null);
});

test("duty job host: a chat the catalog cannot list while its refresh times out is named from its session file; a list that answers without it is still null", async () => {
  const lines: string[] = [];
  let refresh: () => Promise<void> = async () => { throw new Error('Timed out after 30000ms waiting for the Prime Agent daemon response to "list"'); };
  const host = dutyJobHost({ threads: {} as never, archives: { add: async () => {} }, rows: async () => [], registry: {} as JobRegistry,
    board: id => `/boards/${id}.json`, refresh: () => refresh(), saved: async id => id === CHAT ? { name: "YouTube index gaps", cwd: CWD } : null, log: line => lines.push(line) });
  assert.deepEqual(await host.chat(CHAT), { id: CHAT, name: "YouTube index gaps", cwd: CWD, board: `/boards/${CHAT}.json` });
  assert.match(lines.join("\n"), /the catalog cannot list the chat \(Timed out after 30000ms.*\); its session file names it "YouTube index gaps"/);
  await assert.rejects(host.chat("01a14b8d-0000-7000-8000-000000000000"), /the catalog cannot list the chat: Timed out/, "no session file: the failure stays");
  refresh = async () => {};
  assert.equal(await host.chat(CHAT), null, "a list that answered and does not show the chat means the chat is gone");
});
