// Guards the 10-18 owner ask: the chat service compacts a chat file over 100 MB itself after the chat's Prime compaction, off its main thread.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runSessionCompact, SessionAutoCompact } from "../src/session-autocompact.ts";

const at = (n: number) => new Date(Date.UTC(2026, 9, 10, 0, 0, n)).toISOString();

function session(): string {
  const root = mkdtempSync(join(tmpdir(), "session-autocompact-"));
  mkdirSync(join(root, "sessions"));
  const file = join(root, "sessions", "01a00000-0000-7000-8000-000000000002.jsonl");
  const lines: object[] = [
    { type: "session", version: 3, id: "01a00000-0000-7000-8000-000000000002", timestamp: at(0), cwd: "/tmp" },
    { type: "message", id: "a1", parentId: null, timestamp: at(1), message: { role: "user", content: [{ type: "text", text: "look" }], timestamp: 1 } },
    { type: "message", id: "a2", parentId: "a1", timestamp: at(2), message: { role: "toolResult", toolCallId: "t1", toolName: "chat_board", content: [{ type: "text", text: "x".repeat(50_000) }], isError: false, timestamp: 2 } },
    { type: "message", id: "a3", parentId: "a2", timestamp: at(3), message: { role: "user", content: [{ type: "text", text: "next" }], timestamp: 3 } },
    { type: "compaction", id: "a4", parentId: "a3", timestamp: at(4), summary: "s", firstKeptEntryId: "a3", tokensBefore: 10 },
  ];
  writeFileSync(file, lines.map(line => JSON.stringify(line)).join("\n") + "\n");
  return file;
}

test("a compacted chat over the size runs session-compact in a child process and logs the file, both sizes and the backup", async () => {
  const file = session();
  const before = readFileSync(file).length;
  const backupDir = join(file, "..", "..", "backups");
  const logged: string[] = [];
  const auto = new SessionAutoCompact({ socketPath: "none", log: line => logged.push(line), minBytes: 10_000,
    run: (path, socket) => runSessionCompact(path, socket, backupDir) });
  const line = await auto.compacted("01a00000-0000-7000-8000-000000000002", file);
  assert.ok(line);
  assert.deepEqual(logged, [line]);
  assert.match(line, new RegExp(`${file.replaceAll("/", "\\/")} \\(0\\.1 MB\\): .*MB -> .*MB.*backup ${backupDir.replaceAll("/", "\\/")}`));
  assert.ok(readFileSync(file).length < before / 10);
  assert.deepEqual(readdirSync(backupDir).sort(), ["01a00000-0000-7000-8000-000000000002.jsonl", "01a00000-0000-7000-8000-000000000002.jsonl.manifest.json"]);
  assert.equal(await auto.compacted("01a00000-0000-7000-8000-000000000002", file), null, "the file is under the size now");
});

test("a file under the size, no file, or a run already going on the file runs nothing", async () => {
  const file = session();
  const runs: string[] = [];
  let finish!: (said: string) => void;
  const auto = new SessionAutoCompact({ socketPath: "none", log: () => {}, minBytes: 10_000, run: async path => { runs.push(path); return new Promise(resolve => { finish = resolve; }); } });
  assert.equal(await new SessionAutoCompact({ socketPath: "none", log: () => {}, run: async () => "ran" }).compacted("x", file), null);
  assert.equal(await auto.compacted("x", undefined), null);
  const first = auto.compacted("x", file);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(await auto.compacted("x", file), null);
  finish("done");
  assert.match((await first)!, /done$/);
  assert.equal(runs.length, 1);
});
