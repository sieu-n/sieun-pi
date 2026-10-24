import { execFile, execFileSync } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import { closeSync, cpSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { trainFile } from "../../src/checkin-load.ts";
import { INPUT_ROOT_ENV, type InputRoots, inputRoots, precheckDir, pushesFile, rootsUnder, serviceLogFile } from "./inputs.ts";
import { type JudgeVersion, short } from "./judge-version.ts";
import { headerParent, PRIME_DIR, readSessionFile, type RunState, sessionFiles, type Verdict } from "./session-read.ts";

/**
 * The evidence of a clean-room run kept after teardown deletes the run folder, so a later judge can judge it again with the same inputs. On
 * 10-24 carried-wait release-run-1 passed on an obsolete judge and its teardown deleted the agents snapshots that held the ownership data, so
 * the pass could be neither trusted nor judged again. The archive sits next to the verdict file and holds:
 *
 *   <run name>/          the run folder as teardown found it: run.json, criteria.md, boards, agents, runs.jsonl, prompts, units.json, logs
 *   home/                every other file a judge reads, at the path it reads it under `rootsUnder` (inputs.ts): the session files of the run's
 *                        sessions and their descendants, the header line of each outside sender, the window's slice of service.log, the d9
 *                        pushes file, the CI cache and the chat's check-in precheck files
 *   ownership.json       the chat-jobs.json entries that file a session under the run's chats
 *   identity.jsonl       each delivery receipt collect kept from service.log: path, source chat and session, target session and delivery id
 *   outbox/              the service's agent-outbox and owner outbox entries addressed to the run's sessions
 *   verdicts/            the verdict files written so far
 *   archive.json         the manifest: the run, its window, the criteria's sha256, the judge versions, the sessions and every input file
 */
export interface ArchiveManifest {
  run: string; scenario: string; chat: { id: string; name: string }; windowStart: number; until?: number; archivedAt: number;
  criteria: { file: string; sha256: string }; judge: { loaded: JudgeVersion; current: JudgeVersion }; sessions: ArchivedSession[]; verdicts: string[];
  /** The live roots the inputs were read under, so rejudge maps a stored path under one of them into the archive's home/. */
  liveRoots: InputRoots; inputs: ArchiveInput[];
}
/**
 * A session the archive holds: one of the run's, a descendant found in their session folders or a sender whose header names a held session as
 * its parent, both kept whole, or another sender kept as its header line only.
 */
export interface ArchivedSession { id: string; kind: "run" | "descendant" | "sender header"; missing?: true; denied?: true }
/** Bytes [start, end) of a source file. */
export interface ByteRange { start: number; end: number }
export type Selection = "whole file" | "window slice" | "header line";
/**
 * One file an archive or supplement holds for the judge, at `path` under the archive root, read from `source`. `sourceSize` and `sourceSha256`
 * cover the source as it was read. A slice holds the source's `ranges` in order, and `prefixSha256` covers source bytes 0 to the last range's
 * end, so a slice of an append-only file such as service.log can be checked against that file later. A source that did not exist is `missing`,
 * and one the archiver was not allowed to read is `denied` with the error code; the archive holds no file for either, so the judge reads it
 * as missing and the criteria that need it stay unknown.
 */
export type ArchiveInput = { path: string; source: string; selection: Selection; missing: true }
  | { path: string; source: string; selection: Selection; denied: string }
  | { path: string; source: string; selection: Selection; sourceSize: number; sourceSha256: string; sha256: string; ranges?: ByteRange[]; prefixSha256?: string };
/** supplement.json: files added to an archive after it was sealed, tied to that archive's bytes, criteria and window. */
export interface SupplementManifest {
  archive: { path: string; sha256: string }; criteria: { sha256: string }; windowStart: number; until?: number; createdAt: number; why: string; inputs: ArchiveInput[];
}
/** A file for `sealSupplement`: the selected bytes of `source`, laid at `path` under the archive root, with the source ranges a slice took. */
export interface SupplementFile { source: string; path: string; bytes: Uint8Array; selection: Selection; ranges?: readonly ByteRange[] }

/** A delivery receipt line, `deliveryLine` in src/clean-room-subjects.ts. */
export const DELIVERY = /\bdelivery (sibling send|d9 push|job-steer): from session (.+?)(?: \((.*)\))? of chat (\S+) to session (\S+) as (\S+?)(?:, taken to the trial owner (\S+))?\s*$/;
/** The time stamp that opens a stamped service.log line. */
export const STAMP = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z) /;

/**
 * The receipts in a run's service.log, one record each, so identity comes from session ids and never from job names. Evaluate and teardown
 * read the log's tail again, so the same line can be there twice, and a receipt line carries no time to tell two copies apart.
 */
export function deliveries(serviceLog: string): Record<string, string>[] {
  if (!existsSync(serviceLog)) return [];
  return [...new Set(readFileSync(serviceLog, "utf8").split("\n"))].flatMap(line => {
    const match = DELIVERY.exec(line);
    if (!match) return [];
    const [, path, from, fromName, fromChat, to, id, owner] = match;
    return [{ path: path!, from: from!, ...fromName ? { fromName } : {}, fromChat: fromChat!, to: to!, id: id!, ...owner ? { owner } : {}, line: line.trim() }];
  });
}

export const archivePath = (run: string): string => join(dirname(run), `${basename(run)}.evidence.tar.gz`);
export const fileSha256 = (file: string): string => existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : "missing";
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-/;

// measured: with 1 MiB reads, serviceLogSlice took 14.0 s over the 794 MB live service.log on us-metal02 on 10-25, against 12.4 s for readDelivery.
const CHUNK = 1 << 20;
function eachChunk(fd: number, end: number, each: (chunk: Buffer, offset: number) => boolean | void): void {
  for (let offset = 0; offset < end;) {
    const chunk = Buffer.allocUnsafe(Math.min(CHUNK, end - offset));
    const read = readSync(fd, chunk, 0, chunk.length, offset);
    if (read === 0) return;
    if (each(chunk.subarray(0, read), offset) === false) return;
    offset += read;
  }
}
function readRange(fd: number, { start, end }: ByteRange): Buffer {
  const out = Buffer.alloc(end - start);
  for (let at = 0; at < out.length;) { const read = readSync(fd, out, at, out.length - at, start + at); if (read === 0) break; at += read; }
  return out;
}
function withFile<T>(file: string, use: (fd: number, size: number) => T): T {
  const fd = openSync(file, "r");
  try { return use(fd, fstatSync(fd).size); } finally { closeSync(fd); }
}
function hashFile(fd: number, end: number): string {
  const hash = createHash("sha256");
  eachChunk(fd, end, chunk => { hash.update(chunk); });
  return hash.digest("hex");
}

interface Taken { bytes: Buffer; size: number; sha256: string; ranges?: ByteRange[]; prefixSha256?: string }

const whole = (file: string): Taken | undefined => {
  if (!existsSync(file)) return undefined;
  const bytes = readFileSync(file);
  return { bytes, size: bytes.length, sha256: sha256(bytes) };
};

const headerLine = (file: string): Taken | undefined => existsSync(file) ? withFile(file, (fd, size) => {
  let end = size;
  eachChunk(fd, size, (chunk, offset) => { const at = chunk.indexOf(10); if (at < 0) return true; end = offset + at + 1; return false; });
  const range = { start: 0, end };
  const bytes = readRange(fd, range);
  return { bytes, size, sha256: hashFile(fd, size), ranges: [range], prefixSha256: sha256(bytes) };
}) : undefined;

/**
 * The part of service.log `readDelivery` reads for a window: the first stamped line, then every line from the first stamped line at or after
 * `windowStart` through the first stamped line past `until`, or through the end when `until` is unset. The log is read in chunks up to its size
 * when opened, since it is about 800 MB and the service appends to it meanwhile.
 */
export function serviceLogSlice(file: string, windowStart: number, until?: number): Taken | undefined {
  if (!existsSync(file)) return undefined;
  return withFile(file, (fd, size) => {
    const hash = createHash("sha256");
    let fed = 0;
    const feed = (chunk: Buffer, offset: number, to: number): void => { if (to > fed) { hash.update(chunk.subarray(fed - offset, to - offset)); fed = to; } };
    const stampAt = (chunk: Buffer, offset: number, start: number): number | undefined => {
      const head = start >= offset && start - offset + 40 <= chunk.length ? chunk.subarray(start - offset, start - offset + 40)
        : readRange(fd, { start, end: Math.min(size, start + 40) });
      if (head[0] === undefined || head[0] < 48 || head[0] > 57) return undefined;
      const stamp = STAMP.exec(head.toString("latin1"))?.[1];
      return stamp === undefined ? undefined : Date.parse(stamp);
    };
    const found: { first?: { range: ByteRange; hash: Hash }; from?: number; stop?: { end: number; hash: Hash }; lineStart: number } = { lineStart: 0 };
    const line = (chunk: Buffer, offset: number, end: number): void => {
      const at = stampAt(chunk, offset, found.lineStart);
      if (at !== undefined) {
        if (!found.first) { feed(chunk, offset, end); found.first = { range: { start: found.lineStart, end }, hash: hash.copy() }; }
        if (found.from === undefined && (at >= windowStart || (until !== undefined && at > until))) found.from = found.lineStart;
        if (until !== undefined && at > until) { feed(chunk, offset, end); found.stop = { end, hash: hash.copy() }; }
      }
      found.lineStart = end;
    };
    eachChunk(fd, size, (chunk, offset) => {
      for (let at = chunk.indexOf(10); at >= 0 && !found.stop; at = chunk.indexOf(10, at + 1)) line(chunk, offset, offset + at + 1);
      if (!found.stop && offset + chunk.length === size && found.lineStart < size) line(chunk, offset, size);
      feed(chunk, offset, offset + chunk.length);
    });
    const { first, from, stop } = found;
    const digest = hash.digest("hex");
    const window = from === undefined ? [] : [{ start: from, end: stop?.end ?? size }];
    const ranges = first && (from === undefined || first.range.end <= from) ? [first.range, ...window] : window;
    const prefixSha256 = stop ? stop.hash.digest("hex") : from !== undefined ? digest : first ? first.hash.digest("hex") : sha256(Buffer.alloc(0));
    return { bytes: Buffer.concat(ranges.map(range => readRange(fd, range))), size, sha256: digest, ranges, prefixSha256 };
  });
}

const DENIED = new Set(["EACCES", "EPERM"]);
function attempt(read: () => Taken | undefined): Taken | undefined | { denied: string } {
  try { return read(); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== undefined && DENIED.has(code)) return { denied: code };
    throw error;
  }
}
const captured = (input: ArchiveInput): input is Extract<ArchiveInput, { sha256: string }> => "sha256" in input;

function record(stage: string, path: string, source: string, selection: Selection, taken: Taken | undefined | { denied: string }): ArchiveInput {
  if (!taken) return { path, source, selection, missing: true };
  if ("denied" in taken) return { path, source, selection, denied: taken.denied };
  mkdirSync(dirname(join(stage, path)), { recursive: true });
  writeFileSync(join(stage, path), taken.bytes);
  return { path, source, selection, sourceSize: taken.size, sourceSha256: taken.sha256, sha256: sha256(taken.bytes),
    ...taken.ranges ? { ranges: taken.ranges } : {}, ...taken.prefixSha256 ? { prefixSha256: taken.prefixSha256 } : {} };
}
const walk = (path: string): string[] => !existsSync(path) ? [] : !statSync(path).isDirectory() ? [path]
  : readdirSync(path).sort().flatMap(name => walk(join(path, name)));

/** Writes `archivePath(run)` and returns it. Running it again on the same run folder writes the same archive anew. */
export function archiveRun(run: string, state: RunState, sessions: readonly string[], dataDir: string, judge: { loaded: JudgeVersion; current: JudgeVersion }): string {
  const name = basename(run);
  const stage = join(dirname(run), `${name}.evidence-stage`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  const at = rootsUnder(".");
  const live = { ...inputRoots(), dataDir };
  const inputs: ArchiveInput[] = [];
  const keep = (path: string, source: string, selection: Selection, read: () => Taken | undefined): ArchiveInput => {
    const input = record(stage, normalize(path), source, selection, attempt(read));
    inputs.push(input);
    return input;
  };
  const unread = (input: ArchiveInput): { missing?: true; denied?: true } => "missing" in input ? { missing: true } : "denied" in input ? { denied: true } : {};
  for (const file of walk(run)) keep(join(name, relative(run, file)), file, "whole file", () => whole(file));

  const ids = new Set(sessions);
  const held = new Map<string, ArchivedSession>();
  const kept = new Set<string>();
  const scan: string[] = [];
  const keepWhole = (files: readonly string[], kind: (id: string) => ArchivedSession["kind"]): void => {
    for (const file of files) {
      if (kept.has(file)) continue;
      kept.add(file);
      const input = keep(join(at.primeDir, relative(PRIME_DIR, file)), file, "whole file", () => whole(file));
      if (captured(input)) scan.push(join(stage, input.path));
      const id = basename(file, ".jsonl");
      if ((dirname(file) === join(PRIME_DIR, "sessions") || UUID.test(id)) && !held.has(id)) held.set(id, { id, kind: kind(id), ...unread(input) });
    }
  };
  keepWhole([...ids].flatMap(sessionFiles), id => ids.has(id) ? "run" : "descendant");
  const pending = new Set<string>();
  const collect = (): void => {
    for (const file of scan.splice(0)) for (const event of readSessionFile(file)) if (event.kind === "text" && event.fromId && !held.has(event.fromId)) pending.add(event.fromId);
  };
  const senderFile = (id: string): string => join(PRIME_DIR, "sessions", `${id}.jsonl`);
  const headers = new Map<string, ReturnType<typeof attempt>>();
  const header = (id: string): ReturnType<typeof attempt> => {
    if (!headers.has(id)) headers.set(id, attempt(() => headerLine(senderFile(id))));
    return headers.get(id);
  };
  collect();
  for (let grew = true; grew;) {
    grew = false;
    const owned = new Set([...held.values()].filter(session => session.kind !== "sender header").map(session => session.id));
    for (const id of pending) {
      const line = header(id);
      const parent = line && !("denied" in line) ? headerParent(line.bytes.toString("utf8")) : undefined;
      if (parent === undefined || !owned.has(parent)) continue;
      pending.delete(id);
      keepWhole(sessionFiles(id), () => "descendant");
      grew = true;
    }
    collect();
  }
  for (const id of pending) {
    const input = record(stage, join(at.primeDir, "sessions", `${id}.jsonl`), senderFile(id), "header line", header(id));
    inputs.push(input);
    held.set(id, { id, kind: "sender header", ...unread(input) });
  }
  for (const id of ids) if (!held.has(id)) held.set(id, { id, kind: "run", missing: true });

  keep(serviceLogFile(at), serviceLogFile(live), "window slice", () => serviceLogSlice(serviceLogFile(live), state.windowStart, state.until));
  keep(pushesFile(at), pushesFile(live), "whole file", () => whole(pushesFile(live)));
  keep(trainFile(at.home), trainFile(live.home), "whole file", () => whole(trainFile(live.home)));
  for (const chat of [state.chat.id, ...state.control ? [state.control.id] : []]) {
    const dir = precheckDir(live, chat);
    for (const file of existsSync(dir) ? readdirSync(dir).filter(file => /^checkin-.*\.flagged\.md$/.test(file)).sort() : [])
      keep(join(precheckDir(at, chat), file), join(dir, file), "whole file", () => whole(join(dir, file)));
  }

  const chats = new Set([state.chat.id, state.chat.name, ...state.control ? [state.control.id, state.control.name] : []]);
  const registry = join(dataDir, "chat-jobs.json");
  const jobs = existsSync(registry) ? readJson<{ jobs?: Record<string, { chat: string; chatId?: string }> }>(registry).jobs ?? {} : {};
  writeFileSync(join(stage, "ownership.json"), JSON.stringify({ jobs: Object.fromEntries(Object.entries(jobs).filter(([key, entry]) =>
    ids.has(key) || key in state.fixtures || chats.has(entry.chat) || (entry.chatId !== undefined && chats.has(entry.chatId)))) }, null, 1));
  writeFileSync(join(stage, "identity.jsonl"), deliveries(join(run, "service.log")).map(line => JSON.stringify(line) + "\n").join(""));
  for (const box of ["agent-outbox", "outbox"]) {
    const dir = join(dataDir, box);
    for (const file of existsSync(dir) ? readdirSync(dir).filter(file => file.endsWith(".json")) : []) {
      let threadId: unknown;
      try { threadId = readJson<{ threadId?: unknown }>(join(dir, file)).threadId; } catch { continue; }
      if (typeof threadId === "string" && ids.has(threadId)) { mkdirSync(join(stage, "outbox", box), { recursive: true }); cpSync(join(dir, file), join(stage, "outbox", box, file)); }
    }
  }
  const verdicts = readdirSync(dirname(run)).filter(file => file.startsWith(`${name}.`) && file.endsWith(".md"));
  mkdirSync(join(stage, "verdicts"), { recursive: true });
  for (const file of verdicts) cpSync(join(dirname(run), file), join(stage, "verdicts", file));
  const manifest: ArchiveManifest = { run, scenario: state.scenario, chat: state.chat, windowStart: state.windowStart, ...state.until !== undefined ? { until: state.until } : {},
    archivedAt: Date.now(), criteria: { file: `${name}/criteria.md`, sha256: fileSha256(join(run, "criteria.md")) }, judge, sessions: [...held.values()], verdicts, liveRoots: live, inputs };
  writeFileSync(join(stage, "archive.json"), JSON.stringify(manifest, null, 1));
  const out = archivePath(run);
  execFileSync("tar", ["-czf", `${out}.part`, "-C", stage, "."]);
  renameSync(`${out}.part`, out);
  rmSync(stage, { recursive: true, force: true });
  return out;
}

/** The line under each verdict that names the judge that wrote it, the criteria it read and the window end. */
export function judgeFooter(judge: JudgeVersion, loaded: JudgeVersion, criteriaSha: string, until: number | undefined): string {
  const by = judge.sha256 === loaded.sha256 ? `Judged by sieun-pi ${short(judge)}` :
    `Judged by sieun-pi ${short(judge)} in a fresh process, since the process that asked had loaded the older ${short(loaded)}`;
  return `\n${by}, on criteria sha256 ${criteriaSha.slice(0, 12)} and window end ${until === undefined ? "unset" : new Date(until).toISOString()}.\n`;
}

function isPlainRelative(path: string): boolean {
  return !isAbsolute(path) && normalize(path) === path && !path.split("/").includes("..");
}
function checkDeclared(root: string, inputs: readonly ArchiveInput[], folders: readonly string[], what: string): void {
  const declared = new Set(inputs.map(input => input.path));
  for (const input of inputs) {
    if (!isPlainRelative(input.path)) throw new Error(`${what} declares ${input.path}, which is not a plain relative path`);
    const file = join(root, input.path);
    if (!captured(input)) { if (existsSync(file)) throw new Error(`${what} declares ${input.path} ${"denied" in input ? "denied" : "missing"} but holds it`); continue; }
    const found = fileSha256(file);
    if (found !== input.sha256) throw new Error(`${what} holds ${input.path} with sha256 ${found}, not the ${input.sha256} it declares`);
  }
  for (const folder of folders) for (const file of walk(join(root, folder))) {
    if (!declared.has(relative(root, file))) throw new Error(`${what} holds ${relative(root, file)}, which it does not declare`);
  }
}

function archiveHolds(archive: string): Set<string> {
  return new Set(execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).split("\n").map(path => path.replace(/^\.\//, ""))
    .filter(path => path && !path.endsWith("/")).map(path => path.startsWith("prime/") ? join(rootsUnder(".").primeDir, path.slice("prime/".length)) : path));
}
type StoredManifest = Omit<ArchiveManifest, "inputs" | "sessions" | "liveRoots"> & { inputs?: ArchiveInput[]; liveRoots?: InputRoots };

/**
 * Writes `out`, a supplement to `archive`: supplement.json and each file at its path under home/. Each file's bytes must be what its source
 * holds now, the whole file or the concatenation of its `ranges`, and no path may be one the archive declares or holds. A supplement adds an
 * input an archive lacks, such as the service.log slice of an archive sealed before 10-25, and rejudge takes it with `--supplement`.
 */
export function sealSupplement(archive: string, out: string, why: string, files: readonly SupplementFile[]): string {
  if (resolve(out) === resolve(archive)) throw new Error(`a supplement never overwrites its archive ${archive}`);
  const manifest = JSON.parse(execFileSync("tar", ["-xOzf", archive, "./archive.json"], { encoding: "utf8" })) as StoredManifest;
  const taken = new Set([...archiveHolds(archive), ...(manifest.inputs ?? []).map(input => input.path)]);
  const inputs: ArchiveInput[] = [];
  const stage = `${out}.stage-${process.pid}`;
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  try {
    for (const file of files) {
      if (!isPlainRelative(file.path) || !file.path.startsWith("home/")) throw new Error(`a supplement file goes under home/, not at ${file.path}`);
      if (taken.has(file.path)) throw new Error(`${file.path} is in ${archive} or this supplement already`);
      taken.add(file.path);
      if (!existsSync(file.source)) throw new Error(`the source ${file.source} of ${file.path} does not exist`);
      const bytes = Buffer.from(file.bytes);
      const read = withFile(file.source, (fd, size) => {
        const ranges = file.ranges?.map(range => ({ ...range }));
        const expected = ranges ? Buffer.concat(ranges.map(range => readRange(fd, range))) : readRange(fd, { start: 0, end: size });
        if (!expected.equals(bytes)) throw new Error(`the bytes for ${file.path} are not ${ranges ? "the given ranges" : "all"} of ${file.source}`);
        const end = Math.max(0, ...(ranges ?? []).map(range => range.end));
        return { bytes, size, sha256: hashFile(fd, size), ...ranges ? { ranges, prefixSha256: hashFile(fd, end) } : {} };
      });
      inputs.push(record(stage, file.path, file.source, file.selection, read));
    }
    const supplement: SupplementManifest = { archive: { path: resolve(archive), sha256: fileSha256(archive) }, criteria: { sha256: manifest.criteria.sha256 },
      windowStart: manifest.windowStart, ...manifest.until !== undefined ? { until: manifest.until } : {}, createdAt: Date.now(), why, inputs };
    writeFileSync(join(stage, "supplement.json"), JSON.stringify(supplement, null, 1));
    execFileSync("tar", ["-czf", `${out}.part`, "-C", stage, "."]);
    renameSync(`${out}.part`, out);
    return out;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function laySupplement(work: string, file: string, archive: string, manifest: StoredManifest, unpack: string): { file: string; sha256: string; why: string } {
  rmSync(unpack, { recursive: true, force: true });
  mkdirSync(unpack, { recursive: true });
  execFileSync("tar", ["-xzf", file, "-C", unpack]);
  const supplement = readJson<SupplementManifest>(join(unpack, "supplement.json"));
  const what = `supplement ${file}`;
  if (supplement.archive.sha256 !== fileSha256(archive)) throw new Error(`${what} extends an archive with sha256 ${supplement.archive.sha256}, not ${archive}`);
  if (supplement.criteria.sha256 !== manifest.criteria.sha256) throw new Error(`${what} names criteria sha256 ${supplement.criteria.sha256}, not the archive's ${manifest.criteria.sha256}`);
  if (supplement.windowStart !== manifest.windowStart || supplement.until !== manifest.until) throw new Error(`${what} names another window than the archive's`);
  checkDeclared(unpack, supplement.inputs, readdirSync(unpack).filter(name => name !== "supplement.json"), what);
  const declared = new Set((manifest.inputs ?? []).map(input => input.path));
  for (const input of supplement.inputs) {
    if (!captured(input) || !input.path.startsWith("home/")) throw new Error(`${what} declares ${input.path}, and a supplement holds only files under home/`);
    if (declared.has(input.path) || existsSync(join(work, input.path))) throw new Error(`${what} adds ${input.path}, which the archive or an earlier supplement already has`);
    mkdirSync(dirname(join(work, input.path)), { recursive: true });
    renameSync(join(unpack, input.path), join(work, input.path));
  }
  return { file, sha256: fileSha256(file), why: supplement.why };
}

/**
 * Where a path stored in an archived run.json points inside the archive unpacked at `work`: into its run folder, or under the live root the
 * inputs were read from, mapped to the same place under home/. Any other absolute path maps under unsealed/, which an archive never holds, so a
 * judge that follows it reads nothing and leaves its criterion unknown.
 */
export function sealedPath(path: string, work: string, run: string, liveRoots: InputRoots | undefined): string {
  const roots = rootsUnder(work);
  const pairs: [string, string][] = [[run, join(work, basename(run))],
    ...liveRoots ? [[liveRoots.dataDir, roots.dataDir], [liveRoots.primeDir, roots.primeDir], [liveRoots.home, roots.home]] as [string, string][] : []];
  const match = pairs.filter(([live]) => path === live || path.startsWith(`${live}/`)).sort((a, b) => b[0].length - a[0].length)[0];
  return match ? join(match[1], relative(match[0], path)) : join(work, "unsealed", path);
}
const sealPaths = (value: unknown, seal: (path: string) => string): unknown => typeof value === "string" ? isAbsolute(value) && !/\s/.test(value) ? seal(value) : value
  : Array.isArray(value) ? value.map(item => sealPaths(item, seal))
  : typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sealPaths(item, seal)])) : value;

/**
 * Judges an archived run again with the judge of `script`, a current clean-room.ts. It unpacks the archive next to itself, checks the criteria
 * and every declared input against its sha256, lays each supplement over it, and runs the judge with CLEAN_ROOM_INPUT_ROOT and HOME at the
 * unpacked copy and no AGENT_CHAT_DATA_DIR, with every absolute path in run.json moved into the copy by `sealedPath`, so it reads the
 * archive and nothing live, and with its clock pinned at the window end. An archive
 * from before 10-25 kept only its session files, under prime/, so its service.log and pushes read as missing and their criteria stay open.
 * It writes `<run name>.rejudged-<commit>.<verdict>.md` next to the archive, marked `-with-supplement-<id>` when supplements were laid.
 */
export async function rejudge(archive: string, script: string, judge: JudgeVersion, supplements: readonly string[] = []): Promise<{ verdict: Verdict; file: string }> {
  const work = `${archive}.rejudge-${process.pid}`;
  const unpacks = supplements.map((_, index) => `${work}.supplement-${index}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    execFileSync("tar", ["-xzf", archive, "-C", work]);
    const manifest = readJson<StoredManifest>(join(work, "archive.json"));
    const criteria = fileSha256(join(work, manifest.criteria.file));
    if (criteria !== manifest.criteria.sha256) throw new Error(`the archived criteria read sha256 ${criteria}, not the ${manifest.criteria.sha256} the run was judged on`);
    const roots = rootsUnder(work);
    if (manifest.inputs) checkDeclared(work, manifest.inputs, ["home", basename(manifest.run)], `the archive ${archive}`);
    else if (existsSync(join(work, "prime"))) { mkdirSync(dirname(roots.primeDir), { recursive: true }); renameSync(join(work, "prime"), roots.primeDir); }
    const added = supplements.map((file, index) => laySupplement(work, resolve(file), archive, manifest, unpacks[index]!));
    const run = join(work, basename(manifest.run));
    const state = join(run, "run.json");
    if (existsSync(state)) writeFileSync(state, JSON.stringify(sealPaths(readJson<unknown>(state), path => sealedPath(path, work, manifest.run, manifest.liveRoots))));
    const now = new Date(manifest.until ?? manifest.archivedAt).toISOString();
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "AGENT_CHAT_DATA_DIR")), [INPUT_ROOT_ENV]: work, HOME: roots.home };
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", script, "judge", "--run", run, "--now", now], { cwd: judge.root, env });
    const { verdict, text } = JSON.parse(stdout.trimEnd().split("\n").at(-1) ?? "") as { verdict: Verdict; text: string };
    const marker = added.length ? `-with-supplement-${sha256(Buffer.from(added.map(supplement => supplement.sha256).join("\n"))).slice(0, 8)}` : "";
    const file = join(dirname(archive), `${basename(manifest.run)}.rejudged-${judge.commit.slice(0, 12)}${marker}.${verdict}.md`);
    const laid = added.map(supplement => `\nWith supplement ${supplement.file} (sha256 ${supplement.sha256.slice(0, 12)}): ${supplement.why}`).join("");
    writeFileSync(file, `${text.replaceAll(run, manifest.run)}\nRejudged from ${archive}.${laid}${judgeFooter(judge, judge, criteria, manifest.until)}`);
    return { verdict, file };
  } finally {
    for (const dir of [work, ...unpacks]) rmSync(dir, { recursive: true, force: true });
  }
}
