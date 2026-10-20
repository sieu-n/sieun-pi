// Guards the 10-19 fd leak: readline's close leaves its input stream open, so each session file read only to its head stayed open, and the box
// chat service held 564 session files (137 Mac copies, 376 MB, and 427 local files) for good.
import assert from "node:assert/strict";
import { mkdtemp, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileHasChatMarker, topSession } from "../src/chat-guard.ts";
import { sessionBrief } from "../src/job-resume.ts";

async function openCount(file: string): Promise<number> {
  const fds = await readdir("/proc/self/fd");
  const targets = await Promise.all(fds.map(fd => readlink(`/proc/self/fd/${fd}`).catch(() => "")));
  return targets.filter(target => target === file).length;
}

test("a session file read only to its head is closed after the read", { skip: process.platform !== "linux" && "reads /proc/self/fd" }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "file-lines-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "01a151b3-8253-779f-a8b9-9a38ce3cec40.jsonl");
  const filler = Array.from({ length: 4000 }, (_, at) => JSON.stringify({ type: "message", id: `m${at}`, message: { role: "assistant", content: "x".repeat(200) } }));
  await writeFile(file, [JSON.stringify({ type: "session", id: "01a151b3-8253-779f-a8b9-9a38ce3cec40", cwd: dir }),
    JSON.stringify({ type: "message", id: "u1", message: { role: "user", content: "[task from parent] the brief" } }), ...filler].join("\n") + "\n");
  assert.equal(await fileHasChatMarker(file), false);
  assert.equal(await sessionBrief(file), "the brief");
  assert.deepEqual(await topSession(file), { id: "01a151b3-8253-779f-a8b9-9a38ce3cec40", name: "", chat: false, at: 0 });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(await openCount(file), 0);
});
