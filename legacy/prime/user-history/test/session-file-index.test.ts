// Guards 11-05: each lookup of a session file the daemon no longer lists walked session-artifacts with readdir on the chat's main thread, 62,472
// folders on us-metal02, 9.8 s and 3.2 s of CPU a walk. After the 03:47:19Z start the outbox's retries ran such walks for 13.8 s of the
// first minute's main thread, and an older-messages read in that minute took 1.4 s (d7 clean_min_30).
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fsp from "node:fs/promises";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * Counts the folders this process reads, the finds it starts itself, and the finds that run anywhere while `run` runs, through a `find` on
 * PATH that logs each run and the bytes it prints.
 */
async function counted<T>(t: TestContext, run: () => Promise<T>): Promise<{ result: T; folders: number; ownFinds: number; finds: number; bytes: number }> {
  const bin = mkdtempSync(join(tmpdir(), "session-file-find-"));
  const log = join(bin, "runs.log");
  const out = join(bin, "out.log");
  writeFileSync(log, ""); writeFileSync(out, "");
  writeFileSync(join(bin, "find"), `#!/bin/sh\necho run >> '${log}'\n/usr/bin/find "$@" | tee -a '${out}'\n`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  const readdir = t.mock.method(fsp, "readdir");
  const spawn = t.mock.method(childProcess, "spawn");
  syncBuiltinESMExports();
  try {
    const result = await run();
    return { result, folders: readdir.mock.callCount(), ownFinds: spawn.mock.calls.filter(call => call.arguments[0] === "find").length,
      finds: readFileSync(log, "utf8").split("\n").filter(Boolean).length, bytes: readFileSync(out).length };
  } finally {
    readdir.mock.restore(); spawn.mock.restore();
    syncBuiltinESMExports();
    process.env.PATH = path;
    rmSync(bin, { recursive: true, force: true });
  }
}

test("20 lookups of a session no folder holds read no folder on the chat's thread and share one search", async t => {
  const dir = agentDir(t);
  const { result, folders, finds } = await counted(t, () => Promise.all(Array.from({ length: 20 }, () => sessionFileOf(MISSING, dir))));
  assert.deepEqual(new Set(result), new Set([null]));
  assert.equal(folders, 0, "the readdir walk read every folder once per lookup");
  assert.equal(finds, 1, "one search answered all 20");
});

test("an ended subagent's file is found by the search, and a later lookup of it reads nothing new", async t => {
  const dir = agentDir(t);
  const file = join(dir, "session-artifacts", "root-77", "sub-a", "sub-b", `${CHILD}.jsonl`);
  assert.equal(await sessionFileOf(CHILD, dir), file);
  const again = await counted(t, async () => [await sessionFileOf(CHILD, dir), await sessionFileOf("child-5", dir)]);
  assert.deepEqual(again.result, [file, join(dir, "session-artifacts", "root-5", "sub-a", "child-5.jsonl")]);
  assert.equal(again.folders, 0);
  assert.equal(again.finds, 1, "the first name was known, the second took one search");
});

// 11-08 us-metal02: the listing printed all 66,659 transcripts, 8.4 MB, and the chat split them on its main thread at each miss, 0.2 to 0.65 s
// with garbage collection four times a minute while the outbox retried a send to a root with no file. At 12:02:40Z the chat's own spawn of
// that find held its main thread 1.22 s with the box at 6 runnable a core, and d7 read 12:03Z dirty from the stall.
test("a lookup that misses reads only the asked name's line, from a find the chat's own process does not start", async t => {
  const dir = agentDir(t);
  const made = join(dir, "session-artifacts", "root-3", "sub-a", `${MISSING}.jsonl`);
  writeFileSync(made, "{}\n");
  const { result, ownFinds, finds, bytes } = await counted(t, async () => [await sessionFileOf(MISSING, dir), await sessionFileOf(CHILD.replace("c41d", "dead"), dir)]);
  assert.deepEqual(result, [made, null]);
  assert.equal(finds, 2);
  assert.equal(ownFinds, 0, "the chat forked find from its own process");
  assert.ok(bytes <= made.length + 1, `the search printed ${bytes} bytes of paths for two lookups in a tree of ${ROOTS + 1} transcripts`);
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
