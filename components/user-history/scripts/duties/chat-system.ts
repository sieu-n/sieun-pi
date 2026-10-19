import { existsSync, readdirSync } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { planRiskSteps } from "../../src/checkin-findings.ts";
import { OPEN, walk } from "../../src/checkin-steps.ts";
import { listedSessions } from "../../src/daemon-faults.ts";
import { ownerChats } from "../../src/owner-chats.ts";
import { chatDataDir } from "../../src/owner-ok.ts";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import type { ChatBoard, PlanItem } from "../../src/shared/types.ts";
import { upkeepWords } from "../../src/shared/upkeep-title.ts";
import { daemonSessions, dutyFleet, type FleetDuty } from "./duty-fleet.ts";
import { catalogCopies, planCounts, planInputs } from "./whole-system.ts";

/**
 * The precheck of the AI harness chat's Chat system duty (d9). The owner on 10-19 (msg mvfb7zt0): "plan should be tasks all eventually clear -
 * duties are things that need constant montiroing thus set a heartbeat ... ALL PLANS SHOULD BE EPHEMERAL ... keeping this compliant on it's own
 * your duty. 당분간은 몰래 실사 감시도 하고". Across the owner's chats on both boxes (one chat service holds every board) it counts the open steps
 * nobody moves (headline), the open plan items that are upkeep or have no done line, the share of green duties, and the red duties with no live
 * fix job. Each metric flags at most 3 examples, spread over chats, and the detail file next to OUTPUT_FILE lists them all. Each run also
 * picks one chat at random for the duty job's quiet spot audit and writes that chat's files and the owner's last messages in it there.
 */

/** Examples per metric in the flagged slices; the detail file lists every item. The owner's c75 shape for a duty run's summary. */
const EXAMPLES = 3;
/** The owner messages of the spot audit chat the detail quotes, newest last. */
const OWNER_MESSAGES = 8;
/** How much of a transcript's end the spot audit reads for those messages: the AI harness chat's last 3 MB held 42 user lines on 10-19. */
const TRANSCRIPT_TAIL_BYTES = 4_000_000;
const MIRROR_DIR = join(homedir(), ".cache/sieun-pi/hosts");

/** An open plan item that breaks the plan rule (board skill, references/plan-and-duties.md): its chat, id, title and the reason. */
export interface PlanFlag { chat: string; id: string; text: string; why: string }

/** A done line is a "Done when" note, a target, or a duty metric the step fixes, whose green run is its check. */
const hasDoneLine = (item: PlanItem): boolean => !!item.target || !!item.duty || /\bdone when\b/i.test(item.note ?? "");

/** The open items of a chat's plan that are upkeep, a standing risk, or a step with no done line, each once. */
export function planUpkeep(chat: string, board: ChatBoard | null): PlanFlag[] {
  const risks = new Set(planRiskSteps(board).map(item => item.id));
  const found: PlanFlag[] = [];
  walk(board?.plan ?? [], item => {
    if (!OPEN.has(item.status)) return;
    const words = upkeepWords(item.text);
    const why = words ? `reads like upkeep ("${words.trim()}")` : risks.has(item.id) ? "holds a standing risk or a resolved alert" : hasDoneLine(item) ? null : "has no Done when line";
    if (why) found.push({ chat, id: item.id, text: item.text, why });
  });
  return found;
}

/** Up to `count` items, one chat at a time in turn, so the examples show as many chats as they can. */
export function spread<T extends { chat: string }>(items: readonly T[], count: number): T[] {
  const byChat = new Map<string, T[]>();
  for (const item of items) byChat.set(item.chat, [...byChat.get(item.chat) ?? [], item]);
  const queues = [...byChat.values()];
  const out: T[] = [];
  for (let round = 0; out.length < count && queues.some(queue => queue.length > round); round++) {
    for (const queue of queues) if (queue[round] && out.length < count) out.push(queue[round]!);
  }
  return out;
}

const quote = (text: string): string => `"${text.length > 80 ? `${text.slice(0, 79)}…` : text}"`;
const show = (value: number): string => String(Math.round(value * 10) / 10);

/** The owner's own messages in a transcript's last lines: user lines that no job, check-in or tool wrote ("[job] ..."), and his board picks. */
export function ownerMessages(lines: readonly string[], count: number): { at: string; text: string }[] {
  const out: { at: string; text: string }[] = [];
  for (const line of lines) {
    let entry: { timestamp?: string; message?: { role?: string; content?: unknown } };
    try { entry = JSON.parse(line) as typeof entry; } catch { continue; }
    if (entry.message?.role !== "user") continue;
    const content = entry.message.content;
    const text = (typeof content === "string" ? content : Array.isArray(content) ? content.map(part => (part as { text?: unknown }).text).filter(t => typeof t === "string").join(" ") : "").trim();
    if (!text || (text.startsWith("[") && !text.startsWith("[board] Owner"))) continue;
    out.push({ at: entry.timestamp ?? "", text: text.length > 600 ? `${text.slice(0, 599)}…` : text });
  }
  return out.slice(-count);
}

async function tail(file: string, bytes: number): Promise<string[]> {
  const handle = await open(file, "r").catch(() => null);
  if (!handle) return [];
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    return start > 0 ? lines.slice(1) : lines;
  } finally { await handle.close(); }
}

/** A session file on this box, or this box's copy of another box's (src/host-catalogs.ts `mirrorPath`), with the box it runs on. */
function localCopy(file: string | undefined): { file: string; host: string } | undefined {
  if (!file) return undefined;
  if (existsSync(file)) return { file, host: "this box" };
  for (const host of (() => { try { return readdirSync(MIRROR_DIR); } catch { return []; } })()) {
    const copy = join(MIRROR_DIR, host, file);
    if (existsSync(copy)) return { file: copy, host };
  }
  return undefined;
}

export interface ChatSystemFacts {
  names: ReadonlyMap<string, string>;
  stuck: readonly { chat: string; id?: string; text?: string; count?: number }[];
  upkeep: readonly PlanFlag[];
  fleet: { pct: number; red: readonly FleetDuty[] };
  stuckDuties: readonly { chat: string; line: string }[];
  detail: string;
}

/** The precheck output from the facts: the four metrics, and per metric a count line with the detail path and up to 3 examples. */
export function chatSystemOutput(facts: ChatSystemFacts): PrecheckOutput {
  const name = (chat: string): string => facts.names.get(chat) ?? chat.slice(0, 8);
  const stuckCount = facts.stuck.reduce((sum, entry) => sum + (entry.count ?? 1), 0);
  const flagged: FlaggedSlice[] = [];
  const head = (kind: string, count: number, what: string, chats: number) => {
    if (count) flagged.push({ kind, excerpt: `${count} ${what} in ${chats} ${chats === 1 ? "chat" : "chats"}; every one is in ${facts.detail}.` });
  };
  const chats = (items: readonly { chat: string }[]) => new Set(items.map(item => item.chat)).size;
  head("stuck_steps", stuckCount, "open steps nobody moves", chats(facts.stuck));
  for (const entry of spread(facts.stuck, EXAMPLES)) {
    flagged.push({ kind: "stuck_steps", chat: entry.chat, ...entry.id ? { item: entry.id } : {},
      excerpt: entry.id ? `${name(entry.chat)}: ${entry.id} ${quote(entry.text ?? "")} is open and nobody moves it.` : `${name(entry.chat)}: ${entry.count} open steps nobody moves.` });
  }
  head("plan_upkeep", facts.upkeep.length, "open plan items that are upkeep or have no done line", chats(facts.upkeep));
  for (const item of spread(facts.upkeep, EXAMPLES)) flagged.push({ kind: "plan_upkeep", chat: item.chat, item: item.id, excerpt: `${name(item.chat)}: ${item.id} ${quote(item.text)} ${item.why}.` });
  head("red_duty", facts.fleet.red.length, "red duties", chats(facts.fleet.red));
  for (const duty of spread(facts.fleet.red, EXAMPLES)) {
    flagged.push({ kind: "red_duty", chat: duty.chat, item: duty.duty, excerpt: `${name(duty.chat)}: ${duty.name} (${duty.duty}) is red` +
      (duty.metric ? `, ${duty.metric.key} ${show(duty.metric.value)} against ${duty.metric.op} ${show(duty.metric.target)}` : "") + `, ${duty.misses === 1 ? "1 run" : `${duty.misses} runs in a row`}.` });
  }
  head("stuck_duty", facts.stuckDuties.length, "red duties with no live fix job", chats(facts.stuckDuties));
  for (const duty of spread(facts.stuckDuties, EXAMPLES)) flagged.push({ kind: "stuck_duty", chat: duty.chat, excerpt: `${duty.line}.` });
  return {
    metrics: { stuck_steps_all: stuckCount, plan_upkeep_all: facts.upkeep.length, duties_green_pct: facts.fleet.pct, stuck_duties: facts.stuckDuties.length },
    flagged,
  };
}

const today = (now: number): string => new Date(now).toISOString().slice(0, 10);
const section = (title: string, lines: readonly string[]): string => [`## ${title}`, "", ...lines.length ? lines.map((line, index) => `${index + 1}. ${line}`) : ["None."], ""].join("\n");

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("chat-system: OUTPUT_FILE is not set\n"); process.exit(2); }
  const now = Date.now();
  const dataDir = chatDataDir();
  const detail = `${output.replace(/\.json$/, "")}.md`;
  const copies = await catalogCopies(dataDir);
  const ids = await ownerChats(dataDir);
  const listed = listedSessions(copies, ids);
  const names = new Map(ids.map(id => [id, listed.get(id)?.name ?? id.slice(0, 8)] as const));
  const plan = await planInputs(dataDir, now, names);
  const counts = planCounts(plan);
  const text = (chat: string, id: string): string | undefined => {
    let found: string | undefined;
    walk(plan.boards.get(chat)?.plan ?? [], item => { if (item.id === id) found = item.text; });
    return found;
  };
  const stuck = counts.stuck.flatMap((entry): ChatSystemFacts["stuck"] => entry.items.length
    ? entry.items.map(id => ({ chat: entry.chat.id, id, text: text(entry.chat.id, id) ?? "" }))
    : [{ chat: entry.chat.id, count: entry.value }]);
  const upkeep = plan.chats.filter(chat => !plan.pausedChats.has(chat.id)).flatMap(chat => planUpkeep(chat.id, plan.boards.get(chat.id) ?? null));
  const fleet = await dutyFleet({ dataDir, now, sessions: daemonSessions });
  const red = fleet.duties.filter(duty => !duty.green && !duty.pending);
  const result = chatSystemOutput({ names, stuck, upkeep, fleet: { pct: fleet.metrics.duties_green_pct, red }, stuckDuties: counts.redDuties, detail });

  // The spot audit: one owner chat at random each run, read by the duty job against what the owner asked in it.
  const spot = ids[Math.floor(Math.random() * ids.length)]!;
  const transcript = localCopy(listed.get(spot)?.file);
  const asks = transcript ? ownerMessages(await tail(transcript.file, TRANSCRIPT_TAIL_BYTES), OWNER_MESSAGES) : [];
  const log = join(homedir(), "work/plan-audit/spot", `${today(now)}.md`);
  await mkdir(join(homedir(), "work/plan-audit/spot"), { recursive: true });
  result.flagged!.push({ kind: "spot_audit", chat: spot, excerpt: `Spot audit this run: ${names.get(spot)} (${spot}). Its files and the owner's last messages in it are in ${detail}; ` +
    `log what you found to ${log}, and send the owner nothing.` });

  const name = (chat: string): string => names.get(chat) ?? chat.slice(0, 8);
  const md = [
    `# Chat system run of ${new Date(now).toISOString()}`, "",
    `stuck_steps_all ${result.metrics.stuck_steps_all}, plan_upkeep_all ${result.metrics.plan_upkeep_all}, duties_green_pct ${result.metrics.duties_green_pct}, ` +
      `stuck_duties ${result.metrics.stuck_duties}, over ${ids.length} chats.`, "",
    `## Spot audit: ${name(spot)}`, "",
    `1. The chat is ${spot}, and it runs on ${transcript?.host ?? "a box whose transcript this box has no copy of"}.`,
    `2. Its plan is ${join(dataDir, "boards", `${spot}.json`)}.`,
    `3. Its duties are ${join(dataDir, "duties", `${spot}.json`)}, and their runs are ${join(dataDir, "duties", `${spot}.runs.jsonl`)}.`,
    `4. Its transcript is ${transcript?.file ?? "not on this box"}.`,
    "5. Read its open plan, its duties and their last runs, and its last turns, and compare them with the owner's asks below.",
    "6. Fix what is off: a step that is upkeep, a step with no done line or no live owner, a duty that checks something the owner did not ask for or misses what he did, a red duty with no fix job, and an ask of his that nothing on the board carries.",
    `7. Append what you found and what you fixed to ${log}, under a heading with the time and the chat's name, and send the owner nothing.`, "",
    "The owner's last messages in it, newest last:", "",
    ...asks.length ? asks.map(ask => `- ${ask.at}: ${JSON.stringify(ask.text)}`) : ["- None found in the transcript's last 4 MB."], "",
    section(`Open steps nobody moves (${result.metrics.stuck_steps_all})`, stuck.map(entry => entry.id
      ? `${name(entry.chat)}: ${entry.id} ${quote(entry.text ?? "")}.` : `${name(entry.chat)}: ${entry.count} open steps nobody moves, with no ids in its check-in.`)),
    section(`Open plan items that are upkeep or have no done line (${upkeep.length})`, upkeep.map(item => `${name(item.chat)}: ${item.id} ${quote(item.text)} ${item.why}.`)),
    section(`Red duties (${red.length}, ${fleet.metrics.duties_green_pct}% green)`, red.map(duty => `${name(duty.chat)}: ${duty.name} (${duty.duty}), ` +
      `${duty.metric ? `${duty.metric.key} ${show(duty.metric.value)} against ${duty.metric.op} ${show(duty.metric.target)}, ` : ""}${duty.misses === 1 ? "1 run" : `${duty.misses} runs in a row`}` +
      `${duty.fix ? `, fix step ${duty.fix}` : duty.working ? `, its job ${duty.working} works on it` : ""}.`)),
    section(`Red duties with no live fix job (${counts.redDuties.length})`, counts.redDuties.map(duty => `${duty.line}.`)),
  ].join("\n");
  await writeFile(detail, md);
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
