// When the Mac came back at 00:54:51Z on 11-03, the duty reruns of its chats looked up Mac sessions with sessionFileOf, which walked all 8,147
// roots under session-artifacts for files that live on the Mac: 6.7 s of the chat's main thread, and d7 read 00:55 to 00:57Z dirty.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { boxSessionFile } from "../src/send-once.ts";

const ID = "01a11ba8-9d2c-727c-8ded-38f819ca9f29";

test("another box's session resolves to this box's copy without walking session-artifacts", async t => {
  const agentDir = mkdtempSync(join(tmpdir(), "box-session-file-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  mkdirSync(join(agentDir, "session-artifacts", "root", "sub-a"), { recursive: true });
  writeFileSync(join(agentDir, "session-artifacts", "root", "sub-a", `${ID}.jsonl`), "{}\n");
  const listed: string[] = [];
  const input = { agentDir, elsewhere: () => true, copy: async () => "/copies/mac/a.jsonl", listed: async (id: string) => { listed.push(id); return undefined; } };
  assert.equal(await boxSessionFile(ID, input), "/copies/mac/a.jsonl");
  assert.equal(await boxSessionFile(ID, { ...input, copy: async () => undefined }), null, "a session of another box with no copy here has no file here");
  assert.deepEqual(listed, []);
});

test("this box's session takes the listed file, and walks only when the daemon lists none", async t => {
  const agentDir = mkdtempSync(join(tmpdir(), "box-session-file-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  const listedFile = join(agentDir, "listed.jsonl");
  writeFileSync(listedFile, "{}\n");
  const walked = join(agentDir, "session-artifacts", "root", "sub-a", `${ID}.jsonl`);
  mkdirSync(join(agentDir, "session-artifacts", "root", "sub-a"), { recursive: true });
  writeFileSync(walked, "{}\n");
  const base = { agentDir, elsewhere: () => false, copy: async () => "/never" };
  assert.equal(await boxSessionFile(ID, { ...base, listed: async () => listedFile }), listedFile);
  assert.equal(await boxSessionFile(ID, { ...base, listed: async () => join(agentDir, "gone.jsonl") }), walked);
  assert.equal(await boxSessionFile(ID, { ...base, listed: async () => undefined }), walked);
});
