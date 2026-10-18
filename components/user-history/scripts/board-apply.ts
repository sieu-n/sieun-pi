import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BoardStore } from "../src/chat-board-store.ts";
import { jobNames } from "../src/limit-names.ts";
import { boardRevLine, parseBoardOps } from "../src/shared/chat-board.ts";
import { boardLimitFlag } from "../src/shared/reply-lint.ts";

/**
 * A duty job applies its board ops to its chat's board itself, with the same checks and flags as the chat's chat_board tool. Before, a duty job could
 * only list ops in its report for the chat to apply: in the 48 h to 10-14 02:13Z the chats dropped 401 of 3,287 such ops (12%), 9 reports
 * whole, and 267 of the dropped ops were wait changes (KPI job, session 1108-checkin-swarm-kpi).
 * `node --import tsx scripts/board-apply.ts <chatId> '<ops JSON array>' [--data-dir <dir>]` prints each op's summary and the board's revision.
 */
export async function applyDutyOps(dataDir: string, chatId: string, value: unknown): Promise<string> {
  const ops = parseBoardOps(value);
  if (!ops.length) throw new Error("Add a board op: the ops are a JSON array of chat_board ops.");
  const flag = boardLimitFlag(ops) && boardLimitFlag(ops, await jobNames(dataDir));
  const { board, summaries } = await new BoardStore(dataDir).apply(chatId, ops, "agent");
  return [...summaries, ...(flag ? [flag] : []), ...(board ? [boardRevLine(board)] : [])].join("\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const at = args.indexOf("--data-dir");
  const dataDir = at >= 0 ? args.splice(at, 2)[1]! : join(homedir(), ".prime/agent/browser-chat");
  const [chatId, json] = args;
  if (!chatId || !json) throw new Error("usage: board-apply.ts <chatId> '<ops JSON array>' [--data-dir <dir>]");
  process.stdout.write(await applyDutyOps(dataDir, chatId, JSON.parse(json)) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
