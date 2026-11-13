// Guards 11-13: a herd of full daemon lists (11,228 saved sessions, 97 MB, about 13 CPU-s each on the supervisor's one thread) held every
// other daemon call up to 657 s. The idle-unload judge asks only whether each session of its chat is still resident, so it reads the live
// list, and it names a stopped job from the rlm-subagent.json beside its transcript.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { jobName, residentRows } from "../scripts/clean-room/idle-unload.ts";

test("the idle-unload judge reads the live list and names a stopped job from its rlm-subagent.json", async () => {
  const asked: unknown[] = [];
  const rows = await residentRows(async options => { asked.push(options); return { sessions: [{ sessionId: "s1", activeSessionId: "a1" }] }; });
  assert.deepEqual(rows, [{ sessionId: "s1", activeSessionId: "a1" }]);
  assert.deepEqual(asked, [{}]);
  const dir = await mkdtemp(join(tmpdir(), "idle-unload-judge-"));
  try {
    await writeFile(join(dir, "rlm-subagent.json"), JSON.stringify({ sessionName: "count skills" }));
    assert.equal(jobName(join(dir, "01a1.jsonl")), "count skills");
    assert.equal(jobName(join(dir, "missing", "01a2.jsonl")), "");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
