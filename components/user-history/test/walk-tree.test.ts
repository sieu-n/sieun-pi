// 10-27 us-metal02: in 7 minutes from 02:02 to 02:50Z the chat's file reads waited 2.5 to 3.6 s for a thread-pool thread, and d7 read
// clean_min_30 at 27. Each was the 10-min sweep of deleted jobs: Node's readdir with `recursive: true` followed jobs' node_modules links to
// ~/src/sieun-pi/node_modules, which links to itself, until ELOOP: it held all 4 pool threads 3.1 s per chat folder in a copy, then found
// no deleted job in that chat.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deletedFolders, sessionTree } from "../src/job-leftovers.ts";
import { removeTree, walkTree } from "../src/walk-tree.ts";

/**
 * A chat folder like 01a1164b's: a deleted job, and a live job with a session file whose repo export links its node_modules to the checkout's,
 * which links to itself as ~/src/sieun-pi/node_modules/node_modules did on us-metal02 from 10-19. A package there ships an rlm-subagent.json.
 */
async function chatFolder(): Promise<{ chat: string; deleted: string; live: string }> {
  const root = await mkdtemp(join(tmpdir(), "walk-tree-"));
  const chat = join(root, "chat");
  const deleted = join(chat, "sub-019a334c");
  const live = join(chat, "sub-21b8f143");
  const modules = join(root, "sieun-pi", "node_modules");
  await mkdir(join(modules, "pkg"), { recursive: true });
  await writeFile(join(modules, "pkg", "rlm-subagent.json"), JSON.stringify({ status: "deleted" }));
  await symlink(modules, join(modules, "node_modules"));
  await mkdir(deleted, { recursive: true });
  await writeFile(join(deleted, "rlm-subagent.json"), JSON.stringify({ status: "deleted" }));
  await mkdir(join(live, "work", "prime-copy"), { recursive: true });
  await writeFile(join(live, "rlm-subagent.json"), JSON.stringify({ status: "running" }));
  await writeFile(join(live, "01a17b35-0690-722e-9c0d-23975eecc700.jsonl"), "{}\n");
  await symlink(modules, join(live, "work", "prime-copy", "node_modules"));
  return { chat, deleted, live };
}

test("the sweep of deleted jobs finds them in a chat folder whose job left a node_modules link that loops back", async () => {
  const { chat, deleted } = await chatFolder();
  assert.deepEqual(await deletedFolders(chat), [deleted], "readdir recursive went through the link and read a package in the checkout as a deleted job");
});

test("a job end reads each session of a folder once, though a link in it loops back", async () => {
  const { live } = await chatFolder();
  await symlink(live, join(live, "loop"));
  assert.deepEqual((await sessionTree(live)).sessions, ["01a17b35-0690-722e-9c0d-23975eecc700"]);
});

test("walkTree lists each entry once and lists a link without going through it", async () => {
  const { chat } = await chatFolder();
  const names: string[] = [];
  for await (const entry of walkTree(chat)) names.push(join(entry.parentPath, entry.name).slice(chat.length));
  assert.deepEqual(names.sort(), ["/sub-019a334c", "/sub-019a334c/rlm-subagent.json", "/sub-21b8f143", "/sub-21b8f143/01a17b35-0690-722e-9c0d-23975eecc700.jsonl",
    "/sub-21b8f143/rlm-subagent.json", "/sub-21b8f143/work", "/sub-21b8f143/work/prime-copy", "/sub-21b8f143/work/prime-copy/node_modules"]);
  for await (const entry of walkTree(join(chat, "missing"))) assert.fail(`a missing folder has no entries, got ${entry.name}`);
});

test("removeTree deletes a tree and leaves what a link in it points to", async () => {
  const { chat, live } = await chatFolder();
  const modules = join(chat, "..", "sieun-pi", "node_modules");
  assert.equal(await removeTree(live), true);
  assert.equal(existsSync(live), false);
  assert.equal(existsSync(join(modules, "pkg", "rlm-subagent.json")), true, "the link to the checkout's node_modules was removed, not followed");
  assert.equal(await removeTree(join(chat, "missing")), true, "a tree already gone counts as gone");
});
