/**
 * The fixture world: four chats, a root job, jobs inside threads, two channels, boards with plans and asks, duties and a check-in, spread
 * over the last five days with repeated words (canary, relay, migration) so search can rank, filter by date and by author.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatBoard, PlanItem } from "../../web/src/lib/api/types.ts";
import type { Duty, DutyRunRecord } from "../../web/src/lib/api/shared/chat-duties.ts";
import { richReply, type FixtureHost } from "../host/fixture.ts";
import type { ContentBlock, EntryRecord, Message } from "../host/types.ts";
import { runStamp } from "../duty-run.ts";
import { writeJson, type ChannelRow, type Post, type StateFile } from "../store.ts";

export const FIXTURE_IDS = {
  vent: "0f1e0000-0000-4000-8000-000000000001",
  harness: "0f1e0000-0000-4000-8000-000000000002",
  crawler: "0f1e0000-0000-4000-8000-000000000003",
  frontend: "0f1e0000-0000-4000-8000-000000000004",
  cutover: "0f1e0000-0000-4000-8000-000000000005",
  archived: "0f1e0000-0000-4000-8000-000000000006",
  uptimeDuty: "0f1e0000-0000-4000-8000-000000000007",
  cutoverChannel: "ch_cutover",
  generalChannel: "ch_general",
};

/** A drawn stand-in for a screenshot of the board panel, for the rich answer's embedded image (served by /api/local-image). */
const BOARD_SHOT = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
<rect width="640" height="360" rx="18" fill="#f1f1f2"/>
<rect x="16" y="16" width="608" height="40" rx="12" fill="#ffffff"/>
<circle cx="40" cy="36" r="8" fill="#beda36"/><rect x="58" y="30" width="140" height="12" rx="6" fill="#5f5f5f"/>
<rect x="16" y="68" width="190" height="276" rx="14" fill="#ffffff"/>
${[0, 1, 2, 3, 4].map(i => `<rect x="32" y="${88 + i * 36}" width="${150 - i * 14}" height="12" rx="6" fill="${i === 1 ? "#beda36" : "#dadada"}"/>`).join("")}
<rect x="218" y="68" width="406" height="276" rx="14" fill="#ffffff"/>
${[0, 1, 2, 3, 4, 5].map(i => `<circle cx="244" cy="${96 + i * 40}" r="7" fill="${["#2b9a66", "#2b9a66", "#ef5f00", "#0d74ce", "#dadada", "#dadada"][i]}"/><rect x="262" y="${90 + i * 40}" width="${300 - i * 30}" height="12" rx="6" fill="#e8e8e8"/>`).join("")}
</svg>
`;

/** One red 2x2 PNG. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mP8z8DwnwEJMDIwMjAwAAANJQEBEtoaJgAAAABJRU5ErkJggg==";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const usage = (output: number) => ({ input: 40, output, cacheRead: 12_000, cacheWrite: 800, cost: { input: 0.00016, output: output * 0.00002, cacheRead: 0.0024, cacheWrite: 0.0064, total: 0.00896 + output * 0.00002 } });

export function seedFixture(host: FixtureHost, dataDir: string, now = Date.now()): void {
  const ids = FIXTURE_IDS;
  const at = (daysAgo: number, hours = 0) => now - daysAgo * DAY + hours * HOUR;
  type T = ReturnType<FixtureHost["addThread"]>;
  const user = (t: T, conv: number, text: string, when: number, images = false): EntryRecord =>
    host.append(t, conv, { kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text }, ...(images ? [{ type: "image" as const, data: PNG, mimeType: "image/png" }] : [])], timestamp: when }] });
  const agentMsg = (t: T, conv: number, from: string, via: string, text: string, when: number): EntryRecord =>
    host.append(t, conv, { kind: "agent.message", model: [{ role: "user", content: [{ type: "text", text }], timestamp: when }], data: { from, via } });
  const assistant = (t: T, conv: number, content: ContentBlock[], when: number, stopReason = "stop", extra: Partial<Message> = {}): EntryRecord =>
    host.append(t, conv, { kind: "pi.assistant", model: [{ role: "assistant", content, provider: "anthropic", model: "claude-opus-5-5", usage: usage(120), stopReason, timestamp: when, ...extra }] });
  const toolResult = (t: T, conv: number, callId: string, name: string, text: string, when: number, details: Record<string, unknown> = {}): EntryRecord =>
    host.append(t, conv, { kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: callId, toolName: name, content: [{ type: "text", text }], details, isError: false, timestamp: when }] });

  // Vent: a finished turn with thinking and tool steps, an image, a mermaid answer, and a finished job.
  const vent = host.addThread({ id: ids.vent, name: "Vent", createdAt: at(5) });
  user(vent, 1, "Why did the canary relay drop messages last night? Check the relay log.", at(5, 1));
  assistant(vent, 1, [{ type: "thinking", thinking: "Read the relay log first, then the canary unit." }, { type: "toolCall", id: "call_v1", name: "bash", arguments: { command: "journalctl --user -u pi-host-relay --since yesterday | tail -50" } }], at(5, 1.01), "toolUse");
  toolResult(vent, 1, "call_v1", "bash", "Oct 27 02:10 relay: connection reset by peer (mac)\nOct 27 02:11 relay: reconnected", at(5, 1.02));
  assistant(vent, 1, [{ type: "toolCall", id: "call_v2", name: "read", arguments: { path: "/home/sieun/.config/pi-host-relay/boxes.json" } }], at(5, 1.03), "toolUse");
  toolResult(vent, 1, "call_v2", "read", '{"mac": "http://100.66.173.18:7791"}', at(5, 1.04));
  assistant(vent, 1, [{ type: "text", text: "The canary relay lost the Mac for one minute at 02:10 and reconnected at 02:11. Nothing was dropped: the durable inbox replayed the two queued messages." }], at(5, 1.05));
  user(vent, 1, "Here is the screenshot of the relay graph.", at(3, 2), true);
  assistant(vent, 1, [{ type: "text", text: "The graph shows one gap at 02:10, the same minute as the relay reset." }], at(3, 2.01));
  user(vent, 1, "Draw the migration flow as a mermaid diagram.", at(2, 5));
  assistant(vent, 1, [{ type: "text", text: "Here is the migration flow:\n\n```mermaid\nflowchart LR\n  prime[Prime daemon] --> import[durable_import]\n  import --> pihost[pi-host thread]\n  pihost --> chat[apps/chat]\n```\n\nEach Prime thread becomes one pi-host thread file." }], at(2, 5.01));
  user(vent, 1, "Spawn a job to read the canary logs from the last day.", at(1, 3));
  assistant(vent, 1, [{ type: "text", text: "I'll hand the log read to a job." }, { type: "toolCall", id: "call_v3", name: "subagent", arguments: { task: "Read the canary logs from the last day and list every relay error" } }], at(1, 3.01), "toolUse");
  const ventJob = host.addChild(vent, 1, "Read the canary logs from the last day and list every relay error", at(1, 3.02));
  user(vent, ventJob.id, "Read the canary logs from the last day and list every relay error", at(1, 3.02));
  assistant(vent, ventJob.id, [{ type: "toolCall", id: "call_j1", name: "bash", arguments: { command: "journalctl --user -u pi-host --since -1d | grep -i error" } }], at(1, 3.03), "toolUse");
  toolResult(vent, ventJob.id, "call_j1", "bash", "relay: ECONNREFUSED 100.66.173.18:7791 (2 times)", at(1, 3.04));
  assistant(vent, ventJob.id, [{ type: "text", text: "Two relay errors in the last day, both ECONNREFUSED to the Mac relay while it slept." }], at(1, 3.05));
  toolResult(vent, 1, "call_v3", "subagent", "Two relay errors in the last day, both ECONNREFUSED to the Mac relay while it slept.", at(1, 3.06), { conversationId: ventJob.id });
  assistant(vent, 1, [{ type: "text", text: "The job found two relay errors, both while the Mac slept. The canary itself is fine." }], at(1, 3.07));

  // AI harness VP: a running job and a turn that streams for as long as the fixture runs.
  const harness = host.addThread({ id: ids.harness, name: "AI harness developer environment VP", createdAt: at(4) });
  // An agent from before send_message: its endless turn keeps the typing dots and plain-text answers of such a thread.
  harness.plain = true;
  user(harness, 1, "What still blocks the migration to pi-host?", at(4, 2));
  assistant(harness, 1, [{ type: "text", text: "Two items block the migration: cross-box messaging and the canary send key. Both sit with CI and RepoOps." }], at(4, 2.01));
  agentMsg(harness, 1, ids.crawler, "#pi-cutover", "[#pi-cutover · post 3 from Crawler VP] The crawler still uses the old relay port.", at(2, 1));
  assistant(harness, 1, [{ type: "text", text: "Noted. I'll move the crawler to the new relay port after the canary run." }], at(2, 1.01));
  const harnessJob = host.addChild(harness, 1, "Rerun the cross-box test on the canary relay", at(0, -0.5), "running");
  user(harness, harnessJob.id, "Rerun the cross-box test on the canary relay", at(0, -0.5));
  assistant(harness, harnessJob.id, [{ type: "toolCall", id: "call_h1", name: "bash", arguments: { command: "npm test -- cross-box" } }], at(0, -0.45), "toolUse");

  // Crawler VP: a rich answer, then a last turn that failed.
  const crawler = host.addThread({ id: ids.crawler, name: "Crawler VP", createdAt: at(3), status: "failed" });
  // The rich answer, before the failed turn: every format the chat renders, with a screenshot file, a link to Vent's job and the board's p1.
  const shot = join(dataDir, "fixture-board-panel.svg");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(shot, BOARD_SHOT);
  host.richImage = shot;
  user(crawler, 1, "Where does the board panel work stand? Show me everything on one screen.", at(1, 5));
  assistant(crawler, 1, [{ type: "text", text: richReply(shot, `${ids.vent}:${ventJob.id}`) }], at(1, 5.01));
  user(crawler, 1, "Move the crawler to the new relay port.", at(1, 6));
  assistant(crawler, 1, [{ type: "text", text: "" }], at(1, 6.01), "error", { errorMessage: "pi-pool: no account can serve claude-opus-5-5 until 07:00" });
  crawler.row.status = "failed";
  crawler.row.failed = true;

  const frontend = host.addThread({ id: ids.frontend, name: "frontend bro", createdAt: at(2) });
  user(frontend, 1, "Ship the board panel redesign to staging.", at(2, 4));
  assistant(frontend, 1, [{ type: "text", text: "Shipped the board panel to staging. The canary build passed." }], at(2, 4.1));

  // A root job of the AI harness VP, listed as a DM.
  const cutover = host.addThread({ id: ids.cutover, name: "pi cutover prep", createdAt: at(1) });
  agentMsg(cutover, 1, ids.harness, "spawn", "Prepare the pi-host cutover: list what moves and in which order.", at(1, 1));
  assistant(cutover, 1, [{ type: "text", text: "The cutover moves the chat first, then the relay, then the pool. The canary send key is in 32dac069." }], at(1, 1.2));

  // A duty run's thread, filed under the AI harness VP: a job, not a DM.
  const dutyAt = at(1);
  const uptimeDuty = host.addThread({ id: ids.uptimeDuty, name: `Relay uptime duty ${runStamp(dutyAt)}`, createdAt: dutyAt });
  agentMsg(uptimeDuty, 1, ids.harness, "duty d1", "You are the duty job of the chat \"AI harness developer environment VP\". Uptime measured 97.2% against a target of at least 99%. Find the cause and fix it, then report in at most 3 lines.", dutyAt);
  assistant(uptimeDuty, 1, [{ type: "text", text: "Uptime dipped while the Mac slept for 41 minutes. Nothing to fix on this box; the next run should meet the target." }], dutyAt + 0.2 * HOUR);

  const archived = host.addThread({ id: ids.archived, name: "old relay probe", createdAt: at(6), archived: true });
  user(archived, 1, "ping the relay", at(6, 1));
  assistant(archived, 1, [{ type: "text", text: "The relay answers." }], at(6, 1.01));

  // Boards.
  const step = (id: string, text: string, status: PlanItem["status"], extra: Partial<PlanItem> = {}, children: PlanItem[] = []): PlanItem => ({ id, text, status, children, ...extra });
  const harnessBoard: ChatBoard = {
    v: 2, rev: 7, updatedAt: new Date(at(0, -1)).toISOString(), lastIds: { p: 12, t: 5 },
    plan: [
      step("p1", "Move :5182 onto pi-host", "doing", { note: "Move 3 of 5." }, [
        step("p2", "Cross-box messaging through the relay", "doing", { job: "Rerun the cross-box test on the canary relay", sessionId: `${ids.harness}:${harnessJob.id}` }),
        step("p3", "Canary send key", "done"),
        step("p4", "Deploy the chat to production", "todo", { go: "needed" }),
        step("p5", "Crawler on the new relay port", "blocked", { waitFor: "Crawler VP gets a pool slot" }),
        step("p6", "Keep the old relay as a fallback", "dropped"),
      ]),
      step("p7", "Search over every thread", "todo", { waitUntil: new Date(at(-1)).toISOString() }),
    ],
    todos: [
      { id: "t1", text: "Pick the day for the production cutover.", done: false, choices: ["Thursday 09:00", "Friday 09:00", "Next week"], from: "agent", at: new Date(at(0, -3)).toISOString(), step: "p4", links: [{ label: "Cutover plan", target: "wiki:sessions/2026/10/28/cutover" }] },
      { id: "t2", text: "Review the new board panel on staging.", done: false, from: "agent", at: new Date(at(1)).toISOString(), links: [{ label: "Staging board", target: "https://staging.example.test/board" }] },
      { id: "t3", text: "Allow the relay to run on the Mac at login?", done: true, reply: "yes", answeredBy: "owner", choices: ["yes", "no"], from: "agent", at: new Date(at(2)).toISOString() },
    ],
  };
  host.threadsById.get(ids.harness)!.docs.set("chat.board", harnessBoard);
  host.threadsById.get(ids.vent)!.docs.set("chat.board", {
    v: 2, rev: 2, updatedAt: new Date(at(1)).toISOString(), lastIds: { p: 2, t: 2 },
    plan: [step("p1", "Find why the canary relay dropped messages", "done"), step("p2", "Watch the relay for a week", "doing")],
    todos: [{ id: "t1", text: "Should the relay page you when the Mac sleeps?", done: false, choices: ["Page me", "Only log it"], from: "agent", at: new Date(at(1, 4)).toISOString() }],
  } satisfies ChatBoard);
  host.threadsById.get(ids.crawler)!.docs.set("chat.board", {
    v: 2, rev: 1, updatedAt: new Date(at(1)).toISOString(), lastIds: { p: 1, t: 1 },
    plan: [step("p1", "Crawl census at 128 slots", "blocked", { waitFor: "pi-pool account at 07:00" })],
    todos: [{ id: "t1", text: "Raise the crawler's pool class to high?", done: false, choices: ["Raise it", "Keep normal"], from: "agent", at: new Date(at(0, -5)).toISOString() }],
  } satisfies ChatBoard);

  // The chat server's own files: thread kinds, DMs, read marks, channels, duties and the check-in.
  const state: StateFile = {
    // Crawler VP is a chat the owner opened as a DM. The Vent job in `dms` predates the rule that only a root chat is a DM, so it stays out.
    v: 1, threads: { [ids.cutover]: { kind: "job", parent: ids.harness }, [ids.uptimeDuty]: { kind: "job", parent: ids.harness } }, dms: [ids.crawler, `${ids.vent}:${ventJob.id}`],
    reads: { [ids.vent]: { at: at(1, 3.5) }, [ids.frontend]: { at: now }, [ids.cutoverChannel]: { at: at(1), seq: 4 } },
  };
  writeJson(join(dataDir, "state.json"), state);
  const member = (principal: string, wakeOn: "mention" | "all" = "mention") => ({ principal, role: principal === "owner" ? "owner" as const : "member" as const, wakeOn, addedAt: at(3) });
  const channels: ChannelRow[] = [
    { id: ids.cutoverChannel, name: "pi-cutover", purpose: "Move :5182 onto pi-host (p1128)", homeChat: ids.harness, createdAt: at(3), archived: false,
      members: [member("owner", "all"), member(ids.harness), member(ids.crawler), member(ids.cutover), member(ids.frontend)] },
    { id: ids.generalChannel, name: "general", purpose: "Anything for every agent", createdAt: at(5), archived: false, members: [member("owner", "all"), member(ids.vent), member(ids.frontend)] },
  ];
  writeJson(join(dataDir, "channels.json"), { channels });
  const d = (target: string, name: string, state: Post["deliveries"][number]["state"], when: number, extra: Partial<Post["deliveries"][number]> = {}) => ({ target, name, state, at: when, thread: target, conversation: 1, ...extra });
  const posts: Post[] = [
    { id: "p1", seq: 1, channel: ids.cutoverChannel, author: "owner", text: "@AI harness developer environment VP what still blocks the migration?", images: [], mentions: [ids.harness], at: at(3, 1), hops: 0, deliveries: [d(ids.harness, "AI harness developer environment VP", "answered", at(3, 1.1), { answerPost: "p2" })] },
    { id: "p2", seq: 2, channel: ids.cutoverChannel, author: ids.harness, text: "Two of five: cross-box messaging and the canary send key, both with CI and RepoOps.", images: [], mentions: [], threadRoot: "p1", at: at(3, 1.1), hops: 1, deliveries: [] },
    { id: "p3", seq: 3, channel: ids.cutoverChannel, author: ids.crawler, text: "The crawler still uses the old relay port.", images: [], mentions: [], threadRoot: "p1", at: at(2, 1), hops: 1, deliveries: [] },
    { id: "p4", seq: 4, channel: ids.cutoverChannel, author: ids.cutover, text: "Canary send key is in 32dac069. The migration list has one open item fewer.", images: [], mentions: [], at: at(1, 2), hops: 1, deliveries: [] },
    { id: "p5", seq: 5, channel: ids.cutoverChannel, author: "owner", text: "@Crawler VP is the crawler on us-metal01 still using the old relay port?", images: [], mentions: [ids.crawler], at: at(0, -4), hops: 0, deliveries: [d(ids.crawler, "Crawler VP", "no_reply", at(0, -3.9))] },
    { id: "p6", seq: 6, channel: ids.cutoverChannel, author: ids.harness, text: "@owner the production cutover needs your pick of a day, t1 on my board.", images: [], mentions: ["owner"], at: at(0, -2), hops: 1, deliveries: [] },
    { id: "p7", seq: 7, channel: ids.cutoverChannel, author: "owner", text: "@frontend bro can you check the relay page on the canary?", images: [], mentions: [ids.frontend], at: at(0, -1), hops: 0, deliveries: [d(ids.frontend, "frontend bro", "queued", at(0, -1))] },
    { id: "p1", seq: 1, channel: ids.generalChannel, author: "owner", text: "Morning. The canary relay is back after the Mac woke up.", images: [], mentions: [], at: at(2, 0), hops: 0, deliveries: [] },
    { id: "p2", seq: 2, channel: ids.generalChannel, author: ids.vent, text: "Confirmed, the relay log is clean since 02:11.", images: [], mentions: [], threadRoot: "p1", at: at(2, 0.2), hops: 1, deliveries: [] },
  ];
  mkdirSync(join(dataDir, "channels"), { recursive: true });
  for (const channel of [ids.cutoverChannel, ids.generalChannel]) {
    writeFileSync(join(dataDir, "channels", `${channel}.jsonl`), posts.filter(p => p.channel === channel).map(post => JSON.stringify({ t: "post", post })).join("\n") + "\n");
  }

  const duty = (id: string, name: string, goal: string, metricKey: string, target: number): Duty => ({
    id, name, ownerWords: `keep ${name.toLowerCase()} healthy`, goal, metrics: [{ key: metricKey, label: name, op: ">=", target, unit: "%", headline: true }],
    schedule: { kind: "daily", at: "07:40" },
    precheck: { command: ["node", "-e", `require("fs").writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { ${metricKey}: ${target + 0.5} } }))`], cwd: tmpdir(), timeoutMs: 60_000 }, onMiss: "Find the cause and fix it.", status: "active",
    createdAt: at(5), updatedAt: at(1), runCount: 3, lastRunAt: at(0, -8),
  });
  const run = (dutyId: string, key: string, when: number, value: number, target: number): DutyRunRecord => ({
    duty: dutyId, at: when, trigger: "schedule", ms: 3100, verdict: value >= target ? "met" : "missed", metrics: { [key]: { value, target, op: ">=", met: value >= target } },
    summary: value >= target ? `${key} ${value}% met ${target}%` : `${key} ${value}% missed ${target}%`,
  });
  writeJson(join(dataDir, "boards", ids.harness, "duties.json"), {
    duties: [duty("d1", "Relay uptime", "The canary relay answers every minute.", "relay_up_pct", 99), { ...duty("d2", "Search freshness", "Search covers every entry within a minute.", "fresh_pct", 95), status: "paused" }],
    runs: {
      d1: [run("d1", "relay_up_pct", at(2), 99.5, 99), { ...run("d1", "relay_up_pct", dutyAt, 97.2, 99), job: { id: ids.uptimeDuty, name: uptimeDuty.row.name } }, run("d1", "relay_up_pct", at(0, -8), 98.1, 99)],
      d2: [run("d2", "fresh_pct", at(1), 100, 95)],
    },
    checkIn: { everyMs: 120 * 60_000, pausedUntil: null, lastAt: at(0, -1.5) },
  });

  // Where the agents run and what they could read: a cwd per chat with its AGENTS.md, Prime's agent dir with its global AGENTS.md and
  // harness store, and a duty's precheck state. The config page reads these as it reads the real ones.
  for (const [thread, slug] of [[vent, "vent"], [harness, "harness"], [crawler, "crawler"], [cutover, "harness"], [uptimeDuty, "harness"], [archived, "vent"]] as const) {
    thread.row.cwd = join(dataDir, "work", slug);
    mkdirSync(thread.row.cwd, { recursive: true });
  }
  // The frontend chat sits in the fixture's home folder (`fixtureFolders`), as a thread made with no project does, so its config flags it.
  frontend.row.cwd = join(dataDir, "home");
  mkdirSync(frontend.row.cwd, { recursive: true });
  writeFileSync(join(dataDir, "work", "AGENTS.md"), "# Work\n\nEvery project folder under work/ follows these rules.\n\n1. Run the tests before you report.\n");
  writeFileSync(join(dataDir, "work", "harness", "AGENTS.md"), "# AI harness\n\nThe harness VP owns the move of :5182 onto pi-host.\n\n1. Ask the owner before a deploy.\n");
  const primeDir = join(dataDir, "prime-agent");
  mkdirSync(join(primeDir, "harness"), { recursive: true });
  writeFileSync(join(primeDir, "AGENTS.md"), "# Prime\n\nRules every Prime session on this box reads.\n");
  const memory = (id: string, title: string, when: number) => ({ id, kind: "memory", title, content: title, path: "general", scope: "global", reference: {}, arguments: {}, metadata: {}, source: "agent", created_at: new Date(when).toISOString(), updated_at: new Date(when).toISOString(), version: 1 });
  writeJson(join(primeDir, "harness", "harness_state.json"), {
    schema: 1, refinements: [],
    entries: { prompt: {}, skill: {}, subagent: {}, memory: { m1: memory("m1", "The Mac sleeps at night, so cross-box tests run in the day", at(3)), m2: memory("m2", "pi-pool slots free up at 07:00 KST", at(1)) } },
  });
  writeJson(join(dataDir, "boards", ids.harness, "duties", "d1.state.json"), { lastSeenAt: new Date(at(0, -8)).toISOString(), downMinutes: 41 });

  // Keep one turn streaming for as long as the fixture runs.
  const stream = async () => {
    for (;;) {
      const submission = { id: 900_000 + Math.floor(Math.random() * 99_999), conversationId: 1, type: "input", status: "placed" };
      const input = host.append(harness, 1, { kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text: "Keep reporting the cutover status while the canary test runs." }], timestamp: Date.now() }] });
      harness.submissions.set(submission.id, { ...submission, entry: input.id });
      await host.answer(harness, 1, harness.submissions.get(submission.id)!, "slow status", "The canary relay answers. Cross-box test 3 of 12 passed. The migration waits for the send key review. ".repeat(4));
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  };
  if (host.wordMs > 0) setTimeout(() => void stream(), 500);
}
