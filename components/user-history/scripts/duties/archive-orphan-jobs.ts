import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DaemonClient, defaultDaemonSocketPath, SessionManager } from "prime-agent";
import { isTopLevel, parseSummaries } from "../../src/chat-catalog.ts";
import { DutyStore } from "../../src/chat-duty-store.ts";
import { jobRegistry } from "../../src/chat-sources.ts";
import { UNKNOWN_ACTIVE } from "../../src/chats.ts";
import { CHECK_IN_DUTY } from "../../src/shared/chat-duties.ts";

/**
 * `node --import tsx scripts/duties/archive-orphan-jobs.ts [--dry-run] [--data-dir <dir>]`: archives duty job sessions a timed-out create left
 * behind (10-09: six `check-in <chat> 01:5x` sessions with 0 messages): top-level sessions named like a duty job (`<duty> [chat] HH:MM`, see
 * dutyJobName), with no message, older than 15 min (longer than a duty job start can take, creates and lookups included), that chat-jobs.json does not list. Each is stopped and marked archived in its session file,
 * as the chat server's archive does. Running it twice changes nothing.
 */
const args = process.argv.slice(2);
const arg = (name: string): string | undefined => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const dryRun = args.includes("--dry-run");
const dataDir = arg("--data-dir") ? resolve(arg("--data-dir")!) : join(homedir(), ".prime/agent/browser-chat");
const MIN_AGE_MS = 15 * 60_000;

const store = new DutyStore(dataDir);
const duties = new Set([CHECK_IN_DUTY.name.trim().toLowerCase()]);
for (const chatId of await store.chats()) for (const duty of await store.list(chatId)) duties.add(duty.name.trim().toLowerCase());
const isDutyJobName = (name: string): boolean => /^.+ \d\d:\d\d$/.test(name) && [...duties].some(duty => name === duty || name.startsWith(duty + " "));
const registry = jobRegistry(join(dataDir, "chat-jobs.json"));

const client = new DaemonClient(defaultDaemonSocketPath());
await client.connect(10_000);
await client.waitForHello(10_000);
const listed = await client.request({ type: "list", all: true }, 180_000, { recoverable: false });
if (!listed.success) throw new Error(listed.error);
let archived = 0;
let failed = 0;
for (const session of parseSummaries(listed.data)) {
  const name = session.sessionName?.trim() ?? "";
  const age = Date.now() - Date.parse(session.created ?? "");
  if (!isTopLevel(session) || session.lifecycle === "archived" || session.messageCount !== 0 || !isDutyJobName(name) || !(age > MIN_AGE_MS)) continue;
  if (await registry.chatOf(session.sessionId) !== undefined || await registry.chatOf(name) !== undefined) continue;
  const label = `${session.sessionId} "${name}" (created ${session.created})`;
  if (dryRun) { process.stdout.write(`would archive ${label}\n`); archived++; continue; }
  try {
    if (session.activeSessionId) {
      const killed = await client.request({ type: "kill", activeSessionId: session.activeSessionId }, 180_000, { recoverable: false });
      if (!killed.success && !killed.error.startsWith(UNKNOWN_ACTIVE)) throw new Error(killed.error);
    }
    if (session.sessionFile && existsSync(session.sessionFile)) {
      const manager = SessionManager.open(session.sessionFile);
      if (manager.getSessionState()?.status !== "archived") manager.appendSessionState({ status: "archived" });
    }
    archived++;
    process.stdout.write(`archived ${label}\n`);
  } catch (error) {
    failed++;
    process.stdout.write(`failed ${label}: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
client.close();
process.stdout.write(`${archived} ${dryRun ? "to archive" : "archived"}${failed ? `, ${failed} failed` : ""}\n`);
if (failed) process.exitCode = 1;
