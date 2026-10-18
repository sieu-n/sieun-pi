import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatBoard, PlanItem } from "../../src/shared/types.ts";
import { readSession, type RunState, type Scenario, type SessionEvent, type Verdict } from "./session-read.ts";
import { flagHits, names, reportShape, stepIdLists } from "./text-checks.ts";

/**
 * The check-in push against a control (owner 10-16: "so error i 1) check in logic of their session 2) incompetance in our check in logic that
 * didn't push the coordinator job"). Two chats open at the same minute with ordinary research tasks that carry a number; the control's
 * check-in is paused. The criteria live in the run folder's criteria.md, written before the run.
 */
const gapsTask = (platform: string): string => `research which of our ${platform} index gaps matter most and keep a page with the top 10 updated. ` +
  "measure each gap's size from real data, i want all 10 measured by tomorrow";
/**
 * A code-reading task with no prod reads: in r3e on 10-18 both gaps chats ran full scans on prod Postgres and ClickHouse while the crawl push
 * needed the box, and Crawler VP and fix4-research-queries messaged them to stop, which voided the run. Its 15 items take several rounds, so a
 * job that writes a batch and goes quiet leaves the number short without a push (k).
 */
const failuresTask = (platform: string): string => `go through our ${platform} crawler code and keep a page of every way it breaks when ${platform} changes ` +
  "something, each with the file that handles it and what we'd see. just read the code, no prod queries. i want 15 of them written up by tomorrow";
/** One task per chat name, so a rerun gets new chats and a platform no earlier run left a top 10 page for (r3 left Instagram's at 10 of 10). */
export const TASKS: Record<string, string> = { "Instagram index gaps": gapsTask("instagram"), "TikTok Shop index gaps": gapsTask("tiktok shop"),
  "YouTube index gaps": gapsTask("youtube"), "TikTok index gaps": gapsTask("tiktok"), "LinkedIn index gaps": gapsTask("linkedin"),
  "Facebook index gaps": gapsTask("facebook"), "Xiaohongshu index gaps": gapsTask("xiaohongshu"), "Douyin index gaps": gapsTask("douyin"), "Threads index gaps": gapsTask("threads"), "Pinterest index gaps": gapsTask("pinterest"),
  "Reddit index gaps": gapsTask("reddit"), "Bluesky index gaps": gapsTask("bluesky"), "Snapchat index gaps": gapsTask("snapchat"), "Twitch index gaps": gapsTask("twitch"),
  "YouTube crawler failures": failuresTask("youtube"), "TikTok crawler failures": failuresTask("tiktok"), "Instagram crawler failures": failuresTask("instagram"),
  "LinkedIn crawler failures": failuresTask("linkedin") };
export const taskOf = (name: string): string => {
  const task = TASKS[name];
  if (!task) throw new Error(`no checkin-push-control task for the chat name "${name}"; known: ${Object.keys(TASKS).join(", ")}`);
  return task;
};
const SLOT_START_MS = 5 * 60_000;

const OPEN = new Set(["todo", "doing", "blocked"]);
const iso = (at: number): string => new Date(at).toISOString().slice(11, 19) + "Z";
const clip = (text: string, length = 300): string => (text.length > length ? text.slice(0, length - 1) + "…" : text).replace(/\s+/g, " ");
const amount = (value: number): string => value.toLocaleString("en-US", { maximumFractionDigits: 2, useGrouping: false });
const walk = (items: readonly PlanItem[], visit: (item: PlanItem, goal: PlanItem) => void, goal?: PlanItem): void => {
  for (const item of items) { visit(item, goal ?? item); walk(item.children, visit, goal ?? item); }
};
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const readJsonIds = (path: string): string[] => { try { const ids = readJson<{ ids?: unknown }>(path).ids; return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []; } catch { return []; } };
const listJson = <T>(dir: string): { at: number; value: T }[] => existsSync(dir)
  ? readdirSync(dir).sort().map(file => ({ at: Number(file.replace(".json", "")), value: readJson<T>(join(dir, file)) })) : [];

interface Snapshot { at: number; board: ChatBoard }
const snapshots = (dir: string): Snapshot[] => listJson<ChatBoard>(dir).map(({ value }) => ({ at: Date.parse(value.updatedAt) || 0, board: value })).sort((a, b) => a.at - b.at);
const boardAt = (all: readonly Snapshot[], at: number): ChatBoard | undefined => all.filter(snap => snap.at <= at).at(-1)?.board;
const goalsOf = (board: ChatBoard | undefined): PlanItem[] => (board?.plan ?? []).filter(goal => OPEN.has(goal.status) && goal.target);
/** The goal's number for the comparison: the first goal with a target, as a share of its target. */
const progress = (board: ChatBoard | undefined): number | null => {
  const goal = (board?.plan ?? []).find(item => item.target);
  return goal?.target?.current === undefined ? null : goal.target.current / (goal.target.target || 1);
};
const short = (goal: PlanItem): boolean => goal.target!.current === undefined || goal.target!.current < goal.target!.target;
function numberWords(goal: PlanItem): { need: string[]; any: string[]; text: string } {
  const target = goal.target!;
  if (target.current === undefined) return { need: [amount(target.target)], any: [], text: `target ${amount(target.target)}, not measured yet` };
  const gap = Math.abs(target.target - target.current);
  return { need: [amount(target.current), amount(target.target)], any: [amount(gap), String(Math.round(gap))], text: `${amount(target.current)} of ${amount(target.target)} ${target.unit}` };
}
const carries = (text: string, goal: PlanItem): boolean => {
  const words = numberWords(goal);
  return words.need.every(word => names(text, word)) && (!words.any.length || words.any.some(word => names(text, word)));
};
type Sent = Extract<SessionEvent, { kind: "sent" }>;
type Call = Extract<SessionEvent, { kind: "call" }>;
type Text = Extract<SessionEvent, { kind: "text" }>;
const STARTS = /create_session\(|rlm\.spawn\(/;
const STEER = /scripts\/job-steer\.ts/;
const BOARD_OP = /"op"\s*:\s*"(plan_|todo_)/;

export const checkinPushControl: Scenario = {
  name: "checkin-push-control",
  headMessage: name => taskOf(name),
  control: { name: "TikTok Shop index gaps", message: name => taskOf(name) },
  fixtures: [],
  setupNotes: state => [
    `# Run setup: ${state.chat.name} and ${state.control?.name}`, "",
    `Both chats were opened through POST api/threads in ${state.sandbox} on ${state.release} at the same minute, each with one owner-style first message and no seeded board, todo or fixture.`,
    `"${state.chat.name}" (${state.chat.id}) runs its check-in every ${state.everyMs / 60_000} min on the server's clock. "${state.control?.name}" (${state.control?.id}) is the control: the script paused its check-in right after it opened, through POST api/threads/<id>/check-in, as this job's session.`,
    "The owner asked on 10-16 for a run the system does alone (c84) and for a control without the check-in; no other chat's interval changed.", "",
    `## First messages`, "", `1. ${state.chat.name}: "${taskOf(state.chat.name)}"`, `2. ${state.control?.name}: "${taskOf(state.control?.name ?? "")}"`, "",
  ].join("\n"),
  evaluate: (run, state) => judge(run, state),
  baseline: () => { throw new Error("this scenario has no baseline"); },
};

interface Check { id: string; ok: boolean | null; detail: string }

/** Whether a session's last board.wake before `at` is still owed: it set one, and no `[wake]` message reached it between that and `at`. */
export function asleepAt(events: readonly SessionEvent[], at: number): boolean {
  const before = events.filter(event => event.at <= at);
  const set = before.findLast(event => event.kind === "call" && /\bboard\.wake\(/.test(event.input));
  if (!set) return false;
  return !before.some(event => event.at > set.at && event.kind === "text" && event.text.trimStart().startsWith("[wake]"));
}
const yes = (ok: boolean | null): string => ok === null ? "for the reader" : ok ? "met" : "not met";
interface Agent { sessionId?: string; name: string; state: string; key: string }

/**
 * The chat names and ids each root session in chat-jobs.json was started by, for `agentsOf`: the Agents card also lists a thread the board
 * links, such as another chat ("Crawler VP") or another chat's job, and in r3b on 10-17 those read as jobs of "YouTube index gaps", so 120
 * messages their own chats sent them voided the run as someone stepping in.
 */
function registeredChats(): Map<string, Set<string>> {
  const file = join(process.env.AGENT_CHAT_DATA_DIR ?? join(homedir(), ".prime/agent/browser-chat"), "chat-jobs.json");
  const jobs = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { jobs?: Record<string, { chat?: string; chatId?: string }> }).jobs ?? {} : {};
  return new Map(Object.entries(jobs).map(([key, entry]) => [key, new Set([entry.chat, entry.chatId].filter((value): value is string => typeof value === "string"))]));
}
/** The jobs a chat's Agents card listed over the run, apart from its check-in duty jobs: its subagents and the roots it registered. */
function agentsOf(dir: string, chat: { id: string; name: string }): { jobs: Map<string, string>; duty: Map<string, string>; first: Map<string, number> } {
  const jobs = new Map<string, string>(); const duty = new Map<string, string>(); const first = new Map<string, number>();
  const registry = registeredChats();
  const own = (agent: Agent): boolean => agent.key.startsWith("child:") || agent.name.startsWith(`check-in ${chat.name} `) ||
    [registry.get(agent.sessionId!), registry.get(agent.name)].some(chats => chats?.has(chat.id) || chats?.has(chat.name));
  for (const { at, value } of listJson<Agent[]>(dir)) for (const agent of value) {
    if (!agent.sessionId || !own(agent)) continue;
    if (!first.has(agent.sessionId)) first.set(agent.sessionId, at);
    (/^check-in /.test(agent.name) ? duty : jobs).set(agent.sessionId, agent.name);
  }
  return { jobs, duty, first };
}
/**
 * (i): the first reply names a measured number and does not open by putting the answer off. A date, a clock time, "top N" and the task's own
 * numbers are no measurement. A put-off word counts before the first measured number, or anywhere when the reply has none: a reply that gives
 * its number and then names the job it started answers first (r3e's Reddit reply read "all 7 Reddit crawl operations are blocked live" before
 * "I started the job", and the unit list read no number in it).
 */
export function firstReply(events: readonly SessionEvent[], since: number, task = ""): Check {
  const reply = events.find((event): event is Extract<SessionEvent, { kind: "assistant" }> => event.kind === "assistant" && event.at >= since)?.text ?? "";
  const own = new Set(task.match(/\d+/g) ?? []);
  const plain = reply.replace(/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}-\d{2}\b|\b\d{1,2}:\d{2}(?::\d{2})?Z?\b|\btop \d+\b|\b\d+ of \d+\b(?= gaps| failures| (?:written|measured))/gi, " ");
  const numbers = [...plain.matchAll(/(?<![\w.])\d[\d,.]*%?(?![\w])/g)].filter(match => !own.has(match[0]!.replace(/[,.%]+$/, "")));
  const firstAt = numbers[0]?.index ?? plain.length;
  const defers = plain.slice(0, firstAt).match(/nothing is measured yet|i started|i've started|will (find|measure|send|check)|once (it|the job)|when it is ready/gi) ?? [];
  return { id: "i", ok: reply ? numbers.length > 0 && defers.length === 0 : false, detail: reply
    ? `numbers ${numbers.map(match => match[0]).join(", ") || "none"}; put-off words before the first number ${defers.map(word => `"${word}"`).join(", ") || "none"}; "${clip(reply, 500)}"` : "no reply" };
}
const taskText = (name: string): string => TASKS[name] ?? "";

function judge(run: string, state: RunState): { verdict: Verdict; text: string } {
  const roots = [state.chat.id, ...(state.control ? [state.control.id] : [])];
  const read = (id: string): SessionEvent[] => readSession(id, roots);
  const end = Date.now();
  const runs = existsSync(join(run, "runs.jsonl")) ? readFileSync(join(run, "runs.jsonl"), "utf8").split("\n").filter(Boolean)
    .map(line => JSON.parse(line) as { at: number; trigger: string; duty: string; summary?: string; job?: { id?: string } }).filter(entry => entry.duty === "checkin" && entry.at >= state.windowStart) : [];
  const slots = runs.filter(entry => entry.trigger === "schedule");
  const boards = snapshots(join(run, "boards"));
  const controlBoards = snapshots(join(run, "control", "boards"));
  const { jobs, duty, first } = agentsOf(join(run, "agents"), state.chat);
  const control = agentsOf(join(run, "control", "agents"), state.control ?? state.chat);
  const clock = (at: number): string => { const date = new Date(at); return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`; };
  const head = read(state.chat.id);
  const checks: Check[] = [];
  const actions: string[] = [];

  const slotLines: string[] = []; const pushLines: string[] = []; const coordLines: string[] = []; const reportLines: string[] = [];
  let pushOk = slots.length > 0; let coordOk = true; let reportOk: boolean | null = null;
  slots.forEach((slot, index) => {
    const next = slots[index + 1]?.at ?? end;
    // The run record names its duty job; the name's HH:MM is the server's clock, which moved from UTC to KST in r3e's window (06:40Z read
    // "check-in Reddit index gaps 15:40"), so the name is only the fallback.
    const dutyId = (slot.job?.id && duty.has(slot.job.id) ? slot.job.id : undefined) ?? [...duty].find(([, name]) => name.endsWith(` ${clock(slot.at)}`))?.[0];
    const events = dutyId ? read(dutyId) : [];
    const started = events[0]?.at;
    if (!dutyId || started === undefined || started - slot.at > SLOT_START_MS) {
      pushOk = false;
      slotLines.push(`slot ${iso(slot.at)}: ${dutyId ? `its duty job started ${started === undefined ? "never" : `${Math.round((started - slot.at) / 1000)} s late`}` : "no duty job"} (${clip(slot.summary ?? "", 120)})`);
      if (!dutyId) return;
    } else slotLines.push(`slot ${iso(slot.at)}: duty job ${duty.get(dutyId)} started after ${Math.round((started - slot.at) / 1000)} s`);
    const calls = events.filter((event): event is Call => event.kind === "call");
    // A job of the chat is the chat's subagent, so the duty job reaches it through scripts/job-steer.ts and the server delivers the message.
    const steered = calls.filter(event => STEER.test(event.input)).flatMap((event): Sent[] => {
      const hit = [...jobs].find(([id, name]) => event.input.includes(id) || names(event.input, name));
      return hit ? [{ kind: "sent", at: event.at, to: hit[0], toName: hit[1], text: event.input }] : [];
    });
    const sent = [...events.filter((event): event is Sent => event.kind === "sent"), ...steered];
    for (const event of sent) actions.push(`${iso(event.at)} ${duty.get(dutyId)} messaged ${event.toName || event.to}: "${clip(event.text, 220)}"`);
    for (const event of calls) if (STARTS.test(event.input) || BOARD_OP.test(event.input)) actions.push(`${iso(event.at)} ${duty.get(dutyId)} ${STARTS.test(event.input) ? "started a job" : "changed the board"}: ${clip(event.input, 220)}`);
    const board = boardAt(boards, slot.at);
    for (const goal of goalsOf(board).filter(short)) {
      const pushed = sent.some(event => carries(event.text, goal)) || calls.some(event => STARTS.test(event.input) && carries(event.input, goal));
      if (!pushed) pushOk = false;
      pushLines.push(`slot ${iso(slot.at)}, ${goal.id} at ${numberWords(goal).text}: ${pushed ? "pushed with its number" : "no message or start carried its number"}`);
    }
    for (const [job, name] of jobs) {
      const at = first.get(job) ?? Infinity;
      if (at > slot.at) continue;
      const own = read(job);
      const lastAt = Math.max(at, ...own.filter(event => event.at <= slot.at).map(event => event.at));
      // A job asleep on a board.wake it set, with no [wake] delivered since, waits on purpose, and the chat's rule (board.wake over a held
      // kernel) asks for that. In r3c both jobs slept on CI runs queued 1.5 h and were scored quiet and dead, and the idle unload archived one.
      if (asleepAt(own, slot.at)) { coordLines.push(`slot ${iso(slot.at)}, job ${name}: asleep on its board.wake, left alone`); continue; }
      const failed = head.some(event => event.kind === "text" && event.at <= slot.at && event.at >= lastAt - 60_000 && new RegExp(`(child-failed|ended|stopped)[^\\n]*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\n]*(ended|stopped|failed)`, "i").test(event.text));
      const quietFor = slot.at - lastAt;
      if (!failed && quietFor < state.everyMs) continue;
      // The server's own push (`pushJobs`) lands in the job's session as a check-in message at the slot.
      const pushedByServer = own.find((event): event is Text => event.kind === "text" && event.role === "user" && event.at >= slot.at - 60_000 && event.at < next &&
        /^(\[check-in\]|The check-in)/.test(event.text.trim()));
      const toJob = sent.find(event => event.to === job) ?? (pushedByServer ? { kind: "sent" as const, at: pushedByServer.at, to: job, toName: name, text: pushedByServer.text } : undefined);
      const tookTurn = own.some(event => event.kind === "assistant" && toJob !== undefined && event.at > toJob.at && event.at < next + state.everyMs);
      const before = boardAt(boards, slot.at); const after = boardAt(boards, next + state.everyMs) ?? boards.at(-1)?.board;
      const ownedBefore = new Set<string>(); walk(before?.plan ?? [], item => { if (item.sessionId === job || item.job === name) ownedBefore.add(item.id); });
      let replaced = false; walk(after?.plan ?? [], item => { if (ownedBefore.has(item.id) && item.sessionId !== job && item.job !== name && !!item.job) replaced = true; });
      const toldChat = sent.some(event => event.to === state.chat.id && event.text.toLowerCase().includes(name.toLowerCase()));
      const heavy = failed || quietFor >= 2 * state.everyMs;
      const ok = heavy ? ((toJob !== undefined && tookTurn) || replaced) && toldChat : toJob !== undefined;
      if (!ok) coordOk = false;
      coordLines.push(`slot ${iso(slot.at)}, job ${name}: ${failed ? "dead" : `quiet ${Math.round(quietFor / 60_000)} min`}; ${toJob ? `got "${clip(toJob.text, 160)}"` : "got no message"}${heavy ? `; ${tookTurn ? "took a turn after it" : replaced ? "a new job was started" : "was not restarted or replaced"}; the chat was ${toldChat ? "" : "not "}told` : ""}`);
    }
    for (const event of sent.filter(event => event.to === state.chat.id)) {
      const goal = goalsOf(board)[0];
      const shape = reportShape(event.text, goal?.target?.current !== undefined ? amount(goal.target.current) : goal ? amount(goal.target!.target) : "");
      reportOk = (reportOk ?? true) && shape.ok && shape.namesGoal;
      reportLines.push(`${iso(event.at)}: ${shape.lines} lines, number ${shape.namesGoal ? "named" : "missing"}: "${clip(event.text, 300)}"`);
    }
  });
  checks.push({ id: "1", ok: pushOk, detail: [...slotLines, ...pushLines].join("\n    ") || "no slot in the window" });
  checks.push({ id: "2", ok: coordOk, detail: coordLines.join("\n    ") || "no job of the chat was quiet or dead at a slot" });
  checks.push({ ...firstReply(head, state.windowStart, taskText(state.chat.name)), detail: `${state.chat.name}: ${firstReply(head, state.windowStart, taskText(state.chat.name)).detail}` });
  if (state.control) {
    const reply = firstReply(read(state.control.id), state.windowStart, taskText(state.control.name));
    const own = checks.find(check => check.id === "i")!;
    own.ok = !!own.ok && !!reply.ok;
    own.detail += `\n    ${state.control.name}: ${reply.detail}`;
  }

  const ledgerFile = join(process.env.AGENT_CHAT_DATA_DIR ?? join(process.env.HOME ?? "", ".prime/agent/browser-chat"), "corrections.json");
  const ledger = existsSync(ledgerFile) ? readFileSync(ledgerFile, "utf8") : "";
  // A clean-room chat is agent-created (thread-origin.ts), so its todos and tell_owner lines stay on its own board and transcript, out of the
  // owner's sidebar and For you count: that is their scratch place. One reaches him only when the chat is missing from clean-room-chats.json.
  const hidden = new Set(readJsonIds(join(process.env.AGENT_CHAT_DATA_DIR ?? join(process.env.HOME ?? "", ".prime/agent/browser-chat"), "clean-room-chats.json")));
  const asks = [[state.chat, boards] as const, ...(state.control ? [[state.control, controlBoards] as const] : [])].flatMap(([chat, all]) =>
    (all.at(-1)?.board.todos ?? []).map(todo => ({ chat, line: `${chat.name} todo ${todo.id} "${clip(todo.text, 90)}"` })));
  const leaks = [...asks.filter(ask => !hidden.has(ask.chat.id)).map(ask => ask.line),
    ...[state.chat, ...(state.control ? [state.control] : [])].flatMap(chat => ledger.includes(chat.id) ? [`corrections.json names ${chat.name}`] : [])];
  const scratch = asks.filter(ask => hidden.has(ask.chat.id)).map(ask => ask.line);
  checks.push({ id: "j", ok: leaks.length === 0, detail: [leaks.length ? leaks.join("; ") : "no todo reached the owner, and corrections.json names neither chat",
    ...(scratch.length ? [`kept on the hidden chats' boards for the reader: ${scratch.join("; ")}`] : [])].join("\n    ") });

  const mine = progress(boards.at(-1)?.board); const theirs = progress(controlBoards.at(-1)?.board);
  const series = slots.map(slot => `${iso(slot.at)} ${progress(boardAt(boards, slot.at)) ?? "-"} vs ${progress(boardAt(controlBoards, slot.at)) ?? "-"}`);
  checks.push({ id: "k", ok: mine !== null && (theirs === null || (mine >= theirs && mine > (theirs ?? 0))), detail:
    `share of target at the end: ${state.chat.name} ${mine ?? "not measured"}, ${state.control?.name} ${theirs ?? "not measured"}; at each slot (with vs without): ${series.join("; ") || "none"}` });
  checks.push({ id: "l", ok: null, detail: `${actions.length} actions by the duty jobs, listed below for the reader` });

  const family = new Set([state.chat.id, ...duty.keys(), ...jobs.keys(), ...(state.control ? [state.control.id, ...control.jobs.keys()] : [])]);
  const hits: string[] = []; const outside: string[] = []; let scanned = 0;
  // A reply to a message the chat or its job sent first is no one stepping in: in r3b on 10-17 "YouTube index gaps" asked the CI queue keeper
  // and the Crawler VP chat for a probe slot and for uncommitted hunks, and their answers voided the run.
  const asked = new Map<string, number[]>();
  for (const id of family) for (const event of read(id)) if (event.kind === "sent") asked.set(`${id}<${event.to}`, [...asked.get(`${id}<${event.to}`) ?? [], event.at]);
  const replies = (id: string, from: string, at: number): boolean => (asked.get(`${id}<${from}`) ?? []).some(sentAt => sentAt <= at);
  for (const id of family) for (const event of read(id)) {
    if (event.kind !== "text" || event.at < state.windowStart) continue;
    if (["harness_digest", "refinement_notice", "refinement_outcome", "ipython_state", "ipython_state_restored"].includes(event.customType ?? "")) continue;
    if (event.role === "user" && Object.values(TASKS).includes(event.text.trim())) continue;
    scanned++;
    const flags = flagHits(event.text); const lists = stepIdLists(event.text);
    if (flags.length || lists.length) hits.push(`${id.slice(0, 8)} from ${event.from ?? event.customType ?? event.role} at ${iso(event.at)}: ${[flags.join(", "), lists.map(ids => ids.join(" ")).join(" / ")].filter(Boolean).join("; ")}`);
    if ((id === state.chat.id || id === state.control?.id) && event.role === "user" && !event.text.trimStart().startsWith("[")) outside.push(`typed into ${id.slice(0, 8)} at ${iso(event.at)}: "${clip(event.text, 100)}"`);
    const text = event as Text;
    if (text.customType === "agent_message" && text.fromId && !family.has(text.fromId) && text.relation !== "child" && text.relation !== "parent" && !replies(id, text.fromId, event.at)) outside.push(`${text.from ?? text.fromId} messaged ${id.slice(0, 8)} at ${iso(event.at)}`);
  }
  checks.push({ id: "c", ok: hits.length === 0, detail: `${scanned} system texts scanned; ${hits.length} with hits${hits.length ? `:\n${hits.slice(0, 12).map(hit => `    - ${hit}`).join("\n")}` : ""}` });

  const churn: string[] = [];
  for (const goal of goalsOf(boards.at(-1)?.board)) {
    const on = [...jobs].filter(([id, name]) => boards.some(snap => { let hit = false; walk(snap.board.plan, (item, top) => { if (top.id === goal.id && item !== top && (item.sessionId === id || item.job === name)) hit = true; }); return hit; }))
      .map(([id, name]) => { const events = read(id); return { name, first: first.get(id) ?? 0, end: Math.max(first.get(id) ?? 0, ...events.map(event => event.at)) }; }).sort((a, b) => a.first - b.first);
    for (let i = 1; i < on.length; i++) { const alive = on.slice(0, i).filter(job => job.end + 30 * 60_000 > on[i]!.first); if (alive.length) churn.push(`${goal.id}: ${on[i]!.name} started at ${iso(on[i]!.first)} while ${alive.map(job => job.name).join(", ")} was alive`); }
  }
  checks.push({ id: "d", ok: churn.length === 0, detail: churn.join("; ") || "no root job started for a goal while another on it was alive" });
  checks.push({ id: "e", ok: reportOk, detail: reportLines.join("\n    ") || "no duty job sent the chat a message" });
  checks.push({ id: "f", ok: slots.length >= 2, detail: `${slots.length} slots in the window` });
  const controlSetting = existsSync(join(run, "control", "check-in-setting.json")) ? readJson<{ pausedUntil?: unknown } | null>(join(run, "control", "check-in-setting.json")) : null;
  const controlRuns = existsSync(join(run, "control", "runs.jsonl")) ? readFileSync(join(run, "control", "runs.jsonl"), "utf8").split("\n").filter(Boolean).length : 0;
  if (state.control && (controlSetting?.pausedUntil !== "forever" || controlRuns > 0)) outside.push(`the control's check-in is ${controlSetting?.pausedUntil === "forever" ? "paused" : "not paused"} and ran ${controlRuns} times`);
  checks.push({ id: "h", ok: outside.length === 0, detail: outside.join("; ") || "nobody typed into either chat after the first message, no outside session messaged them, and the control's check-in stayed paused" });

  const get = (id: string) => checks.find(check => check.id === id)!;
  const verdict: Verdict = get("h").ok === false ? "void" : checks.some(check => check.ok === false) ? "fail" : get("f").ok ? "pass" : "open";
  const text = [
    `# Clean-room run ${run.split("/").at(-1)}: ${verdict}`, "",
    `"${state.chat.name}" (${state.chat.id}, check-in every ${state.everyMs / 60_000} min) and the control "${state.control?.name}" (${state.control?.id}, check-in paused) ran on ${state.release} from ${new Date(state.windowStart).toISOString()} to ${new Date(end).toISOString()}. Judged by \`clean-room.ts evaluate\`; criterion (l) is marked by the reader below the list.`,
    `Criteria: ${join(run, "criteria.md")}. Setup: ${join(run, "setup.md")}. Evidence: ${run} (boards, control/boards, agents, runs.jsonl, service.log) and the session files named here.`, "",
    "## Verdict per criterion", "", ...checks.map(check => `- (${check.id}) ${yes(check.ok)}: ${check.detail}`), "",
    "## Every action of the check-in, for (l)", "", ...(actions.length ? actions.map(line => `- ${line}`) : ["- none"]), "",
    `Jobs of ${state.chat.name}: ${[...jobs].map(([id, name]) => `${name} ${id}`).join(", ") || "none"}. Duty jobs: ${[...duty].map(([id, name]) => `${name} ${id}`).join(", ") || "none"}. Jobs of the control: ${[...control.jobs].map(([id, name]) => `${name} ${id}`).join(", ") || "none"}.`, "",
  ].join("\n");
  return { verdict, text };
}
