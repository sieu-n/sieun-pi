/**
 * scripts/chat-backup.mjs: a backup of a live data dir, a second run, the restore check, the prune and the B2 file encryption.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/chat-backup.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
// @ts-expect-error The script is plain ESM with no types.
import { checkBackups, completeBackups, decryptFile, encryptTo, restoreBackup, runBackup } from "../../scripts/chat-backup.mjs";

const quiet = () => undefined;
const at = (minute: number) => new Date(Date.UTC(2026, 10, 23, 19, 30 + minute));

function dataDir(root: string) {
  const dir = join(root, "data");
  mkdirSync(join(dir, "images"), { recursive: true });
  for (const skip of ["requests", "cache", "renditions", "search"]) mkdirSync(join(dir, skip));
  writeFileSync(join(dir, "rooms.json"), JSON.stringify({ rooms: [1, 2, 3] }));
  writeFileSync(join(dir, "images", "a.png"), Buffer.alloc(4096, 7));
  writeFileSync(join(dir, "requests", "2026-11-23.jsonl"), "{}\n");
  writeFileSync(join(dir, "cache", "threads.json"), "{}");
  writeFileSync(join(dir, "state.json.tmp"), "half");
  writeFileSync(join(dir, "server.lock.pid"), "1");
  const db = new DatabaseSync(join(dir, "chat.sqlite"));
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE posts (id INTEGER PRIMARY KEY, text TEXT); CREATE TABLE rooms (id TEXT PRIMARY KEY);");
  const insert = db.prepare("INSERT INTO posts (text) VALUES (?)");
  for (let i = 0; i < 500; i++) insert.run(`post ${i}`);
  db.exec("INSERT INTO rooms VALUES ('r1'), ('r2')");
  return { dir, db };
}

test("a run copies the live DB with its WAL rows, leaves out caches, and a second run in the same minute changes nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "chat-backup-"));
  const { dir, db } = dataDir(root);
  try {
    const to = join(root, "backups");
    assert.ok(existsSync(join(dir, "chat.sqlite-wal")));
    const first = await runBackup({ dataDir: dir, to, now: at(0), log: quiet });
    const done = join(to, first.stamp);
    assert.deepEqual(readdirSync(done).sort(), ["chat.sqlite", "images", "manifest.json", "rooms.json"]);
    assert.deepEqual(first.manifest.sqlite["chat.sqlite"].tables, { posts: 500, rooms: 2 });
    assert.equal(first.manifest.files, 3);
    assert.ok(!existsSync(join(done, "chat.sqlite-wal")));

    const again = await runBackup({ dataDir: dir, to, now: at(0), log: quiet });
    assert.equal(again.skipped, true);
    assert.deepEqual(completeBackups(to), [first.stamp]);

    db.exec("INSERT INTO posts (text) VALUES ('later')");
    const next = await runBackup({ dataDir: dir, to, now: at(1), log: quiet });
    assert.equal(next.manifest.sqlite["chat.sqlite"].tables.posts, 501);
    assert.equal(next.manifest.linked, 2);
    assert.equal(statSync(join(to, next.stamp, "images", "a.png")).ino, statSync(join(done, "images", "a.png")).ino);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("restore rebuilds a data dir that matches the manifest and refuses a folder that is not empty", async () => {
  const root = mkdtempSync(join(tmpdir(), "chat-backup-"));
  const { dir, db } = dataDir(root);
  try {
    const to = join(root, "backups");
    const { stamp } = await runBackup({ dataDir: dir, to, now: at(0), log: quiet });
    const target = join(root, "restored");
    const lines: string[] = [];
    const result = await restoreBackup(join(to, stamp), target, (line: string) => lines.push(line));
    assert.equal(result.files, 3);
    assert.match(lines.join("\n"), /integrity_check ok, sha256 matches, 2 tables, 502 rows/);
    assert.equal(readFileSync(join(target, "rooms.json"), "utf8"), readFileSync(join(dir, "rooms.json"), "utf8"));
    writeFileSync(join(target, "outbox.jsonl"), "a restored file is writable\n", { flag: "a" });
    writeFileSync(join(target, "rooms.json"), "{}", { flag: "a" });
    await assert.rejects(restoreBackup(join(to, stamp), target, quiet), /not empty/);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("old backups past the keep count go, a half-written one is never counted, and check reads the newest one's age", async () => {
  const root = mkdtempSync(join(tmpdir(), "chat-backup-"));
  const { dir, db } = dataDir(root);
  try {
    const to = join(root, "backups");
    mkdirSync(join(to, "20261101T0000Z"), { recursive: true });
    mkdirSync(join(to, "20261102T0000Z.partial"));
    for (let m = 0; m < 4; m++) await runBackup({ dataDir: dir, to, now: at(m), keep: 2, log: quiet });
    assert.deepEqual(completeBackups(to), ["20261123T1932Z", "20261123T1933Z"]);
    assert.ok(!existsSync(join(to, "20261102T0000Z.partial")));
    assert.ok(existsSync(join(to, "20261101T0000Z")), "a folder with no manifest is not a backup, so the prune leaves it");
    assert.equal(checkBackups(to, at(4).getTime()).ok, true);
    assert.equal(checkBackups(to, at(3).getTime() + 27 * 3_600_000).ok, false);
    assert.equal(checkBackups(join(root, "none")).ok, false);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a B2 file decrypts back to the bytes it was made from, and a changed byte fails the check", async () => {
  const root = mkdtempSync(join(tmpdir(), "chat-backup-"));
  try {
    const key = Buffer.alloc(32, 3);
    const plain = join(root, "plain");
    writeFileSync(plain, Buffer.from(Array.from({ length: 100_000 }, (_, i) => i % 251)));
    await encryptTo(createReadStream(plain), join(root, "x.enc"), key);
    await decryptFile(join(root, "x.enc"), join(root, "back"), key);
    assert.deepEqual(readFileSync(join(root, "back")), readFileSync(plain));
    const bytes = readFileSync(join(root, "x.enc"));
    bytes.writeUInt8(bytes.readUInt8(100) ^ 1, 100);
    writeFileSync(join(root, "bad.enc"), bytes);
    await assert.rejects(decryptFile(join(root, "bad.enc"), join(root, "bad"), key));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the script runs its command when started through a symlink, as the nightly unit starts the release's copy", () => {
  const root = mkdtempSync(join(tmpdir(), "chat-backup-"));
  try {
    const script = fileURLToPath(new URL("../../scripts/chat-backup.mjs", import.meta.url));
    symlinkSync(dirname(script), join(root, "current"));
    const r = spawnSync(process.execPath, [join(root, "current", "chat-backup.mjs"), "check", "--to", join(root, "none")], { encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /No complete backup/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
