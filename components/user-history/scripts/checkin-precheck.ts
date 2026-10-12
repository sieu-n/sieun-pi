/**
 * Runs one chat's check-in precheck against its live board and the live daemon rows, and prints what the check-in job would get, without
 * starting a duty job, sending any message or writing the service's files (memory, settings and loads go to copies in a temp folder).
 *
 *   cd components/user-history && node --import tsx scripts/checkin-precheck.ts <chat id> [--roster]
 *
 * `--roster` reads only the daemon's live sessions (about 1 MB, under a second); the default full list is what the service reads, and can take
 * a minute under load. The chat's messages are the tail of its session file. Prints the step classes, the flagged items and the findings markdown.
 */
import { copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient, defaultDaemonSocketPath, getAgentDir } from "prime-agent";
import { loadRecord } from "../src/chat-brief.ts";
import { BoardStore } from "../src/chat-board-store.ts";
import { childrenByParent, isListed, isTopLevel, parseSummaries, projectRow, rosterChildren, subtreeOf } from "../src/chat-catalog.ts";
import { checkInRecord } from "../src/chat-checkin.ts";
import { historyMessages } from "../src/chat-threads.ts";
import { CorrectionLedger } from "../src/chat-corrections.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { type ChatThreads, type CheckInSource, jobRegistry, replyCheckRecord } from "../src/chat-sources.ts";
import { checkInSettings } from "../src/checkin-settings.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import { readBranchTail } from "../src/session-tail.ts";

const chat = process.argv[2];
if (!chat || chat.startsWith("-")) { process.stderr.write("usage: node --import tsx scripts/checkin-precheck.ts <chat id> [--roster]\n"); process.exit(2); }
const dataDir = join(getAgentDir(), "browser-chat");
const scratch = await mkdtemp(join(tmpdir(), "checkin-precheck-"));
const copy = async (name: string) => { await copyFile(join(dataDir, name), join(scratch, name)).catch(() => {}); return join(scratch, name); };

const client = new DaemonClient(defaultDaemonSocketPath());
await client.connect(30_000);
const all = !process.argv.includes("--roster");
const response = await client.request(all ? { type: "list", all: true } : { type: "list" }, 180_000, { recoverable: false });
client.close();
if (!response.success) throw new Error(response.error);
const summaries = parseSummaries(response.data);
const children = summaries.filter(row => !isTopLevel(row));
const byParent = childrenByParent(children);
const top = new Map<string, (typeof summaries)[number]>();
for (const row of summaries) if (isTopLevel(row) && isListed(row) && (!top.has(row.sessionId) || row.activeSessionId !== undefined)) top.set(row.sessionId, row);
const chatIds = await new IdIndex(join(dataDir, "chats.json"), "Chat index").ids();
const rows = [...top.values()].map(row => projectRow(row, undefined, 0, { subtree: subtreeOf(row, byParent), ...(chatIds.includes(row.sessionId) ? { chat: true } : {}) }));

const index = new IdIndex(join(scratch, "chats.json"), "Chat index");
await index.add(chat);
// The chat's own messages come from the tail of its session file, as an attached thread holds them, so job reports count (`lastJobMessages`).
const tail = await readBranchTail(join(getAgentDir(), "sessions", `${chat}.jsonl`)).catch(() => undefined);
const messages = tail ? historyMessages(tail.entries) : [];
// Every other thread call is a no-op: the precheck reads, and nothing is prompted, reloaded or deleted.
const threads = {
  state: (id: string) => id === chat ? { messages } : undefined, async view() { return null; }, busy: () => false, running: () => false, setWait() {}, isLive: () => false,
  async restart() {}, async prompt() {}, async notice() {}, async deleteSubagent() {}, pin: () => false, unpin() {}, async setSteeringMode() {},
  async heartbeat() { return undefined; }, async clearHeartbeat() {}, async reload() {}, observe() { return () => {}; },
} as unknown as ChatThreads;
const boards = new BoardStore(dataDir);
const duties = new DutyStore(dataDir);
const corrections = new CorrectionLedger(dataDir);
let printed = false;
const source: CheckInSource = {
  board: id => boards.read(id), rows: async () => rows, registry: jobRegistry(join(dataDir, "chat-jobs.json")),
  memory: checkInRecord(await copy("check-ins.json")), replyChecks: replyCheckRecord(await copy("reply-checks.json")),
  settings: checkInSettings(await copy("check-in-settings.json")), tickMs: 0, noReportGraceMs: 60 * 60_000,
  corrections: () => corrections.read(), duties: id => duties.list(id),
  dutyJobs: async id => (await duties.runs(id)).flatMap(run => run.job ? [run.job.id] : []),
  duty: { async checkIn(_id, run) {
    printed = true;
    process.stdout.write(`classes ${JSON.stringify(run.classes)}\n`);
    for (const slice of run.output.flagged) process.stdout.write(`flagged ${slice.kind} ${slice.item ?? ""} ${slice.excerpt}\n`);
    process.stdout.write(`\n${run.findings}\n`);
  } },
};
const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "precheck", loadRecord(join(scratch, "extension-loads.json")), source,
  line => process.stderr.write(line + "\n"));
await chats.roster(rosterChildren(children));
await chats.runCheckIn(chat);
await chats.settled();
chats.close();
if (!printed) process.stdout.write("no check-in ran: the chat has nothing to check, or the log above says why\n");
