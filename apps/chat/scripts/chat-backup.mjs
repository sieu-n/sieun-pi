#!/usr/bin/env node
/**
 * Nightly backups of apps/chat's data dir (~/.pi/agent/chat) to /drive2, with a restore that checks what it rebuilt.
 *
 *   node scripts/chat-backup.mjs run [--data-dir D] [--to DIR] [--b2]
 *   node scripts/chat-backup.mjs restore <backup dir> --to <empty dir>
 *   node scripts/chat-backup.mjs check [--to DIR]
 *   node scripts/chat-backup.mjs install
 *   node scripts/chat-backup.mjs fetch-b2 [<stamp>] --to <dir>
 *
 * `run` writes <to>/<UTC minute stamp>/. Each SQLite file goes through node:sqlite's online backup, so a live server's WAL is read
 * consistently. Every other file is copied, or hard-linked to the previous backup when its size and mtime are unchanged, so a night costs
 * only what changed. The backup is built in a .partial folder, manifest.json is written last and the folder is renamed only then, so a
 * crash leaves no folder that `check`, `restore` or the prune would count. The newest KEEP backups stay.
 *
 * With --b2 it also uploads the newest backup to Backblaze B2 under sw-factory-chat-backups/<stamp>/, encrypted with AES-256-GCM, because
 * the one bucket the box's key can write (influencer-prod) is public. The key id, app key and bucket are in ~/.config/sieun-pi/chat-backup.env
 * (B2_KEY_ID=, B2_APP_KEY=, B2_BUCKET=), and the encryption key is ~/.config/sieun-pi/chat-backup.key, which `install` makes once and copies
 * to the Mac (ssh mac) so a B2 backup outlives the box.
 *
 * `install` writes the systemd user units from deploy/linux/sieun-pi-chat-backup.{service,timer}, rewrites a unit only when its text differs
 * and enables the timer; a second install changes nothing.
 */
import { spawn, spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  chmodSync, closeSync, copyFileSync, createReadStream, createWriteStream, existsSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync,
  readFileSync, readlinkSync, readSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const HOME = homedir();
export const DEFAULTS = {
  dataDir: join(HOME, ".pi/agent/chat"),
  // /drive2 belongs to root and the box has no sudo for sieun, so the backups live in sieun's folder on that disk.
  to: "/drive2/sieun/backups/sw-factory-chat",
  envFile: join(HOME, ".config/sieun-pi/chat-backup.env"),
  keyFile: join(HOME, ".config/sieun-pi/chat-backup.key"),
};
/** Backups kept, here and in B2: 30 nights, as the parent's brief for this job asked (#sw-factory-build, 11-23). */
export const KEEP = 30;
/** `check` fails when the newest backup is older than this: one nightly run plus two hours of slack. */
export const MAX_AGE_H = 26;
const B2_PREFIX = "sw-factory-chat-backups/";
const STAMP = /^\d{8}T\d{4}Z$/;
const SQLITE = /\.(sqlite3?|db)$/;

/** Paths left out, relative to the data dir: request timing logs, rebuilt caches and search state, temp files and live-DB side files. */
export function skipped(rel) {
  const top = rel.split("/")[0];
  if (["requests", "cache", "renditions", "search"].includes(top)) return true;
  const name = rel.split("/").pop();
  return name.endsWith(".tmp") || /-(wal|shm|journal)$/.test(name) || name.startsWith("server.lock");
}

export const stampOf = (date = new Date()) => date.toISOString().replace(/[-:]/g, "").slice(0, 13) + "Z";
const timeOfStamp = stamp => Date.parse(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:00Z`);

/** Complete backups in `to`, oldest first: stamp folders that hold a manifest. */
export function completeBackups(to) {
  if (!existsSync(to)) return [];
  return readdirSync(to).filter(name => STAMP.test(name) && existsSync(join(to, name, "manifest.json"))).sort();
}

function walk(root, rel = "", out = []) {
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (skipped(path)) continue;
    if (entry.isDirectory()) walk(root, path, out);
    else if (entry.isFile() || entry.isSymbolicLink()) out.push(path);
  }
  return out;
}

async function hashFile(file, algorithm = "sha256") {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function tableCounts(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    return Object.fromEntries(tables.map(({ name }) => [name, Number(db.prepare(`SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`).get().n)]));
  } finally {
    db.close();
  }
}

/** Copies a live SQLite file with the online backup API, then makes the copy one self-contained file with no WAL. */
async function backupSqlite(source, target) {
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    // One step for the whole file: a step that yields lets the server's next commit restart the copy from page one.
    await backup(db, target, { rate: 2 ** 31 - 1 });
  } finally {
    db.close();
  }
  const copy = new DatabaseSync(target);
  copy.exec("PRAGMA journal_mode = DELETE");
  copy.close();
}

/** Takes <to>/.run.lock for this pid, taking it over when the pid that holds it is gone. Returns the release function, or null. */
function takeLock(to) {
  const file = join(to, ".run.lock");
  for (;;) {
    try {
      writeFileSync(file, String(process.pid), { flag: "wx" });
      return () => rmSync(file, { force: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const pid = Number(readFileSync(file, "utf8"));
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (e) {
        alive = e.code === "EPERM";
      }
      if (alive && pid !== process.pid) return null;
      rmSync(file, { force: true });
    }
  }
}

/** Makes one backup of `dataDir` in `to` and prunes old ones. A backup for this minute that is already complete is kept as it is. */
export async function runBackup({ dataDir = DEFAULTS.dataDir, to = DEFAULTS.to, now = new Date(), keep = KEEP, log = console.log } = {}) {
  mkdirSync(to, { recursive: true, mode: 0o700 });
  const release = takeLock(to);
  if (!release) {
    log(`Another run holds ${join(to, ".run.lock")}; nothing done.`);
    return { stamp: null, skipped: true };
  }
  try {
    for (const name of readdirSync(to)) if (name.endsWith(".partial")) rmSync(join(to, name), { recursive: true, force: true });
    const stamp = stampOf(now);
    const done = join(to, stamp);
    if (existsSync(join(done, "manifest.json"))) {
      log(`Backup ${done} is complete already; nothing done.`);
      return { stamp, skipped: true, pruned: prune(to, keep, log) };
    }
    if (existsSync(done)) rmSync(done, { recursive: true, force: true });
    const previous = completeBackups(to).at(-1);
    const prev = previous ? join(to, previous) : null;
    const work = join(to, `${stamp}.partial`);
    mkdirSync(work);

    let files = 0, bytes = 0, copiedBytes = 0, linked = 0, newest = 0;
    const sqlite = {};
    for (const rel of walk(dataDir)) {
      const source = join(dataDir, rel);
      const target = join(work, rel);
      mkdirSync(dirname(target), { recursive: true });
      const st = lstatSync(source);
      if (st.isSymbolicLink()) {
        symlinkSync(readlinkSync(source), target);
        files += 1;
        continue;
      }
      if (SQLITE.test(rel)) {
        await backupSqlite(source, target);
        const size = statSync(target).size;
        sqlite[rel] = { sha256: await hashFile(target), bytes: size, tables: tableCounts(target) };
        chmodSync(target, 0o444);
        files += 1, bytes += size, copiedBytes += size, newest = Math.max(newest, st.mtimeMs);
        continue;
      }
      const old = prev ? join(prev, rel) : null;
      const oldSt = old && existsSync(old) ? lstatSync(old) : null;
      // utimes takes seconds as a double, so a copy's mtime can land a fraction of a millisecond below the source's.
      if (oldSt?.isFile() && oldSt.size === st.size && Math.abs(oldSt.mtimeMs - st.mtimeMs) < 1) {
        linkSync(old, target);
        linked += 1;
      } else {
        copyFileSync(source, target);
        utimesSync(target, st.atime, st.mtime);
        chmodSync(target, 0o444);
        copiedBytes += st.size;
      }
      files += 1, bytes += st.size, newest = Math.max(newest, st.mtimeMs);
    }
    const manifest = {
      stamp, dataDir, createdAt: new Date().toISOString(), files, bytes, copiedBytes, linked, linkedFrom: previous ?? null,
      newestMtime: newest ? new Date(newest).toISOString() : null, sqlite,
    };
    writeFileSync(join(work, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    renameSync(work, done);
    log(`Backup ${done}: ${files} files, ${mb(bytes)}, ${mb(copiedBytes)} copied, ${linked} hard-linked to ${previous ?? "nothing"}.`);
    return { stamp, skipped: false, manifest, pruned: prune(to, keep, log) };
  } finally {
    release();
  }
}

/** Removes complete backups beyond the newest `keep`. */
export function prune(to, keep = KEEP, log = console.log) {
  const all = completeBackups(to);
  const gone = all.slice(0, Math.max(0, all.length - keep));
  for (const stamp of gone) rmSync(join(to, stamp), { recursive: true, force: true });
  if (gone.length) log(`Removed ${gone.length} old backups: ${gone.join(", ")}.`);
  return gone;
}

const mb = n => `${(n / 1e6).toFixed(1)} MB`;

/** Rebuilds a data dir from `from` into the empty or missing folder `to`, and checks it against the manifest. Throws on a mismatch. */
export async function restoreBackup(from, to, log = console.log) {
  const manifest = JSON.parse(readFileSync(join(from, "manifest.json"), "utf8"));
  if (existsSync(to) && readdirSync(to).length) throw new Error(`${to} is not empty.`);
  mkdirSync(to, { recursive: true });
  let files = 0, bytes = 0;
  for (const rel of walk(from)) {
    if (rel === "manifest.json") continue;
    const source = join(from, rel);
    const target = join(to, rel);
    mkdirSync(dirname(target), { recursive: true });
    const st = lstatSync(source);
    if (st.isSymbolicLink()) symlinkSync(readlinkSync(source), target);
    else {
      copyFileSync(source, target);
      chmodSync(target, 0o644);
      utimesSync(target, st.atime, st.mtime);
      bytes += st.size;
    }
    files += 1;
  }
  const problems = [];
  if (files !== manifest.files) problems.push(`${files} files, the manifest says ${manifest.files}`);
  if (bytes !== manifest.bytes) problems.push(`${bytes} bytes, the manifest says ${manifest.bytes}`);
  log(`Restored ${files} files, ${mb(bytes)}, from ${from} into ${to}.`);
  for (const [rel, want] of Object.entries(manifest.sqlite)) {
    const file = join(to, rel);
    const db = new DatabaseSync(file, { readOnly: true });
    const integrity = db.prepare("PRAGMA integrity_check").all().map(row => Object.values(row)[0]).join("; ");
    db.close();
    const sha = await hashFile(file);
    const tables = tableCounts(file);
    const rows = Object.values(tables).reduce((a, b) => a + b, 0);
    log(`${rel}: integrity_check ${integrity}, sha256 ${sha === want.sha256 ? "matches" : "differs"}, ${Object.keys(tables).length} tables, ${rows} rows.`);
    if (integrity !== "ok") problems.push(`${rel} integrity_check: ${integrity}`);
    if (sha !== want.sha256) problems.push(`${rel} sha256 differs from the manifest`);
    for (const [table, n] of Object.entries(want.tables)) if (tables[table] !== n) problems.push(`${rel} ${table}: ${tables[table]} rows, the manifest says ${n}`);
  }
  if (problems.length) throw new Error(`Restore check failed: ${problems.join("; ")}.`);
  log(`Matches the manifest: ${manifest.files} files, ${manifest.bytes} bytes, every table's row count.`);
  return { files, bytes, manifest };
}

/** The newest complete backup and its age. `ok` is false when there is none or it is older than MAX_AGE_H. */
export function checkBackups(to = DEFAULTS.to, now = Date.now()) {
  const newest = completeBackups(to).at(-1);
  if (!newest) return { ok: false, line: `No complete backup in ${to}.` };
  const manifest = JSON.parse(readFileSync(join(to, newest, "manifest.json"), "utf8"));
  const ageH = (now - timeOfStamp(newest)) / 3_600_000;
  const ok = ageH <= MAX_AGE_H;
  const line = `Newest backup ${join(to, newest)}, ${ageH.toFixed(1)} h old, ${manifest.files} files, ${mb(manifest.bytes)} (${mb(manifest.copiedBytes)} new on disk)` +
    `, ${completeBackups(to).length} kept.${ok ? "" : ` Older than ${MAX_AGE_H} h.`}`;
  return { ok, line, newest, ageH, manifest };
}

// ---- B2 ----

function readEnv(file) {
  if (!existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, "utf8").split("\n").map(line => line.trim()).filter(line => line && !line.startsWith("#") && line.includes("="))
    .map(line => [line.slice(0, line.indexOf("=")).trim(), line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]));
}

function readKey(file) {
  const key = Buffer.from(readFileSync(file, "utf8").trim(), "base64");
  if (key.length !== 32) throw new Error(`${file} does not hold a 32-byte base64 key.`);
  return key;
}

const MAGIC = Buffer.from("SWCB1\n");

/** Encrypts a stream into `file` as MAGIC, a 12-byte IV, the AES-256-GCM ciphertext and its 16-byte tag. */
export async function encryptTo(input, file, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const out = createWriteStream(file);
  out.write(Buffer.concat([MAGIC, iv]));
  await pipeline(input, cipher, out, { end: false });
  out.end(cipher.getAuthTag());
  await new Promise((ok, fail) => out.on("finish", ok).on("error", fail));
}

/** Decrypts a file encryptTo wrote into `target`. */
export async function decryptFile(file, target, key) {
  const size = statSync(file).size;
  const fd = openSync(file, "r");
  const head = Buffer.alloc(MAGIC.length + 12), tag = Buffer.alloc(16);
  readSync(fd, head, 0, head.length, 0);
  readSync(fd, tag, 0, 16, size - 16);
  closeSync(fd);
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error(`${file} is not a chat backup file.`);
  const decipher = createDecipheriv("aes-256-gcm", key, head.subarray(MAGIC.length));
  decipher.setAuthTag(tag);
  await pipeline(createReadStream(file, { start: head.length, end: size - 17 }), decipher, createWriteStream(target));
}

class B2 {
  constructor(env) {
    for (const name of ["B2_KEY_ID", "B2_APP_KEY"]) if (!env[name]) throw new Error(`${name} is missing from ${DEFAULTS.envFile}.`);
    this.env = env;
  }
  async authorize() {
    const auth = Buffer.from(`${this.env.B2_KEY_ID}:${this.env.B2_APP_KEY}`).toString("base64");
    const res = await fetch("https://api.backblazeb2.com/b2api/v3/b2_authorize_account", { headers: { authorization: `Basic ${auth}` } });
    if (!res.ok) throw new Error(`b2_authorize_account answered ${res.status}: ${await res.text()}`);
    const body = await res.json();
    const api = body.apiInfo.storageApi;
    Object.assign(this, { token: body.authorizationToken, apiUrl: api.apiUrl, downloadUrl: api.downloadUrl, accountId: body.accountId });
    this.bucketName = this.env.B2_BUCKET || api.bucketName;
    this.bucketId = api.bucketName === this.bucketName ? api.bucketId : null;
    if (!this.bucketId) {
      const { buckets } = await this.call("b2_list_buckets", { accountId: this.accountId, bucketName: this.bucketName });
      if (!buckets.length) throw new Error(`The key cannot see bucket ${this.bucketName}.`);
      this.bucketId = buckets[0].bucketId;
    }
    return this;
  }
  async call(name, body) {
    const res = await fetch(`${this.apiUrl}/b2api/v3/${name}`, { method: "POST", headers: { authorization: this.token }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`${name} answered ${res.status}: ${await res.text()}`);
    return res.json();
  }
  async names(prefix) {
    const out = [];
    let startFileName = null;
    do {
      const page = await this.call("b2_list_file_names", { bucketId: this.bucketId, prefix, maxFileCount: 10000, ...(startFileName ? { startFileName } : {}) });
      out.push(...page.files.map(f => f.fileName));
      startFileName = page.nextFileName;
    } while (startFileName);
    return out;
  }
  async upload(file, name) {
    const { uploadUrl, authorizationToken } = await this.call("b2_get_upload_url", { bucketId: this.bucketId });
    const sha1 = await hashFile(file, "sha1");
    // Streamed, so a 100 MB part never sits in memory: the first run read each part whole and peaked at 900 MB.
    const res = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        authorization: authorizationToken, "content-type": "application/octet-stream", "x-bz-file-name": encodeURIComponent(name),
        "content-length": String(statSync(file).size), "x-bz-content-sha1": sha1,
      },
      body: Readable.toWeb(createReadStream(file)),
      duplex: "half",
    });
    if (!res.ok) throw new Error(`b2_upload_file ${name} answered ${res.status}: ${await res.text()}`);
  }
  async download(name, file) {
    const res = await fetch(`${this.downloadUrl}/file/${this.bucketName}/${name.split("/").map(encodeURIComponent).join("/")}`, { headers: { authorization: this.token } });
    if (!res.ok) throw new Error(`download ${name} answered ${res.status}`);
    await pipeline(res.body, createWriteStream(file));
  }
  async removeStamp(stamp) {
    let start = { startFileName: `${B2_PREFIX}${stamp}/` };
    for (;;) {
      const page = await this.call("b2_list_file_versions", { bucketId: this.bucketId, prefix: `${B2_PREFIX}${stamp}/`, maxFileCount: 1000, ...start });
      for (const f of page.files) await this.call("b2_delete_file_version", { fileName: f.fileName, fileId: f.fileId });
      if (!page.nextFileName) return;
      start = { startFileName: page.nextFileName, startFileId: page.nextFileId };
    }
  }
}

/** B2 stamps that are complete (their manifest landed, which is uploaded last), oldest first. */
const b2Stamps = names => [...new Set(names.filter(n => n.endsWith("/manifest.json.enc")).map(n => n.slice(B2_PREFIX.length).split("/")[0]))].sort();

/** Uploads the newest local backup to B2 unless it is there already, then removes B2 backups beyond the newest KEEP. */
export async function uploadB2({ to = DEFAULTS.to, envFile = DEFAULTS.envFile, keyFile = DEFAULTS.keyFile, keep = KEEP, log = console.log } = {}) {
  const stamp = completeBackups(to).at(-1);
  if (!stamp) throw new Error(`No complete backup in ${to} to upload.`);
  const key = readKey(keyFile);
  const b2 = await new B2(readEnv(envFile)).authorize();
  const names = await b2.names(B2_PREFIX);
  if (b2Stamps(names).includes(stamp)) log(`B2 ${b2.bucketName}/${B2_PREFIX}${stamp}/ is there already; nothing uploaded.`);
  else {
    const dir = join(to, stamp);
    const tmp = join(to, `.b2-${stamp}`);
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp);
    try {
      const sqliteFiles = Object.keys(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).sqlite);
      const parts = [];
      for (const rel of sqliteFiles) {
        const name = `${rel.replaceAll("/", "__")}.enc`;
        await encryptTo(createReadStream(join(dir, rel)), join(tmp, name), key);
        parts.push(name);
      }
      const tar = spawn("tar", ["-C", dir, ...sqliteFiles.map(rel => `--exclude=./${rel}`), "-cf", "-", "."], { stdio: ["ignore", "pipe", "inherit"] });
      const tarDone = new Promise((ok, fail) => tar.on("close", code => (code === 0 ? ok() : fail(new Error(`tar exited ${code}`)))));
      await encryptTo(tar.stdout, join(tmp, "rest.tar.enc"), key);
      await tarDone;
      parts.push("rest.tar.enc");
      await encryptTo(createReadStream(join(dir, "manifest.json")), join(tmp, "manifest.json.enc"), key);
      let sent = 0;
      for (const name of [...parts, "manifest.json.enc"]) {
        await b2.upload(join(tmp, name), `${B2_PREFIX}${stamp}/${name}`);
        sent += statSync(join(tmp, name)).size;
      }
      log(`Uploaded ${stamp} to B2 ${b2.bucketName}/${B2_PREFIX}${stamp}/: ${parts.length + 1} files, ${mb(sent)}, encrypted.`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  const stamps = b2Stamps(await b2.names(B2_PREFIX));
  const all = [...new Set(names.map(n => n.slice(B2_PREFIX.length).split("/")[0]))].sort();
  const oldestKept = stamps.at(-keep) ?? stamps[0];
  const gone = stamps.length > keep ? all.filter(s => s < oldestKept) : [];
  for (const s of gone) await b2.removeStamp(s);
  if (gone.length) log(`Removed ${gone.length} old B2 backups: ${gone.join(", ")}.`);
  return { stamp, bucket: b2.bucketName, removed: gone };
}

/** Downloads one B2 backup (the newest complete one by default) and decrypts it into <dir>/<stamp>/, a folder `restore` takes. */
export async function fetchB2({ stamp, into, envFile = DEFAULTS.envFile, keyFile = DEFAULTS.keyFile, log = console.log }) {
  const key = readKey(keyFile);
  const b2 = await new B2(readEnv(envFile)).authorize();
  const names = await b2.names(B2_PREFIX);
  stamp ??= b2Stamps(names).at(-1);
  if (!stamp || !b2Stamps(names).includes(stamp)) throw new Error(`No complete B2 backup ${stamp ?? ""} under ${b2.bucketName}/${B2_PREFIX}.`);
  const dir = join(into, stamp);
  if (existsSync(dir)) throw new Error(`${dir} exists already.`);
  const tmp = join(into, `.b2-${stamp}`);
  mkdirSync(tmp, { recursive: true });
  mkdirSync(dir);
  try {
    for (const name of names.filter(n => n.startsWith(`${B2_PREFIX}${stamp}/`))) {
      const base = name.split("/").pop();
      await b2.download(name, join(tmp, base));
      const plain = join(tmp, base.replace(/\.enc$/, ""));
      await decryptFile(join(tmp, base), plain, key);
      if (base === "rest.tar.enc") {
        const r = spawnSync("tar", ["-C", dir, "-xf", plain], { stdio: "inherit" });
        if (r.status !== 0) throw new Error(`tar -x exited ${r.status}`);
      } else if (base !== "manifest.json.enc") renameSync(plain, join(dir, base.replace(/\.enc$/, "").replaceAll("__", "/")));
    }
    log(`Fetched B2 ${b2.bucketName}/${B2_PREFIX}${stamp}/ into ${dir}.`);
    return dir;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- install ----

const UNITS = ["sieun-pi-chat-backup.service", "sieun-pi-chat-backup.timer"];
const here = dirname(fileURLToPath(import.meta.url));
const RELEASE_SCRIPT = join(HOME, ".local/share/sieun-pi-apps-chat/current/apps/chat/scripts/chat-backup.mjs");

/** Writes the units, makes the encryption key once and copies it to the Mac. A second run changes nothing. */
export function install({ unitDir = join(HOME, ".config/systemd/user"), templateDir = resolve(here, "../../../deploy/linux"), log = console.log } = {}) {
  // The installed release's copy keeps working after releases; until a release carries this script, the checkout's copy runs.
  const script = existsSync(RELEASE_SCRIPT) ? RELEASE_SCRIPT : join(here, "chat-backup.mjs");
  mkdirSync(unitDir, { recursive: true });
  let changed = 0;
  for (const unit of UNITS) {
    const text = readFileSync(join(templateDir, unit), "utf8").replaceAll("@SCRIPT@", script);
    const file = join(unitDir, unit);
    if (existsSync(file) && readFileSync(file, "utf8") === text) continue;
    writeFileSync(file, text);
    changed += 1;
    log(`Wrote ${file}.`);
  }
  if (changed) systemctl(["daemon-reload"]);
  const enabled = spawnSync("systemctl", ["--user", "is-enabled", "sieun-pi-chat-backup.timer"], { encoding: "utf8" }).stdout.trim() === "enabled";
  const active = spawnSync("systemctl", ["--user", "is-active", "sieun-pi-chat-backup.timer"], { encoding: "utf8" }).stdout.trim() === "active";
  if (!enabled || !active) {
    systemctl(["enable", "--now", "sieun-pi-chat-backup.timer"]);
    log("Enabled and started sieun-pi-chat-backup.timer.");
  }
  const keyMade = ensureKey(DEFAULTS.keyFile, log);
  const mac = keyToMac(DEFAULTS.keyFile, log);
  if (!changed && enabled && active && !keyMade && mac !== "copied") log(`Nothing changed: the units, the timer and the key are in place (runs ${script}).`);
  if (!existsSync(DEFAULTS.envFile)) log(`No ${DEFAULTS.envFile}, so the nightly run cannot upload to B2.`);
  return { changed, script };
}

function systemctl(args) {
  const r = spawnSync("systemctl", ["--user", ...args], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`systemctl --user ${args.join(" ")} exited ${r.status}`);
}

function ensureKey(file, log) {
  if (existsSync(file)) return false;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, randomBytes(32).toString("base64") + "\n", { mode: 0o600, flag: "wx" });
  log(`Made the B2 encryption key ${file}.`);
  return true;
}

/** Copies the key to the same path on the Mac when the Mac's copy differs. Returns "same", "copied" or "offline". */
function keyToMac(file, log) {
  const text = readFileSync(file, "utf8");
  const want = createHash("sha256").update(text).digest("hex");
  const rel = file.slice(HOME.length + 1);
  const have = spawnSync("ssh", ["-o", "BatchMode=yes", "mac", `shasum -a 256 ~/${rel} 2>/dev/null || true`], { encoding: "utf8" });
  if (have.status !== 0) {
    log(`The Mac did not answer (ssh exit ${have.status}), so it may not hold ${file} yet; run install again when it is awake.`);
    return "offline";
  }
  if (have.stdout.split(" ")[0] === want) return "same";
  const put = spawnSync("ssh", ["-o", "BatchMode=yes", "mac", `umask 077 && mkdir -p ~/${dirname(rel)} && cat > ~/${rel}`], { input: text, encoding: "utf8" });
  if (put.status !== 0) throw new Error(`Copying the key to the Mac failed: ${put.stderr.trim()}`);
  log(`Copied ${file} to the Mac (~/${rel}).`);
  return "copied";
}

// ---- command line ----

const HELP = `chat-backup.mjs <command>

  run [--data-dir D] [--to DIR] [--b2]       make a backup of the data dir, prune old ones, and with --b2 upload the newest to B2
  restore <backup dir> --to <empty dir>      rebuild a data dir from a backup and check it against the manifest
  check [--to DIR]                           the newest complete backup and its age; exits 1 past ${MAX_AGE_H} h or with none
  install                                    write and enable the nightly systemd user timer; a second run changes nothing
  fetch-b2 [<stamp>] --to <dir>              download and decrypt a B2 backup into <dir>/<stamp>/, which restore takes

The default data dir is ${DEFAULTS.dataDir} and the default backup folder is ${DEFAULTS.to}.`;

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: { "data-dir": { type: "string" }, to: { type: "string" }, b2: { type: "boolean" }, help: { type: "boolean", short: "h" } },
  });
  const [command, arg] = positionals;
  const to = values.to ?? DEFAULTS.to;
  switch (command) {
    case "run": {
      const result = await runBackup({ dataDir: values["data-dir"] ?? DEFAULTS.dataDir, to });
      if (values.b2) await uploadB2({ to });
      return result.stamp === null ? 1 : 0;
    }
    case "restore":
      if (!arg || !values.to) throw new Error("Usage: chat-backup.mjs restore <backup dir> --to <empty dir>");
      await restoreBackup(resolve(arg), resolve(values.to));
      return 0;
    case "check": {
      const result = checkBackups(to);
      console.log(result.line);
      return result.ok ? 0 : 1;
    }
    case "install":
      install();
      return 0;
    case "fetch-b2":
      if (!values.to) throw new Error("Usage: chat-backup.mjs fetch-b2 [<stamp>] --to <dir>");
      await fetchB2({ stamp: arg, into: resolve(values.to) });
      return 0;
    default:
      console.log(HELP);
      return values.help ? 0 : 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  }, error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
