// Guards the 05:35Z case of 10-18: the Mac daemon reopened its old copy of 'tiktok shop', a chat that had moved to us-metal02, for a message,
// and the copy ran tool calls until 05:39Z. A session whose chat is in the agent dir's moved-to-<host> folder gets its tools refused.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { movedTo, treeRoot } from "../src/moved-copy.ts";

test("a moved chat and its jobs read as moved to their host, and a chat that stayed reads as here", async () => {
  const agent = await mkdtemp(join(tmpdir(), "moved-copy-"));
  const tiktok = "01a10db8-b6d5-7219-ac49-2efa75ad73d8";
  const stayed = "01a11ba8-9d2c-727c-8ded-38f819ca9f29";
  await mkdir(join(agent, "moved-to-us-metal02", "sessions"), { recursive: true });
  await writeFile(join(agent, "moved-to-us-metal02", "sessions", `${tiktok}.jsonl`), "{}\n");
  const reopened = join(agent, "sessions", `${tiktok}.jsonl`);
  const job = join(agent, "session-artifacts", tiktok, "sub-fdb3ab77", "01a14d4d-ce53-7000-8000-000000000000.jsonl");
  assert.equal(treeRoot(agent, job), tiktok);
  assert.equal(movedTo(agent, reopened), "us-metal02");
  assert.equal(movedTo(agent, job), "us-metal02");
  assert.equal(movedTo(agent, join(agent, "sessions", `${stayed}.jsonl`)), null);
  assert.equal(movedTo(agent, undefined), null, "an in-memory session");
  assert.equal(movedTo(agent, join(tmpdir(), "elsewhere", `${tiktok}.jsonl`)), null, "a file outside the agent dir");
});
