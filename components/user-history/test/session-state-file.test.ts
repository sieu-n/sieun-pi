// Guards the 10-19 steady block: the idle unload's sweep opened each session it stopped with SessionManager.open to write its state back,
// which parses the whole transcript on the main thread (a 73 MB chat took 0.48 s, and one sweep opened up to 60 MB).
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CURRENT_SESSION_VERSION, SessionManager } from "prime-agent";
import { setFileSessionState } from "../src/session-state-file.ts";

const SESSION = "01a151ae-bc07-777e-aac0-b376c853f7e1";
function transcript(dir: string, messages: number): string {
  const lines = [JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: SESSION, timestamp: "2026-10-19T01:00:00.000Z", cwd: dir })];
  let parent: string | null = null;
  for (let at = 0; at < messages; at++) {
    const id = `m${at}`;
    lines.push(JSON.stringify({ type: "message", id, parentId: parent, timestamp: "2026-10-19T01:00:01.000Z",
      message: { role: at % 2 ? "assistant" : "user", content: [{ type: "text", text: `${at} ${"x".repeat(2000)}` }], timestamp: 1 } }));
    parent = id;
  }
  lines.push(JSON.stringify({ type: "session_state", id: "s1", parentId: parent, timestamp: "2026-10-19T01:00:02.000Z", state: { status: "archived" } }));
  return lines.join("\n") + "\n";
}

test("a session's state is read and written from the file's ends, as a full open reads it", async t => {
  const dir = await mkdtemp(join(tmpdir(), "session-state-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, `${SESSION}.jsonl`);
  await writeFile(file, transcript(dir, 600));
  const opens = t.mock.method(SessionManager, "open");

  setFileSessionState(file, "active");
  setFileSessionState(file, "active");
  assert.equal(opens.mock.callCount(), 0, "no full open of a current-version file");
  opens.mock.restore();
  const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
  assert.equal(lines.length, 603, "the second call finds the state already active and writes nothing");
  const manager = SessionManager.open(file);
  assert.equal(manager.getSessionState()?.status, "active");
  assert.equal(manager.getBranch().length, 602, "the new entry hangs on the transcript's last entry");

  setFileSessionState(file, "archived");
  assert.equal(SessionManager.open(file).getSessionState()?.status, "archived");
  setFileSessionState(file, "archived");
  assert.equal((await readFile(file, "utf8")).trimEnd().split("\n").length, 604);
});

test("a file with a cut last line takes the full open, which repairs it", async t => {
  const dir = await mkdtemp(join(tmpdir(), "session-state-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, `${SESSION}.jsonl`);
  await writeFile(file, transcript(dir, 4) + '{"type":"message","id":"cut"');
  const opens = t.mock.method(SessionManager, "open");
  setFileSessionState(file, "active");
  assert.equal(opens.mock.callCount(), 1);
  opens.mock.restore();
  assert.equal(SessionManager.open(file).getSessionState()?.status, "active");
});
