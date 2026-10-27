import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "../src/chat-board-store.ts";
import { ALERT_GOAL_TEXT } from "../src/checkin-findings.ts";
import { findItem, walkItems } from "../src/shared/chat-board.ts";
import type { BoardOp, ChatBoard, PlanItem } from "../src/shared/types.ts";

/**
 * `node --import tsx scripts/alert-bridge-unstep.ts [--data-dir <dir>]`: moves the alert bridge off the plan, run once around the release that
 * stopped it filing steps (owner 10-18: "stop being paranoid in plan under p45, p221"). Running it again changes nothing.
 *
 * 1. Each rule in alert-bridge.json whose step a job held gets that job as its triage job (`job`), so the new bridge sends that job the next
 *    fire and starts no second job for it.
 * 2. Every open step the bridge filed, on every board, closes as dropped with the note line below, and each "Firing prod alerts" goal left
 *    with no open step closes too.
 */
const NOTE = "moved to the duty; the alert's triage job holds it";
const MARK = /^Grafana alert (?:rule .+|[\w-]{1,64}), firing since \S+\.$/m;
const OPEN = new Set(["todo", "doing", "blocked"]);

const at = process.argv.indexOf("--data-dir");
const dataDir = at > 0 ? process.argv[at + 1]! : join(homedir(), ".prime/agent/browser-chat");
const stateFile = join(dataDir, "alert-bridge.json");
const boards = new BoardStore(dataDir);
const now = Date.now();

type Rule = { chat: string; step?: string | null; job?: { id: string; name: string; at: number } };
const state = JSON.parse(await readFile(stateFile, "utf8")) as { v: number; rules: Record<string, Rule> };
const filed = new Map<string, Set<string>>();
let adopted = 0;
for (const rule of Object.values(state.rules)) {
  if (typeof rule.step !== "string") continue;
  filed.set(rule.chat, (filed.get(rule.chat) ?? new Set()).add(rule.step));
  if (rule.job) continue;
  const item = findItem((await boards.read(rule.chat))?.plan ?? [], rule.step)?.item;
  if (item?.job && item.sessionId) { rule.job = { id: item.sessionId, name: item.job, at: now }; adopted++; }
}
const temporary = `${stateFile}.unstep.tmp`;
await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
await rename(temporary, stateFile);
process.stdout.write(`adopted ${adopted} step jobs as triage jobs\n`);

const bridgeStep = (chat: string, item: PlanItem): boolean => !item.children.length && (MARK.test(item.note ?? "") || filed.get(chat)?.has(item.id) === true);
const line = (note: string | undefined): string => note ? `${note}\n${NOTE}` : NOTE;

function closeOps(chat: string, board: ChatBoard): BoardOp[] {
  const ops: BoardOp[] = [];
  const closing = new Set<string>();
  walkItems(board.plan, item => {
    if (!OPEN.has(item.status) || !bridgeStep(chat, item)) return;
    closing.add(item.id);
    ops.push({ op: "plan_update", id: item.id, status: "dropped", note: line(item.note) });
  });
  for (const goal of board.plan) {
    if (goal.text.trim() !== ALERT_GOAL_TEXT || !OPEN.has(goal.status)) continue;
    let open = false;
    walkItems(goal.children, item => { if (OPEN.has(item.status) && !item.children.length && !closing.has(item.id)) open = true; });
    if (!open) ops.push({ op: "plan_update", id: goal.id, status: "done", note: line(goal.note) });
  }
  return ops;
}

for (const file of (await readdir(join(dataDir, "boards"))).filter(name => /^[\w-]+\.json$/.test(name))) {
  const chat = file.slice(0, -".json".length);
  const board = await boards.read(chat).catch(() => null);
  if (!board || !closeOps(chat, board).length) continue;
  let closed: string[] = [];
  await boards.apply(chat, current => {
    const ops = closeOps(chat, current);
    closed = ops.flatMap(op => op.op === "plan_update" ? [op.id] : []);
    return ops;
  }, "agent");
  process.stdout.write(`${chat}: closed ${closed.length}: ${closed.join(", ")}\n`);
}
