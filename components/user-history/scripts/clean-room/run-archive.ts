import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { type JudgeVersion, short } from "./judge-version.ts";
import { PRIME_DIR, type RunState, sessionFiles, type Verdict } from "./session-read.ts";

/**
 * The evidence of a clean-room run kept after teardown deletes the run folder, so a later judge can judge it again with the same inputs. On
 * 10-24 carried-wait release-run-1 passed on an obsolete judge and its teardown deleted the agents snapshots that held the ownership data, so
 * the pass could be neither trusted nor judged again. The archive sits next to the verdict file and holds:
 *
 *   <run name>/          the run folder as teardown found it: run.json, criteria.md, boards, agents, runs.jsonl, prompts, units.json, logs
 *   prime/               the session files of the run's chats and jobs, laid out as under ~/.prime/agent, which session-read.ts reads
 *   ownership.json       the chat-jobs.json entries that file a session under the run's chats
 *   identity.jsonl       each delivery receipt collect kept from service.log: path, source chat and session, target session and delivery id
 *   outbox/              the service's agent-outbox and owner outbox entries addressed to the run's sessions
 *   verdicts/            the verdict files written so far
 *   archive.json         the manifest: the run, its window, the criteria's sha256 and the loaded and current judge versions
 */
export interface ArchiveManifest {
  run: string; scenario: string; chat: { id: string; name: string }; windowStart: number; until?: number; archivedAt: number;
  criteria: { file: string; sha256: string }; judge: { loaded: JudgeVersion; current: JudgeVersion }; sessions: string[]; verdicts: string[];
}

/** A delivery receipt line, `deliveryLine` in src/clean-room-subjects.ts. */
export const DELIVERY = /\bdelivery (sibling send|d9 push|job-steer): from session (.+?)(?: \((.*)\))? of chat (\S+) to session (\S+) as (\S+?)(?:, taken to the trial owner (\S+))?\s*$/;

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
const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;

/** Writes `archivePath(run)` and returns it. Running it again on the same run folder writes the same archive anew. */
export function archiveRun(run: string, state: RunState, sessions: readonly string[], dataDir: string, judge: { loaded: JudgeVersion; current: JudgeVersion }): string {
  const name = basename(run);
  const stage = join(dirname(run), `${name}.evidence-stage`);
  rmSync(stage, { recursive: true, force: true });
  cpSync(run, join(stage, name), { recursive: true });
  const ids = new Set(sessions);
  for (const id of ids) for (const file of sessionFiles(id)) {
    const at = join(stage, "prime", relative(PRIME_DIR, file));
    mkdirSync(dirname(at), { recursive: true });
    cpSync(file, at);
  }
  const chats = new Set([state.chat.id, state.chat.name, ...state.control ? [state.control.id, state.control.name] : []]);
  const registry = join(dataDir, "chat-jobs.json");
  const jobs = existsSync(registry) ? readJson<{ jobs?: Record<string, { chat: string; chatId?: string }> }>(registry).jobs ?? {} : {};
  writeFileSync(join(stage, "ownership.json"), JSON.stringify({ jobs: Object.fromEntries(Object.entries(jobs).filter(([key, entry]) =>
    ids.has(key) || key in state.fixtures || chats.has(entry.chat) || (entry.chatId !== undefined && chats.has(entry.chatId)))) }, null, 1));
  writeFileSync(join(stage, "identity.jsonl"), deliveries(join(run, "service.log")).map(record => JSON.stringify(record) + "\n").join(""));
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
    archivedAt: Date.now(), criteria: { file: `${name}/criteria.md`, sha256: fileSha256(join(run, "criteria.md")) }, judge, sessions: [...ids], verdicts };
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

/**
 * Judges an archived run again with the judge of `script`, a current clean-room.ts: it unpacks the archive next to itself, checks that the
 * criteria are the ones the run was judged on, points session-read.ts at the archived session files, pins the judge's clock at the window end,
 * writes `<run name>.rejudged-<commit>.<verdict>.md` next to the archive and deletes the unpacked copy.
 */
export async function rejudge(archive: string, script: string, judge: JudgeVersion): Promise<{ verdict: Verdict; file: string }> {
  const work = `${archive}.rejudge-${process.pid}`;
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    execFileSync("tar", ["-xzf", archive, "-C", work]);
    const manifest = readJson<ArchiveManifest>(join(work, "archive.json"));
    const criteria = fileSha256(join(work, manifest.criteria.file));
    if (criteria !== manifest.criteria.sha256) throw new Error(`the archived criteria read sha256 ${criteria}, not the ${manifest.criteria.sha256} the run was judged on`);
    const run = join(work, basename(manifest.run));
    const now = new Date(manifest.until ?? manifest.archivedAt).toISOString();
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", script, "judge", "--run", run, "--now", now],
      { cwd: judge.root, env: { ...process.env, CLEAN_ROOM_PRIME_DIR: join(work, "prime") } });
    const { verdict, text } = JSON.parse(stdout.trimEnd().split("\n").at(-1) ?? "") as { verdict: Verdict; text: string };
    const file = join(dirname(archive), `${basename(manifest.run)}.rejudged-${judge.commit.slice(0, 12)}.${verdict}.md`);
    writeFileSync(file, `${text.replaceAll(run, manifest.run)}\nRejudged from ${archive}.${judgeFooter(judge, judge, criteria, manifest.until)}`);
    return { verdict, file };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
