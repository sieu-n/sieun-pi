// Guards 11-05: each lookup of a session file the daemon no longer lists walked session-artifacts with readdir on the chat's main thread, 62,472
// folders on us-metal02, 9.8 s and 3.2 s of CPU a walk. After the 03:47:19Z start the outbox's retries ran such walks for 13.8 s of the
// first minute's main thread, and an older-messages read in that minute took 1.4 s (d7 clean_min_30).
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fsp from "node:fs/promises";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { sessionFileOf } from "../src/send-once.ts";

const ROOTS = 120;
const CHILD = "01a1a9e5-0000-7000-8000-00000000c41d";
const MISSING = "230bbdbf-0000-7000-8000-000000000000";

/** An agent dir with ROOTS roots, each with two levels of subagent folders and a folder of other files, and CHILD two levels down in one. */
function agentDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "session-file-index-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (let n = 0; n < ROOTS; n++) {
    const root = join(dir, "session-artifacts", `root-${n}`);
    mkdirSync(join(root, "sub-a", "sub-b"), { recursive: true });
    mkdirSync(join(root, "work", "deep"), { recursive: true });
    writeFileSync(join(root, "sub-a", `child-${n}.jsonl`), "{}\n");
  }
  writeFileSync(join(dir, "session-artifacts", "root-77", "sub-a", "sub-b", `${CHILD}.jsonl`), "{}\n");
  return dir;
}

/** Counts the folders this process reads and the processes it starts while `run` runs. */
async function counted<T>(t: TestContext, run: () => Promise<T>): Promise<{ result: T; folders: number; spawns: number }> {
  const readdir = t.mock.method(fsp, "readdir");
  const spawn = t.mock.method(childProcess, "spawn");
  syncBuiltinESMExports();
  try {
    const result = await run();
    return { result, folders: readdir.mock.callCount(), spawns: spawn.mock.callCount() };
  } finally {
    readdir.mock.restore(); spawn.mock.restore();
    syncBuiltinESMExports();
  }
}

test("20 lookups of a session no folder holds read no folder on the chat's thread and share one search", async t => {
  const dir = agentDir(t);
  const { result, folders, spawns } = await counted(t, () => Promise.all(Array.from({ length: 20 }, () => sessionFileOf(MISSING, dir))));
  assert.deepEqual(new Set(result), new Set([null]));
  assert.equal(folders, 0, "the readdir walk read every folder once per lookup");
  assert.equal(spawns, 1, "one search answered all 20");
});

test("an ended subagent's file is found by the search, and a later lookup of it reads nothing new", async t => {
  const dir = agentDir(t);
  const file = join(dir, "session-artifacts", "root-77", "sub-a", "sub-b", `${CHILD}.jsonl`);
  assert.equal(await sessionFileOf(CHILD, dir), file);
  const again = await counted(t, async () => [await sessionFileOf(CHILD, dir), await sessionFileOf("child-5", dir)]);
  assert.deepEqual(again.result, [file, join(dir, "session-artifacts", "root-5", "sub-a", "child-5.jsonl")]);
  assert.equal(again.folders, 0);
  assert.equal(again.spawns, 1, "the first name was known, the second took one search");
});

// 11-08 us-metal02: the listing printed all 66,659 transcripts, 8.4 MB, and the chat split them on its main thread at each miss, 0.2 to 0.65 s
// with garbage collection four times a minute while the outbox retried a send to a root with no file; d7 read 12:03Z dirty from a 1.3 s stall.
test("a lookup that misses reads only the asked name's lines from its search, not every transcript in the tree", async t => {
  const dir = agentDir(t);
  const original = childProcess.spawn;
  let bytes = 0;
  t.mock.method(childProcess, "spawn", function (this: unknown, ...args: unknown[]) {
    const child = Reflect.apply(original, this, args) as ReturnType<typeof original>;
    child.stdout?.on("data", (chunk: Buffer) => { bytes += chunk.length; });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const made = join(dir, "session-artifacts", "root-3", "sub-a", `${MISSING}.jsonl`);
  writeFileSync(made, "{}\n");
  assert.equal(await sessionFileOf(MISSING, dir), made);
  assert.equal(await sessionFileOf(CHILD.replace("c41d", "dead"), dir), null);
  assert.ok(bytes <= made.length + 1, `the chat read ${bytes} bytes of paths for two lookups in a tree of ${ROOTS + 1} transcripts`);
});

test("a file made after a listing is found, one removed is not, and a root's own file wins", async t => {
  const dir = agentDir(t);
  assert.equal(await sessionFileOf(MISSING, dir), null);
  const made = join(dir, "session-artifacts", "root-3", "sub-a", `${MISSING}.jsonl`);
  writeFileSync(made, "{}\n");
  assert.equal(await sessionFileOf(MISSING, dir), made);
  rmSync(made);
  assert.equal(await sessionFileOf(MISSING, dir), null);
  assert.equal(await sessionFileOf("work", dir), null, "only sub-* folders hold subagent files");
  writeFileSync(join(dir, "session-artifacts", "root-9", "work", "deep", `${MISSING}.jsonl`), "{}\n");
  assert.equal(await sessionFileOf(MISSING, dir), null, "a file outside the sub-* folders is no session file");
  mkdirSync(join(dir, "sessions"));
  writeFileSync(join(dir, "sessions", `${CHILD}.jsonl`), "{}\n");
  assert.equal(await sessionFileOf(CHILD, dir), join(dir, "sessions", `${CHILD}.jsonl`));
});
