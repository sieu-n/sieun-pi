import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * What a clean-room chat's jobs recorded with board.own and what the service released for them, read from the records and logs the system
 * writes: each job's owned.json, the answers board.own gave in its transcript, and the chat's service.log lines. A path is never read from the
 * text of a board.own call, since a job passes `os.path.expanduser(...)` as often as a literal (canary suite recount, 10-19 17:21:58Z).
 */
const ARTIFACTS = join(homedir(), ".prime/agent/session-artifacts");
export const DATA = process.env.AGENT_CHAT_DATA_DIR ?? join(homedir(), ".prime/agent/browser-chat");

export interface JobDir { dir: string; status: string; name: string; transcripts: string[] }
/** Every job folder under the chat (`sub-*` with rlm-subagent.json), its subagents included. */
export function jobDirs(chat: string): JobDir[] {
  const found: JobDir[] = [];
  const walk = (dir: string): void => {
    for (const name of existsSync(dir) ? readdirSync(dir) : []) {
      const path = join(dir, name);
      if (!name.startsWith("sub-") || !statSync(path).isDirectory()) continue;
      const record = existsSync(join(path, "rlm-subagent.json")) ? JSON.parse(readFileSync(join(path, "rlm-subagent.json"), "utf8")) as { status?: string; sessionName?: string } : {};
      found.push({ dir: path, status: record.status ?? "?", name: record.sessionName ?? name,
        transcripts: readdirSync(path).filter(file => /^[0-9a-f-]{36}\.jsonl$/.test(file)).map(file => join(path, file)) });
      walk(path);
    }
  };
  walk(join(ARTIFACTS, chat));
  return found;
}

const lines = (file: string): Record<string, unknown>[] => readFileSync(file, "utf8").split("\n").flatMap(line => {
  try { return line.trim() ? [JSON.parse(line) as Record<string, unknown>] : []; } catch { return []; }
});
/** The string arguments of each tool call in a transcript, joined: the code a job ran. */
export function toolCalls(file: string): string[] {
  return lines(file).flatMap(entry => {
    const message = entry.message as { role?: string; content?: { type?: string; arguments?: Record<string, unknown> }[] } | undefined;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) return [];
    return message.content.filter(block => block.type === "toolCall").map(block => Object.values(block.arguments ?? {}).filter(value => typeof value === "string").join("\n"));
  });
}
/** Each answer board.own gave in a transcript: "Owned by this session (<file>): <n> paths, units <list or none>." */
export function ownAnswers(file: string): { at: string; paths: number; units: string[] }[] {
  return lines(file).flatMap(entry => {
    const message = entry.message as { role?: string; content?: unknown } | undefined;
    if (message?.role !== "toolResult") return [];
    const text = JSON.stringify(message.content ?? "");
    return [...text.matchAll(/Owned by this session \([^)]*\): (\d+) paths, units (.*?)\. Its end/g)].map(match =>
      ({ at: String(entry.timestamp ?? ""), paths: Number(match[1]), units: match[2] === "none" ? [] : match[2]!.split(", ") }));
  });
}
/** The paths and units the jobs' owned.json records name now; the service rewrites a record to what is still there after each cleanup. */
export function ownedNow(jobs: readonly JobDir[]): { paths: string[]; units: string[] } {
  const paths = new Set<string>(), units = new Set<string>();
  for (const job of jobs) {
    const file = join(job.dir, "owned.json");
    if (!existsSync(file)) continue;
    const record = JSON.parse(readFileSync(file, "utf8")) as { paths?: unknown[]; units?: unknown[] };
    for (const path of record.paths ?? []) if (typeof path === "string") paths.add(path);
    for (const unit of record.units ?? []) if (typeof unit === "string") units.add(unit);
  }
  return { paths: [...paths], units: [...units] };
}
/** The chat's service.log lines (`chat <id8>...`). */
export function chatLog(chat: string, file = join(DATA, "service.log")): string[] {
  if (!existsSync(file)) return [];
  const short = `chat ${chat.slice(0, 8)}`;
  return readFileSync(file, "utf8").split("\n").filter(line => line.startsWith(short));
}
/** The paths and units the service's job-end cleanup logged it deleted or stopped for the chat (job-leftovers.ts via chats.ts copiesNote). */
export function released(log: readonly string[]): { paths: string[]; units: string[]; lines: string[] } {
  const paths = new Set<string>(), units = new Set<string>(), hits: string[] = [];
  for (const line of log) {
    const owned = /deleted \d+ paths it owned \((.*?)\)(?:$|,)/.exec(line);
    const stopped = /stopped its units (.*?)(?=, deleted \d+ paths it owned|$)/.exec(line);
    if (!owned && !stopped) continue;
    hits.push(line);
    for (const path of owned?.[1]?.split(", ") ?? []) if (path.startsWith("/")) paths.add(path.replace(/ and \d+ more$/, ""));
    for (const unit of stopped?.[1]?.split(", ") ?? []) units.add(unit.trim());
  }
  return { paths: [...paths], units: [...units], lines: hits };
}
const MAKES = /git (archive|worktree|clone)|mkdir|makedirs|mkdtemp|cp -|tar |rsync|systemd-run/;
/** The recorded paths and units a job's own tool calls made: a call that names the path's last part or the unit's name and makes something. */
export function madeBy(jobs: readonly JobDir[], paths: readonly string[], units: readonly string[]): { paths: string[]; units: string[] } {
  const code = jobs.flatMap(job => job.transcripts.flatMap(toolCalls)).filter(text => MAKES.test(text));
  const named = (word: string) => code.some(text => text.includes(word));
  return { paths: paths.filter(path => named(path.split("/").at(-1)!)), units: units.filter(unit => named(unit.replace(/\.(service|scope|timer)$/, ""))) };
}
/** The ~/work folders the jobs' own calls write into. */
export function workFolders(jobs: readonly JobDir[]): string[] {
  return [...new Set(jobs.flatMap(job => job.transcripts.flatMap(toolCalls)).filter(code => /makedirs|mkdir|write|open\(|> /.test(code))
    .flatMap(code => [...code.matchAll(/(?:~|\/home\/sieun)\/work\/([\w.-]+)/g)].map(match => join(homedir(), "work", match[1]!))))];
}
export const sha256 = (file: string): string => existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : "missing";
/** A user unit's ActiveState, "inactive" when systemd has no such unit. */
export function unitState(unit: string): string {
  try { return execFileSync("systemctl", ["--user", "show", "-p", "ActiveState", "--value", "--", unit], { encoding: "utf8" }).trim() || "inactive"; } catch { return "unknown"; }
}
