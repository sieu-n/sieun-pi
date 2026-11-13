// Guards 11-13: a herd of full daemon lists (11,228 saved sessions, 97 MB, about 13 CPU-s each on the supervisor's one thread) held every
// other daemon call up to 657 s. `sieun-pi hosts transcript` finds a session's file in the live list first and lists every saved session
// only when the live list does not name it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { listedSessionFile } from "../src/hosts-cli.ts";

test("a transcript lookup reads the live list first and the full list only for a session no worker holds", async () => {
  const asked: unknown[] = [];
  const request = async (command: { type: "list"; all?: true }) => {
    asked.push(command);
    return command.all ? { sessions: [{ sessionId: "01a1-saved", sessionFile: "/s/saved.jsonl" }] } : { sessions: [{ sessionId: "01a1-live", sessionFile: "/s/live.jsonl" }] };
  };
  assert.equal(await listedSessionFile(request, "01a1-live", "us-metal02"), "/s/live.jsonl");
  assert.deepEqual(asked, [{ type: "list" }]);
  assert.equal(await listedSessionFile(request, "01a1-saved", "us-metal02"), "/s/saved.jsonl");
  assert.deepEqual(asked.slice(1), [{ type: "list" }, { type: "list", all: true }]);
  await assert.rejects(listedSessionFile(request, "01a1-none", "mac"), /no session 01a1-none on mac/);
});
