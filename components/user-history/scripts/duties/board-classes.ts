import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { BoardStore } from "../../src/chat-board-store.ts";
import { ACT_CLASSES, CHASE_ESCALATE_MS, checkInRecord, checkInSettings, classifyBoard, classLine, holdsOnWait, jobEndWords, jobFacts, STEP_CLASSES, type StepClass, type StepView } from "../../src/chat-checkin.ts";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import type { ChildAgent, SessionRow } from "../../src/shared/types.ts";

/**
 * Board classes: every open leaf step of every chat board in one class (`stepClass`), from the boards, the check-in memory (each step's last
 * change), the check-in settings (one tick is the chat's interval) and the daemon's session list (jobs and threads).
 *
 * `node --import tsx scripts/duties/board-classes.ts [--chat <id>] [--data-dir <dir>] [--sessions <file>] [--now <ms>]` prints the counts per chat
 * and a line per step to act on. With OUTPUT_FILE set it is the "Board convergence" duty's precheck for `--chat`: it writes the four misses.
 */

/** The fields of one `prime-agent sessions --json` entry the classes read. */
export interface DaemonSession {
  sessionId: string; sessionName?: string; firstMessage?: string; lifecycle?: string; activity?: string; lastActivityAt?: string;
  messageCount?: number; parentSessionId?: string; rlmChildId?: string;
}
/**
 * The duty's targets, each at most 0. `job_end_silent` is a step whose job ended badly (a provider error, an abort, a stop mid-tool, the length
 * limit) with no report, which the server told the chat at once (the check-in record's told ends), not updated a check-in later; such a step
 * is counted there and not again in `job_end_unrecorded`.
 */
export interface ConvergenceMisses { orphan_steps: number; due_late: number; stale_chase_24h: number; job_end_unrecorded: number; job_end_silent: number }
export const NO_MISSES: ConvergenceMisses = { orphan_steps: 0, due_late: 0, stale_chase_24h: 0, job_end_unrecorded: 0, job_end_silent: 0 };
export interface ChatClasses {
  id: string; name: string; everyMs: number; open: number; counts: Record<StepClass, number>; misses: ConvergenceMisses;
  steps: StepView[]; flagged: FlaggedSlice[];
}

/** JSON whose strings may hold raw control characters (session titles do): they are escaped before parsing. */
export function parseLooseJson(text: string): unknown {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (ch === "\\") { out += ch + (text[i + 1] ?? ""); i++; continue; }
      if (ch === '"') inString = false;
      const code = ch.charCodeAt(0);
      out += code < 0x20 ? `\\u${code.toString(16).padStart(4, "0")}` : ch;
      continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  return JSON.parse(out);
}

/** The daemon's session list through the project's own prime-agent CLI. */
export function daemonSessions(): DaemonSession[] {
  const bin = join(import.meta.dirname, "..", "..", "node_modules", ".bin", "prime-agent");
  const run = spawnSync(bin, ["sessions", "--json"], { encoding: "utf8", maxBuffer: 1 << 28, timeout: 60_000 });
  if (run.status !== 0) throw new Error(`prime-agent sessions --json: exit ${run.status ?? run.signal}: ${String(run.stderr).trim().slice(0, 300)}`);
  const parsed = parseLooseJson(run.stdout) as { sessions?: DaemonSession[] } | DaemonSession[];
  return Array.isArray(parsed) ? parsed : parsed.sessions ?? [];
}

const ms = (iso: string | undefined): number | undefined => { const at = Date.parse(iso ?? ""); return Number.isFinite(at) ? at : undefined; };
/** The catalog rows the check-in reads, from the daemon's sessions. */
export function sessionRows(sessions: readonly DaemonSession[]): SessionRow[] {
  return sessions.map(session => ({ id: session.sessionId, name: (session.sessionName || session.firstMessage || session.sessionId).trim(),
    archived: session.lifecycle === "archived", working: session.activity === "working", messageCount: session.messageCount ?? 0,
    ...(session.lastActivityAt ? { lastActivityAt: session.lastActivityAt } : {}) }) as SessionRow);
}
/** A chat's direct subagents still listed (a deleted job is archived), as the server's child snapshots. */
export function chatChildren(sessions: readonly DaemonSession[], chatId: string): ChildAgent[] {
  return sessions.filter(session => session.parentSessionId === chatId && session.rlmChildId && session.lifecycle !== "archived").map(session => {
    const at = ms(session.lastActivityAt);
    return { id: session.rlmChildId!, label: session.sessionName ?? session.rlmChildId!, ...(session.sessionName ? { sessionName: session.sessionName } : {}),
      status: session.activity === "working" ? "running" : "done", ...(at !== undefined ? { lastActivityAt: at } : {}) } as ChildAgent;
  });
}

/**
 * The classes of every chat in `<dataDir>/chats.json` (or only `chats`). The duty's misses: orphan steps; due steps whose waitUntil passed more
 * than one tick ago; stale chases of 24 h or more (a step with an open For you todo is `foryou`, never a chase); and steps whose job ended more
 * than one tick ago, after the step last changed: `job_end_silent` when the server told that end as a bad one, else `job_end_unrecorded`.
 */
export async function boardClasses(options: { dataDir: string; now: number; sessions: () => DaemonSession[]; chats?: readonly string[] }): Promise<ChatClasses[]> {
  const { dataDir, now } = options;
  const listed = JSON.parse(await readFile(join(dataDir, "chats.json"), "utf8").catch(() => "{}")) as { ids?: unknown };
  const ids = (options.chats ?? (Array.isArray(listed.ids) ? listed.ids : [])).filter((id): id is string => typeof id === "string" && /^[\w-]+$/.test(id));
  const boards = new BoardStore(dataDir);
  const memory = checkInRecord(join(dataDir, "check-ins.json"));
  const settings = checkInSettings(join(dataDir, "check-in-settings.json"));
  let sessions: DaemonSession[] | undefined;
  const result: ChatClasses[] = [];
  for (const id of ids) {
    const board = await boards.read(id).catch(() => null);
    const memo = await memory.get(id);
    const told = await memory.ends(id);
    const everyMs = (await settings.get(id)).everyMs;
    const firstSeen = Date.parse(board?.updatedAt ?? "") || now;
    const hasOpen = JSON.stringify(board?.plan ?? []).match(/"status":"(?:todo|doing|blocked)"/) !== null;
    sessions ??= hasOpen ? options.sessions() : undefined;
    const rows = sessionRows(sessions ?? []);
    const name = rows.find(row => row.id === id)?.name ?? id;
    const facts = jobFacts(chatChildren(sessions ?? [], id), board, rows, id);
    const steps = classifyBoard(board, facts, item => memo?.steps[item.id]?.at ?? firstSeen, new Set([id, name]), rows, now);
    const counts = Object.fromEntries(STEP_CLASSES.map(cls => [cls, 0])) as Record<StepClass, number>;
    const misses: ConvergenceMisses = { ...NO_MISSES };
    const flagged: FlaggedSlice[] = [];
    const flag = (kind: keyof ConvergenceMisses, view: StepView, excerpt: string) => { misses[kind]++; flagged.push({ chat: id, at: now, kind, excerpt }); };
    for (const view of steps) {
      counts[view.cls]++;
      const line = classLine(view, now) ?? `${view.item.id} ${view.cls}`;
      if (view.cls === "orphan") flag("orphan_steps", view, line);
      if (view.cls === "due" && now - Date.parse(view.item.waitUntil!) > everyMs) flag("due_late", view, line);
      if (view.cls === "stale-chase" && now - view.changedAt >= CHASE_ESCALATE_MS) flag("stale_chase_24h", view, line);
      const owner = view.owner;
      const silent = owner && owner.state !== "working" ? told[owner.key] : undefined;
      if (silent && silent.at > view.changedAt) {
        if (now - silent.at > everyMs) {
          flag("job_end_silent", view, `${view.item.id} "${view.item.text.slice(0, 60)}": job ${owner!.name} ${jobEndWords(silent)} ${Math.round((now - silent.at) / 60_000)} min ago with no report and the step has not changed since`);
        }
        continue;
      }
      const end = owner && !owner.key.startsWith("thread:") && owner.state !== "working" && !owner.cancelled && !holdsOnWait(view.item, now) ? owner.activityAt : undefined;
      if (end !== undefined && end > view.changedAt && now - end > everyMs) {
        flag("job_end_unrecorded", view, `${view.item.id} "${view.item.text.slice(0, 60)}": job ${owner!.name} ended ${Math.round((now - end) / 60_000)} min ago and the step has not changed since`);
      }
    }
    result.push({ id, name, everyMs, open: steps.length, counts, misses, steps, flagged });
  }
  return result;
}

/** The text report: one line of counts per chat, then the line of each step the chat must act on. */
export function classesReport(chats: readonly ChatClasses[], now: number): string {
  const total = Object.fromEntries(STEP_CLASSES.map(cls => [cls, 0])) as Record<StepClass, number>;
  const lines = [`Board classes at ${new Date(now).toISOString()}`, ""];
  for (const chat of chats) {
    for (const cls of STEP_CLASSES) total[cls] += chat.counts[cls];
    const misses = Object.entries(chat.misses).map(([key, value]) => `${key} ${value}`).join(", ");
    lines.push(`${chat.id.slice(0, 8)} ${chat.name}: ${STEP_CLASSES.map(cls => `${cls} ${chat.counts[cls]}`).join(", ")} (open ${chat.open}); duty: ${misses}`);
    for (const view of chat.steps) if (ACT_CLASSES.has(view.cls)) lines.push(`  ${view.cls}: ${classLine(view, now)}`);
  }
  lines.push("", `All chats: ${STEP_CLASSES.map(cls => `${cls} ${total[cls]}`).join(", ")}`);
  return lines.join("\n") + "\n";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const arg = (name: string): string | undefined => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
  const now = arg("--now") ? Number(arg("--now")) : Date.now();
  const dataDir = arg("--data-dir") ?? process.env.BOARD_CLASSES_DATA_DIR ?? join(homedir(), ".prime/agent/browser-chat");
  const sessionsFile = arg("--sessions") ?? process.env.BOARD_CLASSES_SESSIONS_FILE;
  const loaded = sessionsFile ? parseLooseJson(await readFile(sessionsFile, "utf8")) as { sessions?: DaemonSession[] } | DaemonSession[] : undefined;
  const list = (): DaemonSession[] => loaded ? (Array.isArray(loaded) ? loaded : loaded.sessions ?? []) : daemonSessions();
  const chat = arg("--chat");
  const chats = await boardClasses({ dataDir, now, sessions: list, ...(chat ? { chats: [chat] } : {}) });
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stdout.write(classesReport(chats, now)); return; }
  const one = chats[0];
  const result: PrecheckOutput = { metrics: { ...(one?.misses ?? NO_MISSES) }, flagged: one?.flagged ?? [] };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
