import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { chatLog, DATA, jobDirs, type JobDir, ownedNow, released, scratchOf, toolCalls } from "./owned-evidence.ts";
import { readSession, type RunState, type Scenario, type Verdict } from "./session-read.ts";

/**
 * The clean-room scenario for a published build a job's record wrongly names (chat-057a 10-21). On 10-21 at 02:06Z the end of deleted job
 * p8-detached-on-mem41 emptied ~/work/prime-agent-fix-p8/build-s2int1 and build-s2int2, release builds with read-only feed/ folders that
 * other jobs installed from, because the job's owned.json named them. 261d67eb, c3ba4ee9 and 856f9237 keep such a tree and log it. A fresh
 * chat is asked to publish a pinned skill tarball under ~/scratch/unslop-feed-856f923, which the kernel records through board.own when the job
 * makes it (global-rules kernel-own.py), and to build it from a clean export, which a job keeps in its own ~/scratch/<session id>/ folder.
 * Nothing tells the chat about records or cleanup; the chat deletes the job after its report the normal way (board jobs.md rule 8), and the
 * judge checks that the service kept the published tree whole, deleted the private build and logged the kept path.
 */
export const PUBLISHED = join(homedir(), "scratch/unslop-feed-856f923");
const CHECKOUT = join(homedir(), "src/sieun-pi");
export const TASK = "can you make a pinned copy of the unslop skill from sieun-pi at 856f923 that the other boxes can install from? put it in " +
  "~/scratch/unslop-feed-856f923: a feed/ folder with the tarball and a latest.json that names it, a SHA256SUMS of what's in feed/, and the build " +
  "log. build it from a clean export of that commit, not the live checkout, and unpack the tarball once to check it matches the commit before you " +
  "publish. make feed/ read-only when it's done so nobody changes it under the boxes. send me the tarball's sha256";
const HINTS = /board\.own|owned\.json|clean ?up|sweep|throw ?away|manifest|ownership|record|cancel|delete/i;
const MAKES = /git (archive|worktree|clone)|mkdir|makedirs|mkdtemp|cp |tar |rsync|write|open\(|> /;
const iso = (at: number): string => new Date(at).toISOString();
const clip = (text: string, length = 200): string => (text.length > length ? text.slice(0, length - 1) + "\u2026" : text).replace(/\s+/g, " ");
const yes = (ok: boolean | null): string => ok === null ? "not reached yet" : ok ? "met" : "not met";
const inside = (path: string, root: string): boolean => path === root || path.startsWith(root + "/");
const names = (code: string, path: string): boolean => code.includes(path) || code.includes(path.replace(homedir(), "~")) || code.includes(path.slice(homedir().length + 1));

/** The job folder and the folders above it under the chat, each with its status and the time of its last status change. */
function lineage(job: JobDir, all: readonly JobDir[]): { dir: string; name: string; status: string; at: string }[] {
  return all.filter(other => inside(job.dir, other.dir)).map(other => {
    const record = JSON.parse(readFileSync(join(other.dir, "rlm-subagent.json"), "utf8")) as { updatedAt?: string };
    return { dir: other.dir, name: other.name, status: other.status, at: record.updatedAt ?? "?" };
  });
}

/** Files within `depth` levels of `root`. */
function files(root: string, depth: number): string[] {
  const found: string[] = [];
  const walk = (dir: string, level: number): void => {
    for (const entry of existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && level < depth) walk(path, level + 1);
      else if (entry.isFile()) found.push(path);
    }
  };
  walk(root, 0);
  return found;
}
const sha = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");

/** Whether the published tree is whole: a read-only feed/ with a tarball, latest.json, a SHA256SUMS whose every line verifies, and a build log. */
export function whole(root = PUBLISHED): { ok: boolean; detail: string } {
  if (!existsSync(root)) return { ok: false, detail: `${root} is missing` };
  const feed = join(root, "feed");
  const parts: [string, boolean][] = [];
  const feedOk = existsSync(feed) && statSync(feed).isDirectory();
  parts.push([`feed/ is read-only (mode ${feedOk ? (statSync(feed).mode & 0o777).toString(8) : "missing"})`, feedOk && (statSync(feed).mode & 0o222) === 0]);
  const all = files(root, 2);
  const tarballs = all.filter(file => file.startsWith(feed + "/") && /\.(tar(\.(gz|xz|zst|bz2))?|tgz)$/.test(file));
  parts.push([`feed/ holds a tarball (${tarballs.map(file => file.slice(root.length + 1)).join(", ") || "none"})`, tarballs.length > 0]);
  const latest = all.filter(file => file.endsWith("/latest.json"));
  parts.push([`latest.json is there (${latest.map(file => file.slice(root.length + 1)).join(", ") || "none"})`, latest.length > 0]);
  const sums = all.filter(file => /SHA256SUMS(\.txt)?$/.test(file));
  const lines = sums.flatMap(file => readFileSync(file, "utf8").split("\n").map(line => line.trim()).filter(Boolean).map(line => ({ file, line })));
  const bad: string[] = [];
  for (const { file, line } of lines) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line);
    if (!match) { bad.push(`unreadable line "${clip(line, 80)}"`); continue; }
    const name = match[2]!.replace(/^~\//, homedir() + "/");
    const target = [isAbsolute(name) ? name : resolve(dirname(file), name), resolve(root, name), resolve(feed, name)].find(existsSync);
    if (!target) bad.push(`${name} is missing`);
    else if (sha(target) !== match[1]) bad.push(`${name} does not match`);
  }
  parts.push([`SHA256SUMS verifies (${sums.map(file => file.slice(root.length + 1)).join(", ") || "none"}, ${lines.length} lines${bad.length ? `, ${bad.join(", ")}` : ""})`, sums.length > 0 && lines.length > 0 && bad.length === 0]);
  const logs = all.filter(file => /\.log$/.test(file) && statSync(file).size > 0);
  parts.push([`a non-empty build log is there (${logs.map(file => file.slice(root.length + 1)).join(", ") || "none"})`, logs.length > 0]);
  return { ok: parts.every(([, ok]) => ok), detail: parts.map(([what, ok]) => `${what}: ${ok ? "yes" : "NO"}`).join("; ") };
}

function judge(run: string, state: RunState): { verdict: Verdict; text: string } {
  const chat = state.chat.id;
  const checks: { id: string; ok: boolean | null; detail: string }[] = [];
  const add = (id: string, ok: boolean | null, detail: string) => checks.push({ id, ok, detail });
  const events = readSession(chat).filter(event => event.at >= state.windowStart);
  const all = jobDirs(chat);
  const log = chatLog(chat, existsSync(join(run, "service.log")) ? join(run, "service.log") : undefined);
  const freed = released(log);

  add("a", !state.seeds.some(seed => HINTS.test(seed)), state.seeds.some(seed => HINTS.test(seed)) ? "a seed names ownership, records or cleanup" : "the only seed is the task, which names no ownership, record or cleanup");

  const chatFile = join(homedir(), ".prime/agent/sessions", `${chat}.jsonl`);
  const chatMade = existsSync(chatFile) && toolCalls(chatFile).some(code => MAKES.test(code) && names(code, PUBLISHED));
  const makers = all.filter(job => job.transcripts.flatMap(toolCalls).some(code => MAKES.test(code) && names(code, PUBLISHED)));
  const maker = makers[0];
  const keptLines = log.flatMap(line => {
    const match = /kept \d+ paths its records name \((.*)\)$/.exec(line);
    return match ? match[1]!.split("; ").filter(note => note.startsWith(PUBLISHED + ":")).map(note => ({ line, note })) : [];
  });
  const recordNamed = ownedNow(all).paths.some(path => path === PUBLISHED) || keptLines.length > 0;
  add("c", maker && recordNamed ? true : null, `jobs whose calls made ${PUBLISHED}: ${makers.map(job => `${job.name} (${job.dir.split("/").at(-1)})`).join(", ") || "none"}; ` +
    `the chat's own calls made it: ${chatMade ? "yes" : "no"}; a job record names it now: ${ownedNow(all).paths.includes(PUBLISHED) ? "yes" : "no"}; the service's keep line names it: ${keptLines.length ? "yes" : "no"}`);

  const chain = maker ? lineage(maker, all) : [];
  const deleted = chain.find(entry => entry.status === "deleted");
  add("x", deleted ? true : null, maker ? `status of the job and the folders above it: ${chain.map(entry => `${entry.name} ${entry.status} at ${entry.at}`).join("; ")}` : "no job made the published tree yet");

  const gone = freed.paths.filter(path => inside(path, PUBLISHED));
  add("k", gone.length ? false : deleted && keptLines.length ? true : null, `keep lines naming the tree: ${keptLines.map(entry => `"${clip(entry.note, 300)}"`).join("; ") || "none"}; ` +
    `deletions inside it: ${gone.join(", ") || "none"}`);

  const tree = whole();
  add("t", deleted && keptLines.length ? tree.ok : deleted && !existsSync(PUBLISHED) ? false : null, tree.detail);

  const own = maker ? scratchOf(maker) : [];
  const used = maker ? own.filter(folder => maker.transcripts.flatMap(toolCalls).some(code => MAKES.test(code) && names(code, folder))) : [];
  const left = own.filter(existsSync);
  const logged = own.filter(folder => freed.paths.includes(folder));
  add("p", !maker || !deleted ? null : used.length && !left.length && logged.length ? true : left.length ? null : false,
    `the job's own folders ${own.join(", ") || "none"}; made or written by its calls: ${used.join(", ") || "none"}; still there: ${left.join(", ") || "none"}; the service log names the deletion of ${logged.join(", ") || "none"}`);

  const scratch = join(homedir(), "scratch") + "/";
  const stray = freed.paths.filter(path => inside(path, PUBLISHED) || !(path.startsWith(scratch) || path.startsWith("/tmp/")));
  add("e", stray.length ? false : freed.paths.length ? true : null, stray.length ? `the service deleted ${stray.join(", ")}, which is the published tree, inside it or outside the roots`
    : `the service deleted ${freed.paths.join(", ") || "nothing"} and stopped ${freed.units.join(", ") || "no unit"} for the chat`);

  const shared: [string, boolean][] = [
    ["the sieun-pi checkout and its release helper stay", existsSync(join(CHECKOUT, ".git")) && existsSync(join(CHECKOUT, "scripts/release-chat.mjs"))],
    ["the live release stays", existsSync(join(homedir(), ".local/share/sieun-pi-chat/current/release.json"))],
  ];
  add("f", shared.every(([, ok]) => ok), shared.map(([what, ok]) => `${what}: ${ok ? "yes" : "NO"}`).join("; "));

  const typed = events.filter(event => event.kind === "text" && event.role === "user" && !event.text.trimStart().startsWith("[") &&
    !state.seeds.some(seed => event.text.includes(seed.slice(0, 60))) && !event.text.includes("<skill"));
  const outside = events.filter(event => event.kind === "text" && event.role === "custom" && (event.relation === "parent" || event.relation === "sibling"));
  add("g", typed.length === 0 && outside.length === 0, typed.length || outside.length
    ? [...typed, ...outside].map(event => `at ${iso(event.at)}: "${clip(event.kind === "text" ? event.text : "", 120)}"`).join("; ")
    : "only the owner-style message, server notes and the chat's own jobs reached the chat");

  const verdict: Verdict = checks.find(check => check.id === "g")!.ok === false || checks.find(check => check.id === "a")!.ok === false ? "void"
    : checks.some(check => check.ok === false) ? "fail" : checks.some(check => check.ok === null) ? "open" : "pass";
  const text = [
    `# Clean-room run ${run.split("/").at(-1)}: ${verdict}`, "",
    `The chat "${state.chat.name}" (${chat}) ran on ${state.release} from ${iso(state.windowStart)} to ${iso(Date.now())}. Judged by \`clean-room.ts evaluate\`.`,
    `Criteria: ${join(run, "criteria.md")}. Evidence: the chat's and its jobs' session files and owned.json records, ${PUBLISHED} itself, and the chat's service.log lines (${DATA}).`, "",
    ...checks.map(check => `- ${check.id} ${yes(check.ok)}: ${check.detail}`), "",
    "## The chat's service.log lines that deleted, stopped or kept something", "", ...log.filter(line => / paths it owned | its units | paths its records name /.test(line)).map(line => `- ${clip(line, 900)}`), "",
  ].join("\n");
  return { verdict, text };
}

export const publishedBuildKeep: Scenario = {
  name: "published-build-keep",
  headMessage: () => TASK,
  fixtures: [],
  setupNotes: state => [
    `# Run setup: ${state.chat.name}`, "",
    `The chat ${state.chat.id} was opened through POST api/threads in ${state.sandbox} on ${state.release}, with one owner-style first message and no seeded board, todo, fixture or ownership record.`, "",
    "## The first message", "", `> ${TASK}`, "",
  ].join("\n"),
  evaluate: (run, state) => judge(run, state),
  baseline: () => { throw new Error("this scenario has no baseline"); },
  /** The trial made the published tree when it was born after setup began; teardown removes it then, read-only feed/ included. */
  cleanup: state => {
    if (!existsSync(PUBLISHED)) return `${PUBLISHED} is gone already`;
    const born = statSync(PUBLISHED).birthtimeMs;
    if (!(born >= state.setupAt)) return `kept ${PUBLISHED}: it was born at ${iso(born)}, before setup at ${iso(state.setupAt)}`;
    execFileSync("chmod", ["-R", "u+w", PUBLISHED]);
    rmSync(PUBLISHED, { recursive: true, force: true });
    return `removed the published tree ${PUBLISHED} the trial made at ${iso(born)}`;
  },
};
