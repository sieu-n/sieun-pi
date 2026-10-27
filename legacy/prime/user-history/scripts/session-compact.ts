import { closeSync, copyFileSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, renameSync, statSync, writeFileSync, writeSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { ImageStore, Projector } from "../src/chat-projection.ts";
import { artifactsDir, imageKey, moveImage } from "../src/moved-images.ts";
import { historyMessages } from "../src/session-tail.ts";

/**
 * Shrinks old entries of Prime session files: the parts no model reads again and the chat shows only in part. Measured on 10-18, old chat_board
 * results were 39 to 54% of each big chat file (66 of 172 MB in AI harness), inline base64 images up to 39%, and harness digests 1 to 3%.
 *
 * Only entries before the first entry the session's last compaction keeps are touched, so the context Prime builds for the next turn is the
 * same. A chat_board result keeps the first TEXT_KEEP characters of each text part (the feed shows 600) and says how much went. A harness
 * digest keeps its fingerprint. An image's bytes move to `session-artifacts/<id>/images/<key>.<ext>` and the part keeps its type, mime type and
 * that file name, which the chat serves under the same `api/images/<key>` URL as before (src/moved-images.ts).
 *
 * `node --import tsx scripts/session-compact.ts <session file or id>...` prints what it would remove. With `--apply` it waits until the
 * daemon lists the session idle and no process holds the file open for writing, backs the file up to `--backup-dir`, writes the new file
 * beside it, copies over every line the daemon appended meanwhile, renames it into place, and checks every line and the projected feed
 * against the backup. A second run finds nothing to do. `--socket none` skips the daemon check, for a copy no daemon runs.
 * `--keep-images` leaves images inline, for a box whose chat cannot serve moved ones yet; a later run without it moves them. `--restore <manifest>` puts a backup back with the lines appended since.
 */

const TEXT_KEEP = 600;
const STUB_MIN_CHARS = 2000;
const DIGEST_MIN_CHARS = 1000;
const IMAGE_MIN_CHARS = 4096;
const IDLE_POLL_MS = 2000;
const LATE_APPEND_MS = 1500;
const TODAY = new Date().toISOString().slice(0, 10);

type Entry = Record<string, any>;
interface Plan {
  file: string; size: number; lines: Buffer[]; cut: number; changed: Map<number, Buffer>;
  images: { path: string; bytes: Buffer }[]; counts: Record<string, { n: number; before: number; after: number }>;
}

const HEAD = /^\{"type":"([^"]*)","id":"([^"]*)","parentId":(?:null|"([^"]*)")/;

function head(line: Buffer): { type: string; id: string; parentId: string | null } | undefined {
  const match = HEAD.exec(line.toString("utf8", 0, Math.min(line.length, 300)));
  if (match) return { type: match[1]!, id: match[2]!, parentId: match[3] ?? null };
  try {
    const entry = JSON.parse(line.toString("utf8")) as Entry;
    return typeof entry.id === "string" ? { type: String(entry.type), id: entry.id, parentId: typeof entry.parentId === "string" ? entry.parentId : null } : undefined;
  } catch { return undefined; }
}

function splitLines(bytes: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;
  for (let end = bytes.indexOf(0x0a); end >= 0; end = bytes.indexOf(0x0a, start)) { lines.push(bytes.subarray(start, end)); start = end + 1; }
  return lines;
}

/** The file index of the first entry the last compaction on the leaf's branch keeps; 0 when the branch has no compaction. */
function cutIndex(lines: Buffer[]): number {
  const index = new Map<string, number>();
  const parent = new Map<string, string | null>();
  let leaf: string | undefined;
  lines.forEach((line, i) => {
    const h = head(line);
    if (!h) return;
    index.set(h.id, i); parent.set(h.id, h.parentId); leaf = h.id;
  });
  for (let id: string | null | undefined = leaf; id; id = parent.get(id)) {
    const i = index.get(id)!;
    if (!lines[i]!.includes('"type":"compaction"')) continue;
    const entry = JSON.parse(lines[i]!.toString("utf8")) as Entry;
    if (entry.type !== "compaction") continue;
    const kept = index.get(entry.firstKeptEntryId);
    return kept ?? 0;
  }
  return 0;
}

function textLength(content: unknown): number {
  return Array.isArray(content) ? content.reduce((sum, part) => sum + (part?.type === "text" && typeof part.text === "string" ? part.text.length : 0), 0) : 0;
}

function stubBoard(message: Entry): boolean {
  if (!Array.isArray(message.content) || textLength(message.content) < STUB_MIN_CHARS) return false;
  message.content = message.content.map((part: Entry) => {
    if (part?.type !== "text" || typeof part.text !== "string" || part.text.length <= TEXT_KEEP) return part;
    const removed = part.text.length - TEXT_KEEP;
    return { ...part, text: `${part.text.slice(0, TEXT_KEEP)}\n\n[session-compact ${TODAY}: ${removed.toLocaleString("en-US")} more characters of this old chat_board result were removed; the session backup has them.]` };
  });
  return true;
}

function stubDigest(entry: Entry): boolean {
  const length = typeof entry.content === "string" ? entry.content.length : textLength(entry.content);
  if (length < DIGEST_MIN_CHARS) return false;
  entry.content = `[harness-digest] session-compact ${TODAY}: this old digest of ${length.toLocaleString("en-US")} characters was removed.`;
  const fingerprint = entry.details?.stateFingerprint;
  entry.details = typeof fingerprint === "string" ? { stateFingerprint: fingerprint } : {};
  return true;
}

function moveImages(content: unknown, folder: string, images: Plan["images"]): number {
  if (!Array.isArray(content)) return 0;
  let moved = 0;
  content.forEach((part: Entry, i) => {
    if (part?.type !== "image" || typeof part.data !== "string" || part.data.length < IMAGE_MIN_CHARS || typeof part.mimeType !== "string") return;
    const bytes = Buffer.from(part.data, "base64");
    if (bytes.toString("base64") !== part.data) return;
    const target = moveImage(part.mimeType, part.data);
    if (!target) return;
    images.push({ path: join(folder, target.part.file), bytes });
    content[i] = target.part;
    moved++;
  });
  return moved;
}

function count(plan: Plan, kind: string, before: number, after: number): void {
  const row = plan.counts[kind] ??= { n: 0, before: 0, after: 0 };
  row.n++; row.before += before; row.after += after;
}

/** What compaction would change in the complete lines of `bytes`: the new bytes of each changed line and the image files to write. */
export function planCompaction(file: string, bytes: Buffer, options = { images: true }): Plan {
  const lines = splitLines(bytes);
  const plan: Plan = { file, size: bytes.length, lines, cut: cutIndex(lines), changed: new Map(), images: [], counts: {} };
  const folder = artifactsDir(file);
  for (let i = 1; i < plan.cut; i++) {
    const line = lines[i]!;
    const board = line.includes('"toolName":"chat_board"');
    const digest = line.includes('"customType":"harness_digest"');
    const image = options.images && line.includes('"type":"image"');
    if (!board && !digest && !image) continue;
    const entry = JSON.parse(line.toString("utf8")) as Entry;
    let kind: string | undefined;
    const message = entry.type === "message" ? entry.message : undefined;
    if (board && message?.role === "toolResult" && message.toolName === "chat_board" && stubBoard(message)) kind = "chat_board";
    if (digest && entry.type === "custom_message" && entry.customType === "harness_digest" && stubDigest(entry)) kind = "digest";
    const content = message ? message.content : entry.type === "custom_message" ? entry.content : undefined;
    if (image && moveImages(content, folder, plan.images)) kind ??= "image";
    if (!kind) continue;
    const next = Buffer.from(JSON.stringify(entry));
    plan.changed.set(i, next);
    count(plan, kind, line.length + 1, next.length + 1);
  }
  return plan;
}

function compactedBytes(plan: Plan): Buffer {
  return Buffer.concat(plan.lines.flatMap((line, i) => [plan.changed.get(i) ?? line, Buffer.from("\n")]));
}

const mb = (n: number): string => (n / 1e6).toFixed(1);

function describe(plan: Plan): string {
  const after = plan.size + [...Object.values(plan.counts)].reduce((sum, row) => sum + row.after - row.before, 0);
  const rows = Object.entries(plan.counts).map(([kind, row]) => `${kind} ${row.n} (${mb(row.before - row.after)} MB)`).join(", ") || "nothing to remove";
  return `${basename(plan.file)} ${mb(plan.size)} MB -> ${mb(after)} MB; cut at line ${plan.cut} of ${plan.lines.length}; ${rows}`;
}

/** One request to the Prime daemon socket and its response. */
function daemonRequest(socket: string, command: Entry, timeoutMs = 30_000): Promise<Entry> {
  return new Promise((resolve, reject) => {
    const connection = createConnection(socket);
    let buffer = "";
    let greeted = false;
    const timer = setTimeout(() => { connection.destroy(); reject(new Error("The daemon did not answer.")); }, timeoutMs);
    connection.on("error", error => { clearTimeout(timer); reject(error); });
    connection.on("data", chunk => {
      buffer += chunk.toString("utf8");
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const message = JSON.parse(buffer.slice(0, end)) as Entry;
        buffer = buffer.slice(end + 1);
        if (!greeted && message.type === "daemon_hello") {
          greeted = true;
          connection.write(JSON.stringify({ type: "command", id: `compact-${process.pid}`, protocol: { name: "prime-agent.daemon", version: message.protocol.version }, command }) + "\n");
        } else if (message.type === "response") { clearTimeout(timer); connection.end(); resolve(message); }
      }
    });
  });
}

/** Why the daemon would mind a rewrite now, or undefined when it lists the session stopped or idle. */
async function busy(socket: string, file: string): Promise<string | undefined> {
  if (socket === "none") return undefined;
  const response = await daemonRequest(socket, { type: "list", all: true });
  const rows = (response.data?.sessions ?? []) as Entry[];
  const row = rows.find(candidate => candidate.sessionFile === file);
  if (!row || row.lifecycle !== "live") return undefined;
  const reasons = [row.activity !== "idle" && `activity ${row.activity}`, row.isStreaming && "streaming", row.isCompacting && "compacting",
    row.isBashRunning && "bash", row.isRunningTools && "tools", row.unfinishedActionCount && "unfinished action", row.sessionActions?.queuedCount && "queued"].filter(Boolean);
  return reasons.length ? reasons.join(", ") : undefined;
}

/** Processes holding `file` open for writing (Linux /proc). Read-only handles keep the old inode alive but write nothing. */
function writers(file: string): number[] {
  if (!existsSync("/proc/self/fd")) return [];
  const target = realpathSync(file);
  const found = new Set<number>();
  for (const pid of readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    let fds: string[];
    try { fds = readdirSync(`/proc/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      try {
        if (readlinkSync(`/proc/${pid}/fd/${fd}`) !== target) continue;
        const flags = Number.parseInt(/flags:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/fdinfo/${fd}`, "utf8"))![1]!, 8);
        if (flags & 3) found.add(Number(pid));
      } catch { /* the fd closed meanwhile */ }
    }
  }
  return [...found];
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function readRange(fd: number, from: number, to: number): Buffer {
  const bytes = Buffer.alloc(to - from);
  let done = 0;
  while (done < bytes.length) done += readSync(fd, bytes, done, bytes.length - done, from + done);
  return bytes;
}

function writeAll(fd: number, bytes: Buffer): void {
  for (let done = 0; done < bytes.length;) done += writeSync(fd, bytes, done, bytes.length - done);
}

function writeImage(image: { path: string; bytes: Buffer }): void {
  if (existsSync(image.path) && readFileSync(image.path).equals(image.bytes)) return;
  mkdirSync(dirname(image.path), { recursive: true });
  const temp = `${image.path}.${process.pid}.tmp`;
  writeFileSync(temp, image.bytes, { mode: 0o600 });
  renameSync(temp, image.path);
}

const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** The feed the chat projects from every entry of a file, as JSON; moved images project to the URL their inline bytes had. */
function projected(bytes: Buffer): string {
  const entries = splitLines(bytes).slice(1).map(line => JSON.parse(line.toString("utf8")));
  return JSON.stringify(new Projector(new ImageStore(1)).messages(historyMessages(entries)));
}

/** Checks the rewritten file against the backup line by line, every moved image file, and the projected feed. Throws on any difference. */
function verify(file: string, backup: Buffer, plan: Plan): void {
  const now = readFileSync(file);
  const oldLines = splitLines(backup);
  const newLines = splitLines(now);
  if (newLines.length < oldLines.length) throw new Error(`${basename(file)}: ${newLines.length} lines after, ${oldLines.length} before`);
  oldLines.forEach((line, i) => {
    const changed = plan.changed.get(i);
    if (!changed) { if (!line.equals(newLines[i]!)) throw new Error(`${basename(file)}: line ${i} differs`); return; }
    if (!changed.equals(newLines[i]!)) throw new Error(`${basename(file)}: line ${i} is not the planned stub`);
    const a = JSON.parse(line.toString("utf8")) as Entry;
    const b = JSON.parse(newLines[i]!.toString("utf8")) as Entry;
    for (const key of ["type", "id", "parentId", "timestamp"]) if (a[key] !== b[key]) throw new Error(`${basename(file)}: line ${i} changed its ${key}`);
  });
  for (let i = oldLines.length; i < newLines.length; i++) JSON.parse(newLines[i]!.toString("utf8"));
  for (const image of plan.images) {
    const bytes = readFileSync(image.path);
    const [key, extension] = basename(image.path).split(".");
    const mimeType = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" }[extension!]!;
    if (imageKey(mimeType, bytes.toString("base64")) !== key) throw new Error(`${image.path}: bytes do not match the key`);
  }
  if (projected(backup) !== projected(Buffer.concat([...newLines.slice(0, oldLines.length).flatMap(line => [line, Buffer.from("\n")])]))) {
    throw new Error(`${basename(file)}: the projected feed differs`);
  }
}

export async function apply(file: string, options: { backupDir: string; socket: string; waitMs: number; images?: boolean }): Promise<string> {
  const fd = openSync(file, "r");
  try {
    for (const started = Date.now(); ;) {
      const reason = (await busy(options.socket, file)) ?? (writers(file).length ? `open for writing by ${writers(file).join(", ")}` : undefined);
      if (!reason) break;
      if (Date.now() - started > options.waitMs) return `${basename(file)}: skipped, the session stayed busy (${reason})`;
      await sleep(IDLE_POLL_MS);
    }
    const info = fstatSync(fd);
    const read = readRange(fd, 0, info.size);
    let have = read.lastIndexOf(0x0a) + 1;
    const plan = planCompaction(file, read.subarray(0, have), { images: options.images ?? true });
    if (!plan.changed.size) return `${basename(file)}: nothing to remove`;
    mkdirSync(options.backupDir, { recursive: true });
    let backupPath = join(options.backupDir, basename(file));
    for (let n = 2; existsSync(backupPath); n++) backupPath = join(options.backupDir, `${basename(file, ".jsonl")}.${n}.jsonl`);
    const backupFd = openSync(backupPath, "wx", 0o600);
    writeAll(backupFd, read.subarray(0, have));
    for (const image of plan.images) writeImage(image);
    const compacted = compactedBytes(plan);
    const temp = join(dirname(file), `.${basename(file)}.compact-${process.pid}.tmp`);
    const out = openSync(temp, "wx", info.mode & 0o777);
    writeAll(out, compacted);
    const copyTail = (to: number): void => {
      const tail = readRange(fd, have, to);
      writeAll(out, tail); writeAll(backupFd, tail);
      have = to;
    };
    for (let tries = 0; ; tries++) {
      const now = statSync(file);
      if (now.ino !== info.ino) throw new Error(`${basename(file)} was replaced while compacting; nothing renamed`);
      if (now.size === have) break;
      const tail = readRange(fd, have, now.size);
      if (tail[tail.length - 1] === 0x0a || tries > 100) copyTail(tail[tail.length - 1] === 0x0a ? now.size : have + tail.lastIndexOf(0x0a) + 1);
      if (statSync(file).size === have) break;
      await sleep(50);
    }
    fsyncSync(out); closeSync(out);
    renameSync(temp, file);
    let late = 0;
    for (let check = 0; check < 2; check++) {
      await sleep(LATE_APPEND_MS);
      const size = fstatSync(fd).size;
      if (size > have) {
        const tail = readRange(fd, have, size);
        writeAll(backupFd, tail);
        const appendFd = openSync(file, "a");
        writeAll(appendFd, tail); closeSync(appendFd);
        late += tail.length; have = size;
      }
    }
    fsyncSync(backupFd); closeSync(backupFd);
    const backup = readFileSync(backupPath);
    verify(file, backup.subarray(0, plan.size), plan);
    const after = statSync(file).size;
    const manifest = { file, backup: backupPath, at: new Date().toISOString(), sizeBefore: backup.length, sizeAfter: after, compactedPrefix: compacted.length,
      backupSha256: sha(backup), cutLine: plan.cut, counts: plan.counts, images: plan.images.map(image => image.path), lateAppendBytes: late };
    writeFileSync(`${backupPath}.manifest.json`, JSON.stringify(manifest, null, 1) + "\n", { mode: 0o600 });
    return `${describe(plan)}; now ${mb(after)} MB on disk; backup ${backupPath}`;
  } finally { closeSync(fd); }
}

/** Puts a backup back: its bytes, then every line appended to the compacted file since. */
function restore(manifestPath: string): string {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { file: string; backup: string; sizeAfter: number };
  const now = readFileSync(manifest.file);
  const content = Buffer.concat([readFileSync(manifest.backup), now.subarray(manifest.sizeAfter)]);
  const temp = `${manifest.file}.restore-${process.pid}.tmp`;
  writeFileSync(temp, content, { mode: statSync(manifest.file).mode & 0o777 });
  if (statSync(manifest.file).size !== now.length) throw new Error("The file grew during the restore; run it again.");
  renameSync(temp, manifest.file);
  return `${basename(manifest.file)} restored, ${mb(content.length)} MB`;
}

function sessionPath(arg: string): string {
  if (arg.includes("/")) return realpathSync(arg);
  const dir = join(homedir(), ".prime", "agent", "sessions");
  const match = readdirSync(dir).filter(name => name.startsWith(arg) && name.endsWith(".jsonl"));
  if (match.length !== 1) throw new Error(`${arg} names ${match.length} session files`);
  return join(dir, match[0]!);
}

async function main(argv: string[]): Promise<void> {
  const flag = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv.splice(i, 2)[1] : undefined; };
  const restoreManifest = flag("--restore");
  if (restoreManifest) { console.log(restore(restoreManifest)); return; }
  const backupDir = flag("--backup-dir") ?? join(homedir(), "backups", `session-compact-${TODAY}`);
  const socket = flag("--socket") ?? join("/tmp", `prime-agent-${process.getuid?.() ?? 0}`, "daemon.sock");
  const waitMs = Number(flag("--wait-seconds") ?? "600") * 1000;
  const applyIt = argv.includes("--apply");
  const images = !argv.includes("--keep-images");
  for (const arg of argv.filter(a => a !== "--apply" && a !== "--keep-images")) {
    const file = sessionPath(arg);
    if (!applyIt) {
      const bytes = readFileSync(file);
      console.log(describe(planCompaction(file, bytes.subarray(0, bytes.lastIndexOf(0x0a) + 1), { images })));
      continue;
    }
    console.log(await apply(file, { backupDir, socket, waitMs, images }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main(process.argv.slice(2));
