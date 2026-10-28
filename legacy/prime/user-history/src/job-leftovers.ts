import { spawn } from "node:child_process";
import { hostExecFile } from "./spawn-host.ts";
import { existsSync } from "node:fs";
import { appendFile, lstat, mkdir, open, readdir, readFile, readlink, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, normalize, relative } from "node:path";
import { loadHosts, selfHost, type Host } from "./hosts.ts";
import { jobFolders } from "./chat-brief.ts";
import { wikiContentDir } from "./chat-wiki.ts";
import type { RawProcess } from "./mac-usable-watch.ts";
import { stopOrphanServices } from "./orphan-services.ts";
import { removeTree, walkTree } from "./walk-tree.ts";
import { isMain } from "./main-module.ts";

/**
 * What a job leaves behind once it is gone, and the stop of it. On 10-15 at 00:45Z a deleted job's nohup'd runner.py went on to start a 30 GB
 * script, and on 10-16 at 01:40Z two `message-limit-check.py wait-start` waiters of a chat whose kernel had died still ran, and the Aside
 * browser held tabs whose jobs were gone; the delete notice only named the processes and asked the chat to stop them. Now the service stops them
 * itself: every process that carries the RLM_HARNESS_STATE_DIR of the job's session or of a session under it (its subagents) and sits under no
 * kernel and no Prime process (worker-footprint.py `strays`), and every Aside tab those sessions opened (`aside-browser-tabs.json` in their
 * session folders). Shared services (PM2, Aside, cua-driver) and Prime's own processes are never named, so ops guy's pm2 dev servers stay.
 * It also deletes the repo copies a job left in its wiki session folders and the kernel-state.dill files and repo copies its sessions left in
 * their own session-artifacts folders. It never deletes a path or signals a process only because a transcript names it or a process's
 * arguments name the path: on 10-19 the job end deleted ~/scratch/retire-2547, release-fold and saved-session-archive, whose evidence the chat
 * still read, and at 02:06Z the end of job metal agent verification deleted the shared ~/scratch/release-applied and SIGTERMed four release
 * processes of other jobs (3085180, 3469500, 3567932, 3850115) that ran the release helper from it under systemd-run.
 * It also stops the scopes of the services its sessions handed off before their kernels were freed.
 */

/** HOME is read at each call, so a test that points HOME at a temp folder writes there even when an earlier file in its process loaded this module. */
export const artifactsRoot = (): string => join(homedir(), ".prime", "agent", "session-artifacts");
const HELPER = new URL("./worker-footprint.py", import.meta.url).pathname;
/** SIGTERM first, then SIGKILL after this long if the same process still runs (the owner's 10-15 ask: "SIGTERM, then SIGKILL after 10 s"). */
export const KILL_AFTER_MS = 10_000;
const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;
const TABS_FILE = "aside-browser-tabs.json";

/**
 * `units` are the transient units the job's record names and the scopes of services its sessions handed off before their kernels were freed
 * (`orphan-services.ts`), both stopped. `elsewhere` are the units a record named on a box with no systemd (the Mac), which a Mac job started
 * on us-metal02 over ssh, for the box that runs them to stop (`hostLeftovers`). `away` are the paths the records name on other boxes by host
 * name, and `sessions` the ended session ids, so the box that ran this end over ssh deletes its own share and their `~/scratch/<session id>`.
 */
export interface Leftovers { stopped: readonly RawProcess[]; tabs: number; copies: readonly string[]; artifacts: readonly string[]; owned: readonly string[]; units: readonly string[];
  elsewhere?: readonly string[]; away?: Readonly<Record<string, readonly string[]>>; sessions?: readonly string[];
  /** The recorded paths kept for good and dropped from their records, each with its reason (`endOwned`, `removeFree`). */
  kept?: readonly string[];
  /** The Docker containers removed because they bind-mounted a path this end deleted (`removeFree`). */
  containers?: readonly string[] }
/** A process that runs in or holds a /tmp tree (worker-footprint.py `--inside`): the session it carries (none for the rig's own processes), whether it is Prime outside the rig, or a shared service. */
export interface InsideProcess extends RawProcess { dir: string; session: string | null; prime: boolean; shared: boolean }
export interface LeftoverSource {
  /** The detached processes of these sessions (worker-footprint.py `--session`). */
  strays: (sessions: readonly string[]) => Promise<readonly RawProcess[]>;
  /** A process's start time in epoch seconds, null when it is gone. */
  started: (pid: number) => Promise<number | null>;
  kill: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  /** Closes the Aside tabs among these target ids that are still open; returns how many it closed. */
  closeTabs: (ids: readonly string[]) => Promise<number>;
  later: (ms: number, run: () => void) => void;
  /** Deletes the repo copies left in the wiki session folders these transcripts opened (`removeRepoCopies`); returns the folders it deleted. */
  removeCopies: (transcripts: readonly string[]) => Promise<readonly string[]>;
  /** The processes that run in or hold these dirs (worker-footprint.py `--inside`). */
  inside: (dirs: readonly string[]) => Promise<readonly InsideProcess[]>;
  /** Deletes these dirs; returns the ones it deleted. */
  removeTmp: (dirs: readonly string[]) => Promise<readonly string[]>;
  /** Removes the running Docker containers that bind-mount one of these dirs or a path below it (`mountedIn`); returns their names. */
  stopContainers: (dirs: readonly string[]) => Promise<readonly string[]>;
  /**
   * Stops these user units where they are active and transient (`systemd-run`), so a recorded unit file such as the chat service never stops;
   * returns the ones it stopped, or null on a box with no systemd, where the units run on another box.
   */
  stopUnits: (units: readonly string[]) => Promise<readonly string[] | null>;
  /** Writes an ownership record back (`endOwned`). */
  writeOwned: (file: string, record: OwnedRecord) => Promise<void>;
  /** The repo copies the sessions of these transcripts left in their own session folders (`artifactCopies`). */
  artifactCopies: (transcripts: readonly string[]) => Promise<readonly string[]>;
  /** The kernel-state.dill files of the sessions of these transcripts (`kernelStates`). */
  kernelStates: (transcripts: readonly string[]) => Promise<readonly string[]>;
  /** Stops the scopes of the services these sessions handed off and removes their records (`stopOrphanServices`); returns the units. */
  stopServices: (sessions: readonly string[]) => Promise<readonly string[]>;
}

/**
 * The folder where the aside-browser skill keeps its tab records, one `<sha1 of owner>.json` per agent session: `{"owner": <RLM_SESSION_DIR>,
 * "tabs": {<targetId>: <url>}}` (skills/aside-browser `_registry_path`). The skill moved its records here from `aside-browser-tabs.json` in the
 * session folder on 10-18 (ea2c0a4c), and the job end read only that old file, so 1,949 job ends in the us-metal02 service log up to 10-28 00:12Z
 * all closed 0 Aside tabs, and finished jobs kept their tabs open in the owner's Aside (32 renderers at 4.9 GB on 10-27 at 23:36Z).
 */
export const asideOwnersDir = (): string => process.env.ASIDE_BROWSER_STATE || join(homedir(), ".local", "state", "aside-browser", "owners");

/** The tab ids and record files in `asideOwnersDir` whose owner is one of these session folders or a folder under one (its subagents). */
export async function ownerTabRecords(dirs: readonly string[], folder = asideOwnersDir()): Promise<{ tabs: string[]; files: string[] }> {
  const tabs: string[] = [];
  const files: string[] = [];
  for (const name of await readdir(folder).catch(() => [] as string[])) {
    if (!name.endsWith(".json")) continue;
    const file = join(folder, name);
    const record = await readFile(file, "utf8").then(text => JSON.parse(text) as { owner?: unknown; tabs?: unknown }, () => null);
    const owner = typeof record?.owner === "string" ? record.owner : "";
    if (!owner || !dirs.some(dir => owner === dir || owner.startsWith(dir + "/"))) continue;
    const ids = record && typeof record.tabs === "object" && record.tabs ? Object.keys(record.tabs) : [];
    if (ids.length) { tabs.push(...ids); files.push(file); }
  }
  return { tabs, files };
}

/** The session ids, transcripts, Aside tab ids, tab record files and ownership records (`OWNED_FILE`) of a session folder and every folder under it (its subagents). */
export async function sessionTree(dir: string): Promise<{ sessions: string[]; transcripts: string[]; tabs: string[]; tabFiles: string[]; ownedFiles: string[] }> {
  const sessions: string[] = [];
  const transcripts: string[] = [];
  const tabs: string[] = [];
  const tabFiles: string[] = [];
  const ownedFiles: string[] = [];
  for await (const entry of walkTree(dir)) {
    if (!entry.isFile()) continue;
    if (SESSION_FILE.test(entry.name)) {
      sessions.push(entry.name.slice(0, -".jsonl".length));
      transcripts.push(join(entry.parentPath, entry.name));
    }
    else if (entry.name === OWNED_FILE) ownedFiles.push(join(entry.parentPath, entry.name));
    else if (entry.name === TABS_FILE) {
      const file = join(entry.parentPath, entry.name);
      const record = await readFile(file, "utf8").then(text => JSON.parse(text) as { tabs?: unknown }, () => null);
      const ids = record && typeof record.tabs === "object" && record.tabs ? Object.keys(record.tabs) : [];
      if (ids.length) { tabs.push(...ids); tabFiles.push(file); }
    }
  }
  return { sessions, transcripts, tabs, tabFiles, ownedFiles };
}

/**
 * A session's ownership record, `owned.json` in its RLM_SESSION_DIR, which board.own() writes: `{"paths": [...], "units": [...], "hosts":
 * {"<host>": [...]}}`, the paths and the systemd user units the session made to throw away, and the paths it made on another box over ssh,
 * written `~/...` or `/tmp/...` for that box's own home. A job's end deletes and stops only what these records name, since a path a
 * transcript or a process's arguments only name proves no owner: on 10-19 at 02:06Z the end of job metal agent verification deleted the shared
 * ~/scratch/release-applied and SIGTERMed four release processes of other jobs that ran a helper from it.
 */
export const OWNED_FILE = "owned.json";
/**
 * The folders an owned path must lie strictly below; a path in the home folder must lie below one of them there, even when the home lies in
 * /tmp. ~/work is one since 10-20, when 5 trees there over 0.5 GB on us-metal02 held builds and clones no record could name.
 */
export const ownedRoots = (): readonly string[] => ["/tmp", join(homedir(), "scratch"), join(homedir(), "work"), artifactsRoot()];
const UNIT = /^[A-Za-z0-9:_.@-]{1,200}\.(service|scope|timer)$/;
const HOST_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** A path on another box as a record names it: below that box's home (`~/`) or its /tmp, with no `..` part. */
const HOST_PATH = /^(~|\/tmp)\/(?!.*(^|\/)\.\.(\/|$))[^\0]+$/;

export interface OwnedRecord { paths: string[]; units: string[]; hosts?: Record<string, string[]> }

/** Whether a normalized absolute path lies strictly below an `ownedRoots` folder, outside every session folder and away from `dirs` and anything above them. */
function ownable(path: string, dirs: readonly string[]): boolean {
  const roots = ownedRoots();
  const artifacts = artifactsRoot();
  return roots.some(root => path.startsWith(root + "/")) &&
    (!path.startsWith(homedir() + "/") || roots.some(root => root.startsWith(homedir() + "/") && path.startsWith(root + "/"))) &&
    !(path.startsWith(artifacts + "/") && SESSION_DIR.test(path.slice(artifacts.length + 1).split("/")[0]!)) &&
    !dirs.some(dir => dir === path || dir.startsWith(path + "/"));
}

/** The paths another box's record names for this box (`OwnedRecord.hosts`), resolved against this home, that `readOwned` would take. */
export function hostPaths(paths: readonly string[]): string[] {
  return [...new Set(paths.filter(path => HOST_PATH.test(path)).map(path => normalize(path.startsWith("~/") ? join(homedir(), path.slice(2)) : path)
    .replace(/\/+$/, "")).filter(path => ownable(path, [])))];
}

/**
 * The record's paths that lie strictly below an `ownedRoots` folder, outside every session folder of session-artifacts and away from `dirs`
 * and anything above them, its units with a unit name, and its paths on other boxes by host name; anything else in the file is dropped.
 */
export async function readOwned(file: string, dirs: readonly string[] = []): Promise<OwnedRecord> {
  const record = await readFile(file, "utf8").then(text => JSON.parse(text) as { paths?: unknown; units?: unknown; hosts?: unknown }, () => null);
  const list = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  const paths = list(record?.paths).filter(path => path.startsWith("/")).map(path => normalize(path).replace(/\/+$/, "")).filter(path => ownable(path, dirs));
  const hosts = Object.fromEntries(Object.entries(record?.hosts && typeof record.hosts === "object" ? record.hosts : {})
    .filter(([host]) => HOST_NAME.test(host)).map(([host, value]): [string, string[]] => [host, [...new Set(list(value).filter(path => HOST_PATH.test(path)))]])
    .filter(([, value]) => value.length));
  return { paths: [...new Set(paths)], units: [...new Set(list(record?.units).filter(unit => UNIT.test(unit)))], ...Object.keys(hosts).length ? { hosts } : {} };
}

/** Whether `path` is a file or folder our user owns, not a symlink. */
async function ours(path: string): Promise<boolean> {
  const item = await lstat(path).catch(() => null);
  const uid = process.getuid?.();
  return !!item && !item.isSymbolicLink() && (uid === undefined || item.uid === uid);
}

/**
 * The first folder in the tree at `path` that our user cannot write, or the path itself when find cannot read the whole tree; null when every
 * folder is writable. rm stops at such a folder only after it deleted everything around it: on 10-21 at 02:06:33Z the sweep of chat 01a14210's
 * deleted jobs emptied ~/work/prime-agent-fix-p8/build-s2int1 and build-s2int2 of release/, inst/, source-rev and feed.SHA256SUMS, 40 ms
 * apart, and stopped only at their read-only feed/ folders (dr-xr-xr-x), which their maker had frozen for the jobs that still read them.
 */
function frozenFolder(path: string): Promise<string | null> {
  return new Promise(resolve => {
    hostExecFile("find", [path, "-type", "d", "!", "-perm", "-u=w", "-print", "-quit"], { maxBuffer: 1024 * 1024 }, (error, stdout) => {
      const found = String(stdout).split("\n")[0]!.trim();
      resolve(found || (error ? path : null));
    });
  });
}

/**
 * Deletes the paths our user owns that no process runs in, holds or names, and returns the ones it deleted. A tree with a folder our user
 * cannot write (`frozenFolder`) is kept whole and comes back in `kept`, since its maker froze it for readers and rm would delete all but it.
 * It first removes the Docker containers that bind-mount a path it deletes, because `inside` reads a container's processes in the container's
 * own paths and never finds the host folder: on 10-23 the sweep of Crawler VP's deleted jobs deleted /drive2/sieun/scratch/01a1694a-d619-703c-8ccf-328d37540888
 * while that job's rig j1694a-ch, j1694a-kafka and j1694a-redis ran on it, and they ran on for 20 h; at 11:45Z on 10-24 the ClickHouse used
 * 5.4 cores, 2.5 GB RAM and 0.8 GB swap and failed on its deleted parts.
 */
/**
 * A tree's real folder: its copy in `ATTIC` when `path` is the link a disk cleanup left at its old place (ops/runbooks/dev-boxes.md, "move a
 * finished tree to /drive2/scratch-attic/<same path> and leave a symlink"), or `path` itself. From 10-19 to 10-24 the p500 and box root disk
 * jobs moved 98 trees to the attic on us-metal02, and a job's end kept each one there for good, since it deletes no symlink.
 */
export const ATTIC = "/drive2/scratch-attic";
async function realFolder(path: string): Promise<string> {
  return await readlink(path).catch(() => null) === ATTIC + path ? ATTIC + path : path;
}

async function removeFree(source: Pick<LeftoverSource, "inside" | "removeTmp" | "stopContainers">, candidates: readonly string[]): Promise<{ paths: string[]; removed: readonly string[]; kept: Map<string, string>; containers: readonly string[] }> {
  const real = new Map<string, string>();
  for (const path of new Set(candidates)) {
    const folder = await realFolder(path);
    if (await ours(folder)) real.set(path, folder);
  }
  const paths = [...real.keys()];
  const back = new Map([...real].map(([path, folder]) => [folder, path]));
  const linked = paths.filter(path => real.get(path) !== path);
  const held = new Set(paths.length ? (await source.inside([...real.values(), ...linked])).map(entry => back.get(entry.dir) ?? entry.dir) : []);
  const kept = new Map<string, string>();
  for (const path of paths.filter(path => !held.has(path))) {
    const frozen = await frozenFolder(real.get(path)!);
    if (frozen) kept.set(path, `it holds the read-only folder ${frozen}`);
  }
  const free = paths.filter(path => !held.has(path) && !kept.has(path));
  const containers = free.length ? await source.stopContainers(free.map(path => real.get(path)!)).catch(() => []) : [];
  const gone = free.length ? new Set(await source.removeTmp(free.map(path => real.get(path)!))) : new Set<string>();
  const removed = free.filter(path => gone.has(real.get(path)!));
  for (const path of removed) if (real.get(path) !== path) await unlink(path).catch(() => {});
  return { paths, removed, kept, containers };
}

/** A running container as `docker inspect` prints it, with only the fields `mountedIn` reads. */
export interface DockerContainer { Name: string; Mounts?: readonly { Type: string; Source: string }[] }

/** The names of the containers with a bind mount at one of these dirs or below it. */
export function mountedIn(containers: readonly DockerContainer[], dirs: readonly string[]): string[] {
  return containers.filter(container => (container.Mounts ?? []).some(mount => mount.Type === "bind" &&
    dirs.some(dir => mount.Source === dir || mount.Source.startsWith(dir + "/")))).map(container => container.Name.replace(/^\//, ""));
}

/** When the session of the ownership record `file` began: the birth of its session folder, where Prime writes the record. */
async function recordStart(file: string): Promise<number> {
  return (await lstat(dirname(file)).catch(() => null))?.birthtimeMs ?? Infinity;
}

/**
 * Names that mark a published artifact or evidence within PUBLISHED_DEPTH of a recorded tree: a feed or release folder, an evidence folder,
 * a feed index, a checksum list, a build log or a report. On 10-21 the end of deleted job p8-detached-on-mem41 (sub-47ae7e89) deleted the
 * release/, source-rev, feed.SHA256SUMS and inst/ of ~/work/prime-agent-fix-p8/build-s2int1 and build-s2int2 and their whole .script-as-run
 * copies with build.log and sha256.txt, because the job had recorded its released builds, which other jobs installed and checked from.
 */
const PUBLISHED_FOLDER = /^(feed|feeds|release|releases|evidence.*)$/;
const PUBLISHED_FILE = /^(latest\.json|SHA256SUMS(\.txt)?|.*\.SHA256SUMS(\.txt)?|sha256\.txt|build\.log|.*\.build\.log|EVIDENCE\.md|REPORT\.md|FINDING\.md)$/;
/** How far below a recorded path the published names are looked for: build-s2int1/release/latest.json is two levels down. */
const PUBLISHED_DEPTH = 2;

/**
 * Why a job's end must keep the recorded tree at `path` that a session begun at `start` names, or null when that session made the whole tree
 * and it publishes nothing: the tree or any entry in it was born before the session began, so another maker had it first; it holds a published
 * name (`PUBLISHED_FILE`, `PUBLISHED_FOLDER`), which a git checkout's own files never count as; or a folder in it cannot be read.
 */
async function keepReason(path: string, start: number): Promise<string | null> {
  const root = await lstat(path).catch(() => null);
  if (!root) return null;
  if (!(root.birthtimeMs > 0 && root.birthtimeMs >= start)) return "it is older than the job whose record names it";
  if (!root.isDirectory()) return PUBLISHED_FILE.test(basename(path)) ? "it is a published artifact or evidence" : null;
  const checkout = existsSync(join(path, ".git"));
  const queue: { dir: string; depth: number }[] = [{ dir: path, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift()!;
    const entries = (await readdir(dir, { withFileTypes: true }).catch(() => null))?.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    if (!entries) return `it holds ${dir}, which cannot be read`;
    const stats = await Promise.all(entries.map(entry => lstat(join(dir, entry.name)).catch(() => null)));
    for (const [index, entry] of entries.entries()) {
      const file = join(dir, entry.name);
      const birth = stats[index]?.birthtimeMs;
      if (!(birth !== undefined && birth > 0 && birth >= start)) return `it holds ${file}, which is older than the job`;
      const named = entry.isDirectory() ? PUBLISHED_FOLDER.test(entry.name) : PUBLISHED_FILE.test(entry.name);
      if (!checkout && depth < PUBLISHED_DEPTH && named) return `it holds the published artifact or evidence ${file}`;
      if (entry.isDirectory()) queue.push({ dir: file, depth: depth + 1 });
    }
  }
  return null;
}

/** The ownership records under `artifactsRoot` other than `own`, read for the paths they name (`readOwned`). */
function otherRecords(own: readonly string[]): Promise<string[]> {
  const skip = new Set(own);
  return new Promise(resolve => {
    hostExecFile("find", [artifactsRoot(), "-name", OWNED_FILE, "-type", "f"], { maxBuffer: 16 * 1024 * 1024 }, async (_error, stdout) => {
      const files = String(stdout).split("\n").filter(file => file && !skip.has(file));
      const records = await Promise.all(files.map(file => readOwned(file).then(record => ({ file, paths: record.paths }))));
      resolve(records.flatMap(record => record.paths.map(path => `${path}\0${dirname(record.file)}`)));
    });
  });
}

/** The kept paths of `kept` as the log names them. */
const keptNotes = (kept: ReadonlyMap<string, string>): string[] => [...kept].map(([path, why]) => `${path}: ${why}`);

/**
 * Stops the units and deletes the paths the ownership records of gone sessions name (`readOwned`) and the scratch folders the job line gave
 * those sessions (`jobFolders`: `~/scratch/<session id>`, and `/drive2/<user>/scratch/<session id>` on us-metal02), and keeps a path any
 * process runs in, holds or names. A recorded path outside those folders is kept for good and leaves its record when another record names it, a path in it or a folder above it, or when `keepReason` finds
 * no proof that the job made the whole tree or finds a published artifact in it. A kept path stays in its
 * record or its session's folder name, so a later sweep of deleted jobs deletes it once nothing holds it. The paths the records name on other
 * boxes come back as `away` and stay in the records, for the box that runs the cleanup over ssh (`hostLeftovers`).
 */
async function endOwned(source: LeftoverSource, files: readonly string[], dirs: readonly string[], sessions: readonly string[]): Promise<{ owned: readonly string[]; units: readonly string[]; elsewhere: readonly string[]; away: Record<string, string[]>; kept: readonly string[]; containers: readonly string[] }> {
  const folders = sessions.filter(session => SESSION.test(session)).flatMap(session => jobFolders(session, homedir()));
  if (!files.length && !folders.length) return { owned: [], units: [], elsewhere: [], away: {}, kept: [], containers: [] };
  const records = await Promise.all(files.map(file => readOwned(file, dirs)));
  const wanted = [...new Set(records.flatMap(record => record.units))];
  const answer = wanted.length ? await source.stopUnits(wanted).catch(() => []) : [];
  const units = answer ?? [];
  const elsewhere = answer === null ? wanted : [];
  const unmade = new Map<string, string>();
  const recorded = records.flatMap(record => record.paths).filter(path => !folders.some(folder => path === folder || path.startsWith(folder + "/")));
  const others = recorded.length ? await otherRecords(files) : [];
  for (const entry of others) {
    const [other, owner] = entry.split("\0") as [string, string];
    for (const path of recorded) if (path === other || other.startsWith(path + "/") || path.startsWith(other + "/"))
      unmade.set(path, `the record of ${relative(artifactsRoot(), owner)} names ${other === path ? "it" : other}`);
  }
  await Promise.all(files.map(async (file, index) => {
    const start = await recordStart(file);
    for (const path of records[index]!.paths) {
      if (unmade.has(path) || !recorded.includes(path)) continue;
      const why = await keepReason(path, start);
      if (why) unmade.set(path, why);
    }
  }));
  const { paths, removed: owned, kept, containers } = await removeFree(source, [...records.flatMap(record => record.paths).filter(path => !unmade.has(path)), ...folders]);
  const gone = new Set(owned);
  const away: Record<string, string[]> = {};
  for (const record of records) for (const [host, list] of Object.entries(record.hosts ?? {})) away[host] = [...new Set([...away[host] ?? [], ...list])];
  await Promise.all(files.map(async (file, index) => {
    const record = records[index]!;
    const left = { paths: record.paths.filter(path => !gone.has(path) && !kept.has(path) && paths.includes(path)), units: [], ...record.hosts ? { hosts: record.hosts } : {} };
    await source.writeOwned(file, left).catch(() => {});
  }));
  return { owned, units, elsewhere, away, kept: keptNotes(new Map([...unmade, ...kept])), containers };
}

/**
 * The wiki session folders a transcript opened, from the answer of `POST /api/agent/sessions`, `{"id":"sessions/<day>/<hhmm-slug>","path":
 * "<id>/index.html",...}`, printed raw, as a Python dict or escaped inside a tool result.
 */
const OPENED_SESSION = /id[\\"']*\s*:\s*[\\"']*(sessions\/\d{4}\/\d{2}\/\d{2}\/\d{4}-[a-z0-9-]+)[\\"']*\s*,\s*[\\"']*path[\\"']*\s*:\s*[\\"']*\1\/index\.html/g;
/** The end of every `OPENED_SESSION` match, which the raw bytes are searched for before any of them is decoded. */
const INDEX_HTML = Buffer.from("/index.html");
/** The bytes before an `INDEX_HTML` hit that hold its match: the id and the path, each under 100 characters, with any quotes and escapes between. */
const MATCH_BYTES = 1024;
/** The transcript bytes read and searched at a time. */
export const SCAN_CHUNK = 4 * 1024 * 1024;

/**
 * The wiki session folders these transcripts opened (`OPENED_SESSION`). Each file is read in SCAN_CHUNK pieces and searched as bytes for
 * INDEX_HTML, and only the MATCH_BYTES before each hit are decoded for the pattern. Until 10-29 each file was read whole as UTF-8 and the
 * pattern ran over all of it on the main thread: the service's first sweep of deleted jobs after each start read every transcript again, and
 * in the CPU profile of 15:27 to 15:33Z on 10-28 that held the main thread 24 s, plus 10 s of decoding, in blocks of up to 579 ms, and d7 read
 * 15:31Z dirty from a 1.1 s duties read. Over the 3,199 transcripts (2.7 GB) of chat 01a1164b the old read took 11.9 s of main thread and
 * this one 1.1 s, with the same 143 folders.
 */
export async function openedWikiSessions(transcripts: readonly string[]): Promise<string[]> {
  const found = new Set<string>();
  const buffer = Buffer.allocUnsafe(MATCH_BYTES + SCAN_CHUNK);
  for (const file of transcripts) {
    const handle = await open(file, "r").catch(() => null);
    if (!handle) continue;
    try {
      // The last MATCH_BYTES of a piece stay at the buffer's start, so a match that crosses two pieces is found in the second.
      let kept = 0;
      for (let at = 0; ;) {
        const { bytesRead } = await handle.read(buffer, kept, SCAN_CHUNK, at);
        if (!bytesRead) break;
        at += bytesRead;
        const end = kept + bytesRead;
        const bytes = buffer.subarray(0, end);
        for (let hit = bytes.indexOf(INDEX_HTML); hit >= 0; hit = bytes.indexOf(INDEX_HTML, hit + 1))
          for (const match of bytes.toString("utf8", Math.max(0, hit - MATCH_BYTES), hit + INDEX_HTML.length).matchAll(OPENED_SESSION)) found.add(match[1]!);
        kept = Math.min(MATCH_BYTES, end);
        buffer.copy(buffer, 0, end - kept, end);
      }
    } catch { /* a file that cannot be read opened nothing */ } finally { await handle.close().catch(() => {}); }
  }
  return [...found];
}

/**
 * The repo copies under a wiki session folder: each folder below it that holds `.git`, `pnpm-workspace.yaml` or `scripts/repo` (a clone or a
 * `git archive` export), a bare git repo (`HEAD`, `objects` and `refs`, a `git clone --mirror`), or an `apps/<app>` with its `package.json` or
 * `pyproject.toml` (a `git archive <sha> apps/<app>` export), and each `node_modules` and `.venv`. On 10-18 the session folders held 502 such
 * copies with 1.3M of their 1.7M files, and the wiki index, `git status` and every walker paid for them. At 16:46Z, after the job line moved
 * scratch trees out, 41 app exports (1.9 GB), 3 mirrors (1.2 GB) and a `.venv` were still there, which the first three markers missed.
 */
export async function repoCopies(folder: string): Promise<string[]> {
  const copies: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      if (entry.name === "node_modules" || entry.name === ".venv") { copies.push(path); continue; }
      if (await isRepoCopy(path)) copies.push(path);
      else await walk(path);
    }
  };
  await walk(folder);
  return copies;
}

/** Whether a folder is a repo copy by the markers of `repoCopies`. */
async function isRepoCopy(path: string): Promise<boolean> {
  const inside = await readdir(path, { withFileTypes: true }).catch(() => []);
  const names = new Set(inside.map(item => item.name));
  const apps = inside.some(item => item.name === "apps" && item.isDirectory()) ? await readdir(join(path, "apps"), { withFileTypes: true }).catch(() => []) : [];
  return names.has(".git") || names.has("pnpm-workspace.yaml") ||
    inside.some(item => item.name === "scripts" && item.isDirectory() && existsSync(join(path, "scripts", "repo"))) ||
    (names.has("HEAD") && names.has("objects") && names.has("refs")) ||
    apps.some(app => app.isDirectory() && ["package.json", "pyproject.toml"].some(file => existsSync(join(path, "apps", app.name, file))));
}

/** Whether git tracks a file under this path of the wiki content (an export a job meant to keep, such as 1458-land37-staging-converge-fix/drafts/u2). A failing git counts as tracked. */
function tracked(contentDir: string, path: string): Promise<boolean> {
  return new Promise(resolve => {
    const git = spawn("git", ["-C", contentDir, "ls-files", "-z", "--", path], { stdio: ["ignore", "pipe", "ignore"] });
    let any = false;
    git.stdout.once("data", () => { any = true; git.kill(); });
    git.once("error", () => resolve(true));
    git.once("close", code => resolve(any || code !== 0 && code !== null));
  });
}

/** Deletes the untracked repo copies (`repoCopies`) in the wiki session folders the transcripts opened, and returns the folders it deleted. */
export async function removeRepoCopies(transcripts: readonly string[], contentDir = wikiContentDir(),
  isTracked: (contentDir: string, path: string) => Promise<boolean> = tracked): Promise<string[]> {
  const removed: string[] = [];
  for (const session of await openedWikiSessions(transcripts)) {
    for (const copy of await repoCopies(join(contentDir, session))) {
      if (await isTracked(contentDir, copy)) continue;
      if (await removeTree(copy)) removed.push(copy);
    }
  }
  return removed;
}

/**
 * The folders under a chat's session folder of the subagents the daemon marked deleted (`"status": "deleted"` in rlm-subagent.json). A job the
 * chat deletes itself with rlm.delete_subagent stays in the daemon's list, so this file is the one sign that it is gone: on 10-16 at 08:42Z
 * clean room chat 01a1435e deleted "tmp web server setsid", and its setsid'd http.server on 8767 and its Aside tab outlived it until a reboot.
 */
export async function deletedFolders(chatDir: string): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of walkTree(chatDir)) {
    if (!entry.isFile() || entry.name !== "rlm-subagent.json") continue;
    const record = await readFile(join(entry.parentPath, entry.name), "utf8").then(text => JSON.parse(text) as { status?: unknown }, () => null);
    if (record?.status === "deleted") found.push(entry.parentPath);
  }
  return outermost(found);
}

/**
 * The folders of `dirs` that sit inside no other of them, found by looking each folder's parents up in a set. On 10-24 at 12:26Z the pairwise
 * check this replaced held the chat's event loop 973 ms on one chat's deleted jobs, and d7 read that minute dirty.
 */
export function outermost(dirs: readonly string[]): string[] {
  const all = new Set(dirs);
  return dirs.filter(dir => {
    for (let cut = dir.lastIndexOf("/"); cut > 0; cut = dir.lastIndexOf("/", cut - 1)) if (all.has(dir.slice(0, cut))) return false;
    return true;
  });
}

/** Top-level /tmp names every session shares (caches, sockets, Prime's own dir), never one job's tree. */
export const SHARED_TMP = /^(prime-agent-\d+|tsx-\d+|node-compile-cache|v8-compile-cache-\d+|pytest-of-.+|systemd-private-.+|tmux-\d+|ssh-.+|snap-private-tmp|jiti|\.[\w-]+-unix)$/;
const KERNEL_STATE = /^kernel-state\.dill(\.[A-Za-z0-9]+\.tmp)?$/;
const SESSION_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The kernel-state.dill files of these sessions: a kernel's saved namespace, kept under its parent's `session-artifacts/<id>/`, which only a
 * resume of that session reads. On 10-18 the 4,000 subagents the daemon had deleted on us-metal02 still held 3.9 GB of them.
 */
export async function kernelStates(transcripts: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const file of transcripts) {
    const kernel = join(dirname(dirname(file)), "session-artifacts", file.slice(file.lastIndexOf("/") + 1, -".jsonl".length));
    for (const entry of await readdir(kernel).catch(() => [])) if (KERNEL_STATE.test(entry)) found.push(join(kernel, entry));
  }
  return found;
}

/**
 * The repo copies (`repoCopies`) gone sessions left in their own folders of ~/.prime/agent/session-artifacts, the folders that hold their
 * transcripts. A folder elsewhere in session-artifacts that a transcript only names is never read: on 10-19 at 02:06Z the end of job metal agent
 * verification deleted ~/scratch/release-applied, which it had named and other jobs ran their release helper from, so a named path proves no owner.
 */
export async function artifactCopies(transcripts: readonly string[]): Promise<string[]> {
  const found = new Set<string>();
  for (const file of transcripts) for (const copy of await repoCopies(dirname(file))) found.add(copy);
  return [...found];
}

/** SIGTERM to each process whose start time still matches, then SIGKILL after KILL_AFTER_MS to each one still running with that start time. */
export async function stopProcesses(source: Pick<LeftoverSource, "started" | "kill" | "later">, found: readonly RawProcess[]): Promise<RawProcess[]> {
  const stopped: RawProcess[] = [];
  for (const entry of found) {
    if (entry.pid <= 1 || entry.pid === process.pid || entry.started === null || await source.started(entry.pid) !== entry.started) continue;
    try { source.kill(entry.pid, "SIGTERM"); } catch { continue; }
    stopped.push(entry);
  }
  if (stopped.length) source.later(KILL_AFTER_MS, () => {
    void Promise.all(stopped.map(async entry => {
      if (await source.started(entry.pid).catch(() => null) === entry.started) try { source.kill(entry.pid, "SIGKILL"); } catch { /* gone */ }
    }));
  });
  return stopped;
}

/**
 * Stops what gone jobs left: their sessions' detached processes and their Aside tabs, whose records are then emptied so a later sweep does not
 * open Aside for them again, deletes the repo copies they left in the wiki session folders they opened, deletes the kernel states and repo
 * copies they left in their session-artifacts folders (`endArtifacts`), and stops the units and deletes the paths their ownership records name
 * and their own scratch folders (`endOwned`). With `session`, the processes are read again after KILL_AFTER_MS, since a kernel the daemon is
 * still ending at the delete leaves its children detached only once it exits.
 */
export async function endLeftovers(source: LeftoverSource, dirs: string | readonly string[], session?: string): Promise<Leftovers> {
  const trees = await Promise.all((typeof dirs === "string" ? [dirs] : dirs).map(sessionTree));
  const sessions = [...new Set([...(session ? [session] : []), ...trees.flatMap(tree => tree.sessions)])];
  const handed = sessions.length ? await source.stopServices(sessions).catch(() => []) : [];
  const stopped = sessions.length ? await stopProcesses(source, await source.strays(sessions)) : [];
  if (session) source.later(KILL_AFTER_MS, () => { void source.strays(sessions).then(found => stopProcesses(source, found)).catch(() => []); });
  const recorded = await ownerTabRecords(typeof dirs === "string" ? [dirs] : dirs);
  const ids = [...new Set([...trees.flatMap(tree => tree.tabs), ...recorded.tabs])];
  const tabs = ids.length ? await source.closeTabs(ids).catch(() => -1) : 0;
  if (tabs >= 0) {
    for (const file of trees.flatMap(tree => tree.tabFiles)) {
      const record = await readFile(file, "utf8").then(text => JSON.parse(text) as Record<string, unknown>, () => null);
      if (record) await writeFile(file, JSON.stringify({ ...record, tabs: {} })).catch(() => {});
    }
    for (const file of recorded.files) await unlink(file).catch(() => {});
  }
  const transcripts = trees.flatMap(tree => tree.transcripts);
  const copies = await source.removeCopies(transcripts).catch(() => []);
  const artifacts = await endArtifacts(source, transcripts).catch(() => []);
  const owned = await endOwned(source, trees.flatMap(tree => tree.ownedFiles), typeof dirs === "string" ? [dirs] : dirs, sessions).catch(() => ({ owned: [], units: [], elsewhere: [], away: {}, kept: [], containers: [] }));
  return { stopped, tabs: Math.max(tabs, 0), copies, artifacts, owned: owned.owned, units: [...handed, ...owned.units], ...owned.elsewhere.length ? { elsewhere: owned.elsewhere } : {},
    ...Object.keys(owned.away).length ? { away: owned.away } : {}, ...sessions.length ? { sessions } : {}, ...owned.kept.length ? { kept: owned.kept } : {},
    ...owned.containers.length ? { containers: owned.containers } : {} };
}

/** Deletes the kernel-state.dill files and the repo copies gone sessions left in session-artifacts, and keeps a copy any process runs in or holds. */
async function endArtifacts(source: LeftoverSource, transcripts: readonly string[]): Promise<readonly string[]> {
  const [copies, states] = await Promise.all([source.artifactCopies(transcripts), source.kernelStates(transcripts)]);
  const held = new Set(copies.length ? (await source.inside(copies)).map(entry => entry.dir) : []);
  const free = [...states, ...copies.filter(copy => !held.has(copy))];
  return free.length ? source.removeTmp(free) : [];
}

function helper(args: readonly string[], input = ""): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = hostExecFile("/usr/bin/python3", ["-B", HELPER, ...args], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) { reject(error); return; }
      try { resolve(JSON.parse(stdout) as unknown); } catch (failure) { reject(failure); }
    });
    child.stdin?.end(input);
  });
}

/** Runs `docker` with these arguments: whether it exited 0, and its trimmed stdout; a box with no docker reads as a failed run. */
function docker(args: readonly string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise(resolve => {
    hostExecFile("docker", [...args], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => resolve({ ok: !error, output: String(stdout).trim() }));
  });
}

/** The running Docker containers as `docker inspect` prints them; none on a box with no docker. */
async function runningContainers(): Promise<DockerContainer[]> {
  const ids = (await docker(["ps", "-q"])).output.split("\n").filter(Boolean);
  const listed = ids.length ? await docker(["inspect", ...ids]) : null;
  return listed?.ok ? JSON.parse(listed.output) as DockerContainer[] : [];
}

/** Runs `systemctl --user` with these arguments: whether it exited 0, and its trimmed stdout. */
function systemctl(args: readonly string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise(resolve => {
    hostExecFile("systemctl", ["--user", ...args], { maxBuffer: 1024 * 1024 }, (error, stdout) => resolve({ ok: !error, output: String(stdout).trim() }));
  });
}

/**
 * Closes Aside tabs with a one-shot `aside repl`: each still open tab is attached and gets page.close({runBeforeUnload: true}), which sends CDP
 * Page.close, and the count is what the next list no longer shows within 5 s (on 10-17 at 20:39Z, under load, a 500 ms look counted 0 for a tab
 * that did close). closeTab closes only a tab its own REPL session opened; from another session it only lets the tab go (tried 10-16 01:5xZ
 * through both `aside repl` and `aside mcp`, and again on 10-28 by the aside job tabs job), and a gone job's session is gone.
 */
export function closeAsideTabs(ids: readonly string[], cli = process.env.ASIDE_CLI ?? join(homedir(), ".local", "bin", "aside")): Promise<number> {
  const code = `const __leftoverIds = ${JSON.stringify(ids)}; const __leftoverOpen = new Set((await listBrowserTabs()).map(tab => tab.targetId));
for (const id of __leftoverIds) if (__leftoverOpen.has(id)) { const tab = await attachBrowserTab(id); await tab.close({ runBeforeUnload: true }).catch(() => {}); }
let __leftoverLeft = new Set(); for (let i = 0; i < 20; i++) { await sleep(250); __leftoverLeft = new Set((await listBrowserTabs()).map(tab => tab.targetId)); if (!__leftoverIds.some(id => __leftoverLeft.has(id))) break; }
console.log("LEFTOVER_CLOSED " + __leftoverIds.filter(id => __leftoverOpen.has(id) && !__leftoverLeft.has(id)).length);`;
  return new Promise((resolve, reject) => {
    hostExecFile(cli, ["repl", code], { timeout: 130_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const closed = /LEFTOVER_CLOSED (\d+)/.exec(stdout);
      if (closed) resolve(Number(closed[1]));
      else reject(error ?? new Error(`aside repl: ${(stdout + stderr).slice(0, 300)}`));
    });
  });
}

/** Transcripts whose wiki session folders and session-artifacts copies were already cleared, so the sweep of deleted jobs reads each transcript once. */
const copiesCleared = new Set<string>();
const artifactsCleared = new Set<string>();

/** The real source: the footprint helper, process.kill, `aside repl`, timers that do not hold the service open and `removeRepoCopies`. */
export const leftoverSource: LeftoverSource = {
  strays: async sessions => {
    const answer = await helper(["--session", sessions.join(",")]) as { strays?: RawProcess[] };
    return Array.isArray(answer?.strays) ? answer.strays : [];
  },
  started: async pid => { const answer = await helper(["--started", String(pid)]); return typeof answer === "number" ? answer : null; },
  kill: (pid, signal) => { process.kill(pid, signal); },
  closeTabs: ids => closeAsideTabs(ids),
  later: (ms, run) => { setTimeout(run, ms).unref(); },
  removeCopies: transcripts => {
    const fresh = transcripts.filter(file => !copiesCleared.has(file));
    for (const file of fresh) copiesCleared.add(file);
    return removeRepoCopies(fresh);
  },
  inside: async dirs => {
    const answer = await helper(["--inside"], dirs.join("\n") + "\n") as { inside?: InsideProcess[] };
    return Array.isArray(answer?.inside) ? answer.inside : [];
  },
  removeTmp: async dirs => {
    const removed: string[] = [];
    for (const dir of dirs) if (await removeTree(dir)) removed.push(dir);
    return removed;
  },
  stopUnits: async units => {
    if (process.platform !== "linux") return null;
    const stopped: string[] = [];
    for (const unit of units) {
      const state = Object.fromEntries((await systemctl(["show", "-p", "ActiveState,Transient", "--", unit])).output.split("\n").map(line => line.split("=", 2)));
      if (state.Transient !== "yes" || !["active", "activating", "reloading"].includes(state.ActiveState ?? "")) continue;
      if ((await systemctl(["stop", "--", unit])).ok) stopped.push(unit);
    }
    return stopped;
  },
  stopContainers: async dirs => {
    const running = await runningContainers();
    const removed: string[] = [];
    for (const name of mountedIn(running, dirs)) if ((await docker(["rm", "-f", name])).ok) removed.push(name);
    return removed;
  },
  writeOwned: (file, record) => writeFile(file, JSON.stringify(record)),
  artifactCopies: transcripts => {
    const fresh = transcripts.filter(file => !artifactsCleared.has(file));
    for (const file of fresh) artifactsCleared.add(file);
    return fresh.length ? artifactCopies(fresh) : Promise.resolve([]);
  },
  kernelStates: transcripts => kernelStates(transcripts),
  stopServices: sessions => stopOrphanServices(sessions),
};

/** A replay serve's source (`serve --replay-daemon`): the same reads, with no kill, unit stop, tab close, delete or record write, and a tab count of -1 so no tab record is emptied. */
export const dryLeftoverSource: LeftoverSource = { ...leftoverSource, kill: () => {}, closeTabs: async () => -1, removeCopies: async () => [], removeTmp: async () => [],
  stopContainers: async () => [], stopUnits: async () => [], writeOwned: async () => {} };

/**
 * A file or folder changed this recently keeps an owner-less tree: on 10-20 at 04:00Z a disk cleanup deleted ~/scratch/crawler-lab-window-2/build-b12
 * and build-b13 of a live Crawler ops lab job, whose newest file was over 1 h old.
 */
export const UNOWNED_IDLE_MS = 2 * 60 * 60 * 1000;
/** One JSON line per tree `reapUnowned` judged: its path, its real folder, its bytes, and whether it was deleted or why it was kept. */
export const unownedLog = (): string => join(homedir(), ".local", "state", "sieun-pi", "unowned-reaped.jsonl");

export interface UnownedSource extends Pick<LeftoverSource, "inside" | "removeTmp"> {
  /** Every path an owner record on any box names for this box, with the record's folder; throws when a box's records cannot be read. */
  records: () => Promise<readonly { path: string; owner: string }[]>;
  /**
   * A file or folder in the tree at `dir` that changed at or after `since` (epoch ms), or `dir` when the tree cannot be read whole; null otherwise.
   * A path with more than one link counts by its mtime alone, since a link made or removed anywhere moves its ctime: on 10-28 one pnpm-store file
   * linked 47 times across ~/scratch/mac-run kept all 13 idle repo copies there fresh, as each delete of another copy moved the file's ctime.
   */
  written: (dir: string, since: number) => Promise<string | null>;
  /** The dirs among these that a running container bind-mounts, or a path below them. */
  mounted: (dirs: readonly string[]) => Promise<readonly string[]>;
}

/**
 * Deletes the trees under ~/scratch that no owner record on any box names and nothing uses, with their attic copy (`ATTIC`), for the leftovers
 * that the kernel's guard (sieun-rules kernel-own.py `refusal`) refuses to let any job delete, since no session family owns them. On 10-28
 * us-metal02's ~/scratch/mac-run held 56 per-job repo copies of Mac jobs from before the kernel recorded the trees it makes, 43 of them links into
 * the attic, and owner rule c193 bans such copies. A tree is kept when a record names it, a folder above it or a path in it, when it is a job's
 * own ~/scratch/<session id>, when it changed within UNOWNED_IDLE_MS, when a container mounts it, and when a process runs in, holds, maps or
 * names it or our user does not own it (`removeFree`).
 */
export async function reapUnowned(source: UnownedSource, candidates: readonly string[], now = Date.now()): Promise<{ removed: string[]; kept: Map<string, string> }> {
  const scratch = join(homedir(), "scratch");
  const paths = [...new Set(candidates.map(path => normalize(path).replace(/\/+$/, "")))];
  const kept = new Map<string, string>();
  for (const path of paths) {
    if (!path.startsWith(scratch + "/")) kept.set(path, "it is not below ~/scratch");
    else if (SESSION.test(path.slice(scratch.length + 1).split("/")[0]!)) kept.set(path, "it is a job's own ~/scratch/<session id> folder");
  }
  const records = await source.records().catch((error: unknown) => {
    for (const path of paths) if (!kept.has(path)) kept.set(path, `the owner records could not all be read: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  });
  for (const { path: named, owner } of records) for (const path of paths)
    if (!kept.has(path) && (named === path || named.startsWith(path + "/") || path.startsWith(named + "/"))) kept.set(path, `the record of ${owner} names ${named === path ? "it" : named}`);
  const real = new Map<string, string>();
  for (const path of paths.filter(path => !kept.has(path))) {
    real.set(path, await realFolder(path));
    const file = await source.written(real.get(path)!, now - UNOWNED_IDLE_MS);
    if (file) kept.set(path, `${file} changed within the last ${UNOWNED_IDLE_MS / 3_600_000} h`);
  }
  const idle = paths.filter(path => !kept.has(path));
  const mounted = new Set(idle.length ? await source.mounted(idle.map(path => real.get(path)!)) : []);
  for (const path of idle) if (mounted.has(real.get(path)!)) kept.set(path, "a running container mounts it");
  const free = idle.filter(path => !kept.has(path));
  const none: { paths: readonly string[]; removed: readonly string[]; kept: Map<string, string> } = { paths: [], removed: [], kept: new Map() };
  const { paths: ours, removed, kept: held } = free.length ? await removeFree({ ...source, stopContainers: async () => [] }, free) : none;
  for (const [path, why] of held) kept.set(path, why);
  for (const path of free) if (!removed.includes(path) && !kept.has(path)) kept.set(path, ours.includes(path) ? "a process runs in, holds or names it" : "our user does not own it");
  return { removed: [...removed], kept };
}

/** Each record's paths for the box named `self` on the box that runs it: `{"path": "~/...", "owner": "<session folder>"}` per line. */
const HOST_RECORDS = `import json, os, sys
root = os.path.expanduser("~/.prime/agent/session-artifacts")
for folder, _, files in os.walk(root):
    if "owned.json" in files:
        try:
            with open(os.path.join(folder, "owned.json"), encoding="utf-8") as handle:
                hosts = json.load(handle).get("hosts") or {}
        except (OSError, ValueError, AttributeError):
            continue
        for path in hosts.get(sys.argv[1], []) if isinstance(hosts, dict) else []:
            print(json.dumps({"path": path, "owner": os.path.relpath(folder, root)}))
`;

/** The records on another box that name paths on the box `self`, read over ssh as `sshLeftovers` reaches the box. */
function hostRecords(host: Host, self: string): Promise<{ path: string; owner: string }[]> {
  return new Promise((resolve, reject) => {
    if (!host.ssh) { reject(new Error(`hosts.json gives ${host.name} no ssh target`)); return; }
    const quote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;
    hostExecFile("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host.ssh, `python3 -c ${quote(HOST_RECORDS)} ${quote(self)}`], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) { reject(new Error(`the records on ${host.name}: ${String(stderr).trim().slice(0, 300) || error.message}`)); return; }
      const lines = String(stdout).split("\n").filter(Boolean).map(line => JSON.parse(line) as { path: string; owner: string });
      resolve(lines.flatMap(line => hostPaths([line.path]).map(path => ({ path, owner: `${host.name}:${line.owner}` }))));
    });
  });
}

/** The real source of `reapUnowned`: this box's records and those of every other box in hosts.json, `find`, docker and the footprint helper. */
export const unownedSource: UnownedSource = {
  inside: leftoverSource.inside,
  removeTmp: leftoverSource.removeTmp,
  records: async () => {
    const local = (await otherRecords([])).map(entry => { const [path, owner] = entry.split("\0") as [string, string]; return { path, owner: relative(artifactsRoot(), owner) }; });
    const registry = await loadHosts();
    const self = selfHost(registry);
    if (!self) throw new Error("hosts.json does not name this box, so the other boxes' records for it cannot be read");
    const away = await Promise.all(registry.hosts.filter(host => host.name !== self.name).map(host => hostRecords(host, self.name)));
    return [...local, ...away.flat()];
  },
  written: (dir, since) => new Promise(resolve => {
    const at = `@${Math.floor(since / 1000)}`;
    hostExecFile("find", [dir, "(", "-newermt", at, "-o", "-links", "1", "-newerct", at, ")", "-print", "-quit"], { maxBuffer: 1024 * 1024 }, (error, stdout) => {
      const found = String(stdout).split("\n")[0]!.trim();
      resolve(found || (error ? dir : null));
    });
  }),
  mounted: async dirs => { const running = await runningContainers(); return dirs.filter(dir => mountedIn(running, [dir]).length); },
};

/** The bytes of the tree at `dir`, as `du -sb` counts them; 0 when du fails. */
function treeBytes(dir: string): Promise<number> {
  return new Promise(resolve => {
    hostExecFile("du", ["-sb", "--", dir], { maxBuffer: 1024 * 1024 }, (_error, stdout) => resolve(Number(String(stdout).split("\t")[0]) || 0));
  });
}

/** Runs this module's CLI (`main`) on another box with these arguments and returns what it printed. */
export type RemoteLeftovers = (host: Host, args: readonly string[]) => Promise<Leftovers>;

/** A session-artifacts path below `artifactsRoot` as the CLI takes it, `<session>[/sub-...]`; null for anything else. */
const ARTIFACT_PATH = /^[0-9a-f-]{36}(\/sub-[0-9a-f]+)*$/;
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Ends a gone job's leftovers on the box whose daemon runs the session that owns its folder, the first name below `artifactsRoot` (a chat for its
 * jobs, a root for itself). A Mac chat's job folders, owned.json records, detached processes and Aside tabs are all on the Mac, so the chat
 * service on us-metal02 found no folder at their end and stopped nothing: on 10-19 the Mac's signup and add brand jobs recorded world units
 * they started on us-metal02 over ssh in owned.json files only the Mac holds. The other box runs the cleanup itself (`main`, over ssh), and
 * the units its records name that it has no systemd for are stopped here, as are the paths they name on this box (`away` under `self`) and the
 * job folders `~/scratch/<session id>` of its ended sessions here: on 10-20 Mac jobs held 22.4 GB of trees on us-metal02 that no record named,
 * since a Mac record could not name a box path.
 */
export function hostLeftovers(options: { local: LeftoverSource; hostOf: (session: string) => Host | null; remote?: RemoteLeftovers | undefined;
  self?: () => string | null; hostNamed?: (name: string) => Host | null }): {
  leftovers: (dir: string, session?: string) => Promise<Leftovers>; deleted: (chat: string) => Promise<Leftovers>;
} {
  const { local, hostOf, remote } = options;
  const there = async (host: Host, args: readonly string[]): Promise<Leftovers> => {
    const left = await remote!(host, args);
    const stopped = left.elsewhere?.length ? await local.stopUnits(left.elsewhere).catch(() => []) ?? [] : [];
    const self = options.self?.() ?? null;
    const folders = (left.sessions ?? []).filter(session => SESSION.test(session)).flatMap(session => jobFolders(session, homedir()));
    const here = [...self ? hostPaths(left.away?.[self] ?? []) : [], ...folders];
    const none = { removed: [], kept: new Map<string, string>(), containers: [] };
    const { removed, kept, containers } = here.length ? await removeFree(local, here).catch(() => none) : none;
    const notes = [...left.kept ?? [], ...keptNotes(kept)];
    const removedContainers = [...left.containers ?? [], ...containers];
    return { ...left, owned: [...left.owned, ...removed], units: [...left.units, ...stopped], ...notes.length ? { kept: notes } : {},
      ...removedContainers.length ? { containers: removedContainers } : {} };
  };
  // The paths the records name on a third box, such as the Mac's for a box job that made trees there over ssh, end on that box.
  const far = async (left: Leftovers): Promise<Leftovers> => {
    const self = options.self?.() ?? null;
    const owned = [...left.owned];
    const kept = [...left.kept ?? []];
    for (const [name, paths] of Object.entries(left.away ?? {})) {
      const host = name !== self && remote ? options.hostNamed?.(name) ?? null : null;
      const answer = host && paths.length ? await remote!(host, ["away", ...paths]).catch(() => null) : null;
      owned.push(...answer?.owned ?? []);
      kept.push(...answer?.kept ?? []);
    }
    return { ...left, owned, ...kept.length ? { kept } : {} };
  };
  return {
    leftovers: async (dir, session) => {
      const path = relative(artifactsRoot(), dir);
      const host = remote && ARTIFACT_PATH.test(path) ? hostOf(path.split("/")[0]!) : null;
      return far(host ? await there(host, ["end", path, ...session && SESSION.test(session) ? [session] : []]) : await endLeftovers(local, dir, session));
    },
    deleted: async chat => {
      const host = remote && SESSION.test(chat) ? hostOf(chat) : null;
      return far(host ? await there(host, ["deleted", chat]) : await endLeftovers(local, await deletedFolders(join(artifactsRoot(), chat))));
    },
  };
}

/**
 * The CLI over ssh in the other box's own sieun-pi checkout (`sieun-pi source`), as Settings > Tools and skills runs its checks there
 * (chat-tools.ts `sshChecks`, whose ConnectTimeout=10 is the box's aside wrapper's).
 */
export const sshLeftovers: RemoteLeftovers = (host, args) => new Promise((resolve, reject) => {
  if (!host.ssh) { reject(new Error(`hosts.json gives ${host.name} no ssh target`)); return; }
  const command = `PATH="$HOME/.local/bin:$PATH"; s="$(sieun-pi source)"; { cd "$s/legacy/prime/user-history" 2>/dev/null || cd "$s/components/user-history"; } && exec node --import tsx src/job-leftovers.ts ${args.map(arg => `'${arg.replace(/'/g, "'\\''")}'`).join(" ")}`;
  hostExecFile("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host.ssh, command], { maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    try { if (!error) { resolve(JSON.parse(String(stdout).trim().split("\n").at(-1) ?? "") as Leftovers); return; } } catch { /* reported below */ }
    reject(new Error(`job leftovers on ${host.name}: ${(String(stderr) || String(stdout)).replace(/\s+/g, " ").trim().slice(0, 300) || error?.message || "no answer"}`));
  });
});

/**
 * `node --import tsx src/job-leftovers.ts end <session>[/sub-...] [session]` ends the leftovers of that folder under this box's `artifactsRoot`, and
 * `deleted <chat>` those of the chat's deleted jobs, and `away <path>...` deletes the paths another box's record names on this box (`hostPaths`)
 * that no process uses; each prints the Leftovers as one JSON line. `unowned < paths` deletes the owner-less trees among the paths on stdin
 * (`reapUnowned`). The process stays up for the SIGKILL pass and
 * the second strays read (`stopProcesses`, `endLeftovers`), which the service's unref'd timers would drop here.
 */
async function main(args: readonly string[]): Promise<void> {
  const [kind, path, session] = args;
  const source: LeftoverSource = { ...leftoverSource, later: (ms, run) => { setTimeout(run, ms); } };
  let left: Leftovers;
  if (kind === "end" && path && ARTIFACT_PATH.test(path) && (session === undefined || SESSION.test(session))) left = await endLeftovers(source, join(artifactsRoot(), path), session);
  else if (kind === "deleted" && path && SESSION.test(path)) left = await endLeftovers(source, await deletedFolders(join(artifactsRoot(), path)));
  else if (kind === "away") {
    const { removed, kept, containers } = await removeFree(source, hostPaths(args.slice(1)));
    left = { stopped: [], tabs: 0, copies: [], artifacts: [], units: [], owned: removed, ...kept.size ? { kept: keptNotes(kept) } : {}, ...containers.length ? { containers } : {} };
  }
  else if (kind === "unowned") { await mainUnowned(); return; }
  else throw new Error("usage: job-leftovers.ts end <session>[/sub-...] [session] | deleted <chat> | away <path>... | unowned < paths");
  process.stdout.write(JSON.stringify(left) + "\n");
}

/**
 * `unowned` reads one absolute path per line on stdin, since a path on this process's own command line would read as a process that names it
 * (worker-footprint.py `--inside`), runs `reapUnowned` on them, appends a line per path to `unownedLog` and prints the totals as one JSON line.
 */
async function mainUnowned(): Promise<void> {
  let input = "";
  for await (const chunk of process.stdin) input += String(chunk);
  const paths = input.split("\n").map(line => line.trim()).filter(Boolean);
  const bytes = new Map(await Promise.all(paths.map(async path => [path, await treeBytes(await realFolder(path))] as const)));
  const { removed, kept } = await reapUnowned(unownedSource, paths);
  const at = new Date().toISOString();
  const lines = [...removed.map(path => ({ at, path, bytes: bytes.get(path) ?? 0, deleted: true })),
    ...[...kept].map(([path, why]) => ({ at, path, bytes: bytes.get(path) ?? 0, deleted: false, kept: why }))];
  await mkdir(dirname(unownedLog()), { recursive: true });
  await appendFile(unownedLog(), lines.map(line => JSON.stringify(line) + "\n").join(""));
  const freed = removed.reduce((sum, path) => sum + (bytes.get(path) ?? 0), 0);
  process.stdout.write(JSON.stringify({ removed, freedBytes: freed, kept: keptNotes(kept), log: unownedLog() }) + "\n");
}

if (isMain(import.meta.url)) {
  await main(process.argv.slice(2)).catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
