// 10-27: the :5183 canary chat on pi-host listed the Mac's Prime threads ("there used to be a slack gre...", "realtime layer"), read through
// the live chat's bridge socket, so a click there could open a Prime thread from the canary. A canary serve lists only its pi-host's threads.
import assert from "node:assert/strict";
import { test } from "node:test";
import { serveHosts } from "../src/chat-service.ts";

test("a canary serve starts no other box's catalog, and any other serve does", async () => {
  const started: boolean[] = [];
  const start = async (primary: boolean) => { started.push(primary); return null; };
  assert.equal(await serveHosts(true, false, start), null);
  assert.deepEqual(started, [], "the canary never reads hosts.json");
  await serveHosts(false, true, start);
  assert.deepEqual(started, [true], "the main chat still lists every box");
});
