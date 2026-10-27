import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SavedIndex } from "../src/saved-index.ts";

const header = (id: string) => JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-27T08:00:00.000Z", cwd: "/w" }) + "\n";
const user = (text: string) => JSON.stringify({ type: "message", id: "m", parentId: null, timestamp: "2026-10-27T08:00:01.000Z", message: { role: "user", content: [{ type: "text", text }], timestamp: 1 } }) + "\n";

test("the saved index lists Prime's flat files and Pi's cwd folders, rereads only changed files, and keeps its rows across a restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-host-index-"));
  try {
    const dir = join(root, "sessions");
    mkdirSync(join(dir, "--w--"), { recursive: true });
    writeFileSync(join(dir, "a.jsonl"), header("a") + user("prime file") + JSON.stringify({ type: "session_info", id: "i", parentId: null, timestamp: "x", name: "named" }) + "\n");
    writeFileSync(join(dir, "--w--", "2026_b.jsonl"), header("b") + user("pi file"));
    writeFileSync(join(dir, "not-a-session.jsonl"), "{}\n");
    const file = join(root, "index.json");
    const index = new SavedIndex([dir], file, 0);
    const rows = await index.rows(true);
    assert.deepEqual(rows.map(row => row.sessionId).sort(), ["a", "b"]);
    const a = rows.find(row => row.sessionId === "a")!;
    assert.equal(a.sessionName, "named");
    assert.equal(a.firstMessage, "prime file");
    assert.equal(a.messageCount, 1);
    appendFileSync(join(dir, "--w--", "2026_b.jsonl"), user("second"));
    const again = await index.rows(true);
    assert.equal(again.find(row => row.sessionId === "b")!.messageCount, 2);
    const reopened = new SavedIndex([join(root, "gone")], file, 60_000);
    assert.equal((await reopened.rows()).length, 0, "a scan of a dir with no files drops the rows the file held");
    const kept = new SavedIndex([dir], file, 60_000);
    assert.deepEqual((await kept.rows()).map(row => row.sessionId).sort(), ["a", "b"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
