import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { apply, planCompaction } from "../scripts/session-compact.ts";
import { ImageStore, Projector } from "../src/chat-projection.ts";
import { imageKey, movedImages } from "../src/moved-images.ts";
import { historyMessages } from "../src/session-tail.ts";

const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(6000, 7)]).toString("base64");
const at = (n: number) => new Date(Date.UTC(2026, 9, 10, 0, 0, n)).toISOString();

function session(): string {
  const root = mkdtempSync(join(tmpdir(), "session-compact-"));
  mkdirSync(join(root, "sessions"));
  const file = join(root, "sessions", "01a00000-0000-7000-8000-000000000001.jsonl");
  const lines: object[] = [
    { type: "session", version: 3, id: "01a00000-0000-7000-8000-000000000001", timestamp: at(0), cwd: "/tmp" },
    { type: "message", id: "a1", parentId: null, timestamp: at(1), message: { role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: PNG, mimeType: "image/png" }], timestamp: 1 } },
    { type: "message", id: "a2", parentId: "a1", timestamp: at(2), message: { role: "toolResult", toolCallId: "t1", toolName: "chat_board", content: [{ type: "text", text: "The chat set its check-in: hourly\n" + "x".repeat(5000) }], isError: false, timestamp: 2 } },
    { type: "custom_message", id: "a3", parentId: "a2", timestamp: at(3), customType: "harness_digest", content: "[harness-digest]\n" + "d".repeat(3000), display: false, details: { digest: "d".repeat(3000), stateFingerprint: "f1" } },
    { type: "message", id: "a4", parentId: "a3", timestamp: at(4), message: { role: "toolResult", toolCallId: "t2", toolName: "chat_board", content: [{ type: "text", text: "y".repeat(5000) }], isError: false, timestamp: 4 } },
    { type: "compaction", id: "a5", parentId: "a4", timestamp: at(5), summary: "s", firstKeptEntryId: "a4", tokensBefore: 10 },
  ];
  writeFileSync(file, lines.map(line => JSON.stringify(line)).join("\n") + "\n");
  return file;
}

const feed = (bytes: Buffer) => JSON.stringify(new Projector(new ImageStore(1)).messages(historyMessages(bytes.toString("utf8").trim().split("\n").slice(1).map(line => JSON.parse(line)))));

test("only entries before the last compaction's kept entry shrink, and the feed projects the same", async () => {
  const file = session();
  const before = readFileSync(file);
  const plan = planCompaction(file, before);
  assert.equal(plan.cut, 4);
  assert.deepEqual([...plan.changed.keys()], [1, 2, 3]);
  const backupDir = join(file, "..", "..", "backups");
  const said = await apply(file, { backupDir, socket: "none", waitMs: 0 });
  assert.match(said, /backup/);
  const after = readFileSync(file);
  assert.ok(after.length < before.length / 3);
  assert.equal(feed(after), feed(before));
  assert.deepEqual(readFileSync(join(backupDir, "01a00000-0000-7000-8000-000000000001.jsonl")), before);
  const entries = after.toString("utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(entries[4].message.content[0].text, "y".repeat(5000));
  assert.equal(entries[3].details.stateFingerprint, "f1");
  const [image] = movedImages(entries, file);
  assert.equal(image!.key, imageKey("image/png", PNG));
  assert.equal(readFileSync(image!.path).toString("base64"), PNG);
  assert.match(await apply(file, { backupDir, socket: "none", waitMs: 0 }), /nothing to remove/);
  assert.equal(readdirSync(backupDir).length, 2);
});
