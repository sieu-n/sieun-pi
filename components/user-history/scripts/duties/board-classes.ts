import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BoardStore } from "../../src/chat-board-store.ts";
import { ACT_CLASSES, checkInRecord, checkInSettings, classCounts, classifyBoard, classLine, type ConvergenceMisses, convergenceMisses, jobFacts, scopeMisses, STEP_CLASSES,
  type StepClass, type StepView } from "../../src/chat-checkin.ts";
import { CorrectionLedger, handoffRules } from "../../src/chat-corrections.ts";
import type { FlaggedSlice } from "../../src/shared/chat-duties.ts";
import type { ChildAgent, SessionRow } from "../../src/shared/types.ts";

/**
 * Board classes: every open leaf step of every chat board in one class (`stepClass`), from the boards, the check-in memory (each step's last
 * change), the check-in settings (one tick is the chat's interval) and the daemon's session list (jobs and threads).
 *
 * Chat health sums the check-in duty's misses over every chat from here, apart from the check-ins themselves, so a check-in that stops running
 * still shows. `node --import tsx scripts/duties/board-classes.ts [--chat <id>] [--data-dir <dir>] [--sessions <file>] [--now <ms>]` prints
 * the counts per chat and a line per step to act on.
 */

/** The fields of one `prime-agent sessions --json` entry the classes read. */
export interface DaemonSession {
  sessionId: string; sessionName?: string; firstMessage?: string; lifecycle?: string; activity?: string; lastActivityAt?: string;
  messageCount?: number; parentSessionId?: string; rlmChildId?: string;
}
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
/**
 * The sessions at work: each working session and every session above it. A job whose own turn ended while its subagent runs is working, as the
 * server's catalog counts it (`isWorking` with the subtree); 10-09 the job google serp idled at 14:02Z waiting on its exp-http-final subagent and
 * this duty called its step an orphan.
 */
export function workingSessions(sessions: readonly DaemonSession[]): Set<string> {
  const parent = new Map(sessions.map(session => [session.sessionId, session.parentSessionId]));
  const working = new Set<string>();
  for (const session of sessions) {
    if (session.activity !== "working" || session.lifecycle === "archived") continue;
    for (let id: string | undefined = session.sessionId; id !== undefined && !working.has(id); id = parent.get(id)) working.add(id);
  }
  return working;
}

/** The catalog rows the check-in reads, from the daemon's sessions. */
export function sessionRows(sessions: readonly DaemonSession[]): SessionRow[] {
  const working = workingSessions(sessions);
  return sessions.map(session => ({ id: session.sessionId, name: (session.sessionName || session.firstMessage || session.sessionId).trim(),
    archived: session.lifecycle === "archived", working: working.has(session.sessionId), messageCount: session.messageCount ?? 0,
    ...(session.lastActivityAt ? { lastActivityAt: session.lastActivityAt } : {}) }) as SessionRow);
}
/** A chat's direct subagents still listed (a deleted job is archived), as the server's child snapshots. */
export function chatChildren(sessions: readonly DaemonSession[], chatId: string): ChildAgent[] {
  const working = workingSessions(sessions);
  return sessions.filter(session => session.parentSessionId === chatId && session.rlmChildId && session.lifecycle !== "archived").map(session => {
    const at = ms(session.lastActivityAt);
    return { id: session.rlmChildId!, label: session.sessionName ?? session.rlmChildId!, ...(session.sessionName ? { sessionName: session.sessionName } : {}),
      status: working.has(session.sessionId) ? "running" : "done", ...(at !== undefined ? { lastActivityAt: at } : {}) } as ChildAgent;
  });
}

/** The classes of every chat in `<dataDir>/chats.json` (or only `chats`), with the check-in duty's misses (`convergenceMisses`). */
export async function boardClasses(options: { dataDir: string; now: number; sessions: () => DaemonSession[]; chats?: readonly string[] }): Promise<ChatClasses[]> {
  const { dataDir, now } = options;
  const listed = JSON.parse(await readFile(join(dataDir, "chats.json"), "utf8").catch(() => "{}")) as { ids?: unknown };
  const ids = (options.chats ?? (Array.isArray(listed.ids) ? listed.ids : [])).filter((id): id is string => typeof id === "string" && /^[\w-]+$/.test(id));
  const boards = new BoardStore(dataDir);
  const memory = checkInRecord(join(dataDir, "check-ins.json"));
  const settings = checkInSettings(join(dataDir, "check-in-settings.json"));
  const handoffs = handoffRules(await new CorrectionLedger(dataDir).read());
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
    const { metrics: misses, flagged } = convergenceMisses(id, steps, scopeMisses(board, handoffs, [id, name]), told, everyMs, now);
    result.push({ id, name, everyMs, open: steps.length, counts: classCounts(steps), misses, steps, flagged });
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
    for (const slice of chat.flagged) if (slice.kind === "scope_misses") lines.push(`  scope: ${slice.excerpt}`);
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
  process.stdout.write(classesReport(await boardClasses({ dataDir, now, sessions: list, ...(chat ? { chats: [chat] } : {}) }), now));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
