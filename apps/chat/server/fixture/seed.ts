/**
 * The fixture world: four agents with their DM rooms and work threads, a root job, jobs inside threads (one nested under another job), a
 * root chat no agent holds with a job of its own, two channels, an open and a closed Solo room, boards with plans and asks, duties and a check-in, spread over the last five
 * days with repeated words (canary, relay, migration) so search can rank, filter by date and by author.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatBoard, PlanItem } from "../../web/src/lib/api/types.ts";
import type { Duty, DutyRunRecord } from "../../web/src/lib/api/shared/chat-duties.ts";
import { richReply, type FixtureHost } from "../host/fixture.ts";
import type { ContentBlock, EntryRecord, Message } from "../host/types.ts";
import { runStamp } from "../duty-run.ts";
import { createEntry, EntryExists, writeBrief } from "../agent-folder.ts";
import { AgentStore, type RoomRow as RoomsRow } from "../agent-store.ts";
import { fixtureFolders } from "../config.ts";
import { writeJson, type StateFile } from "../store.ts";

export const FIXTURE_IDS = {
  vent: "0f1e0000-0000-4000-8000-000000000001",
  harness: "0f1e0000-0000-4000-8000-000000000002",
  crawler: "0f1e0000-0000-4000-8000-000000000003",
  frontend: "0f1e0000-0000-4000-8000-000000000004",
  cutover: "0f1e0000-0000-4000-8000-000000000005",
  archived: "0f1e0000-0000-4000-8000-000000000006",
  uptimeDuty: "0f1e0000-0000-4000-8000-000000000007",
  /** An untitled root chat no agent holds: a solo chat, which no agent or job list shows, nor its job. */
  solo: "0f1e0000-0000-4000-8000-000000000008",
  cutoverChannel: "ch_cutover",
  generalChannel: "ch_general",
  /** An open Solo room with Vent and frontend bro around one agenda, three posts into sequence (d). */
  soloRoom: "so_0f1e0001",
  /** A closed Solo room with Vent and Crawler VP, which the sidebar folds under "Done". */
  closedSolo: "so_0f1e0002",
};

const SOLO_AGENDA = "Pick the relay protocol between the chat server and each box: one WebSocket per box, or pi-host's socket over the tailnet.";

/** The agents the seed makes, one per root chat, keyed as FIXTURE_IDS names their work threads. */
export const FIXTURE_AGENTS = {
  vent: "ag_vent",
  harness: "ag_ai-harness-developer-environment-vp",
  crawler: "ag_crawler-vp",
  frontend: "ag_frontend-bro",
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
  const ventAsk = user(vent, 1, "Why did the canary relay drop messages last night? Check the relay log.", at(5, 1));
  assistant(vent, 1, [{ type: "thinking", thinking: "Read the relay log first, then the canary unit." }, { type: "toolCall", id: "call_v1", name: "bash", arguments: { command: "journalctl --user -u pi-host-relay --since yesterday | tail -50" } }], at(5, 1.01), "toolUse");
  toolResult(vent, 1, "call_v1", "bash", "Oct 27 02:10 relay: connection reset by peer (mac)\nOct 27 02:11 relay: reconnected", at(5, 1.02));
  assistant(vent, 1, [{ type: "toolCall", id: "call_v2", name: "read", arguments: { path: "/home/sieun/.config/pi-host-relay/boxes.json" } }], at(5, 1.03), "toolUse");
  toolResult(vent, 1, "call_v2", "read", '{"mac": "http://100.66.173.18:7791"}', at(5, 1.04));
  const ventAnswer = assistant(vent, 1, [{ type: "text", text: "The canary relay lost the Mac for one minute at 02:10 and reconnected at 02:11. Nothing was dropped: the durable inbox replayed the two queued messages." }], at(5, 1.05));
  const ventShot = user(vent, 1, "Here is the screenshot of the relay graph.", at(3, 2), true);
  const ventGraph = assistant(vent, 1, [{ type: "text", text: "The graph shows one gap at 02:10, the same minute as the relay reset." }], at(3, 2.01));
  const ventDraw = user(vent, 1, "Draw the migration flow as a mermaid diagram.", at(2, 5));
  const ventFlow = assistant(vent, 1, [{ type: "text", text: "Here is the migration flow:\n\n```mermaid\nflowchart LR\n  prime[Prime daemon] --> import[durable_import]\n  import --> pihost[pi-host thread]\n  pihost --> chat[apps/chat]\n```\n\nEach Prime thread becomes one pi-host thread file." }], at(2, 5.01));
  const ventSpawn = user(vent, 1, "Spawn a job to read the canary logs from the last day.", at(1, 3));
  assistant(vent, 1, [{ type: "text", text: "I'll hand the log read to a job." }, { type: "toolCall", id: "call_v3", name: "subagent", arguments: { task: "Read the canary logs from the last day and list every relay error" } }], at(1, 3.01), "toolUse");
  const ventJob = host.addChild(vent, 1, "Read the canary logs from the last day and list every relay error", at(1, 3.02));
  user(vent, ventJob.id, "Read the canary logs from the last day and list every relay error", at(1, 3.02));
  assistant(vent, ventJob.id, [{ type: "toolCall", id: "call_j1", name: "bash", arguments: { command: "journalctl --user -u pi-host --since -1d | grep -i error" } }], at(1, 3.03), "toolUse");
  toolResult(vent, ventJob.id, "call_j1", "bash", "relay: ECONNREFUSED 100.66.173.18:7791 (2 times)", at(1, 3.04));
  assistant(vent, ventJob.id, [{ type: "text", text: "Two relay errors in the last day, both ECONNREFUSED to the Mac relay while it slept." }], at(1, 3.05));
  toolResult(vent, 1, "call_v3", "subagent", "Two relay errors in the last day, both ECONNREFUSED to the Mac relay while it slept.", at(1, 3.06), { conversationId: ventJob.id });
  const ventFound = assistant(vent, 1, [{ type: "text", text: "The job found two relay errors, both while the Mac slept. The canary itself is fine." }], at(1, 3.07));
  // A DM exchange after the move to rooms: the owner's post reached the thread, and the agent answered with one tell_owner call.
  const ventPage = user(vent, 1, "Should the relay page me when the Mac sleeps?", at(0, -2));
  const ventTell = assistant(vent, 1, [{ type: "toolCall", id: "call_v4", name: "tell_owner", arguments: { text: "No. The Mac sleeps every night, so a page would wake you for nothing; I log it and flag a gap over an hour on the board.", why: "answer" } }], at(0, -1.99), "toolUse");
  toolResult(vent, 1, "call_v4", "tell_owner", "told the owner", at(0, -1.98));
  assistant(vent, 1, [], at(0, -1.97));
  // A job of the job: Vent's log reader handed the timestamp check on. Seeded last, so the entry ids above stay as the specs know them.
  const ventNested = host.addChild(vent, ventJob.id, "error timestamps", at(1, 3.035));
  agentMsg(vent, ventNested.id, `${ids.vent}:${ventJob.id}`, "spawn", "List the times of both errors.", at(1, 3.036));
  assistant(vent, ventNested.id, [{ type: "text", text: "01:52 and 02:10, both while the Mac slept." }], at(1, 3.037));

  // AI harness VP: a running job and a turn that streams for as long as the fixture runs.
  const harness = host.addThread({ id: ids.harness, name: "AI harness developer environment VP", createdAt: at(4) });
  // An agent from before send_message: its endless turn keeps the typing dots and plain-text answers of such a thread.
  harness.plain = true;
  const harnessAsk = user(harness, 1, "What still blocks the migration to pi-host?", at(4, 2));
  const harnessAnswer = assistant(harness, 1, [{ type: "text", text: "Two items block the migration: cross-box messaging and the canary send key. Both sit with CI and RepoOps." }], at(4, 2.01));
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
  const crawlerAsk = user(crawler, 1, "Where does the board panel work stand? Show me everything on one screen.", at(1, 5));
  const crawlerRich = assistant(crawler, 1, [{ type: "text", text: richReply(shot, `${ids.vent}:${ventJob.id}`) }], at(1, 5.01));
  const crawlerMove = user(crawler, 1, "Move the crawler to the new relay port.", at(1, 6));
  assistant(crawler, 1, [{ type: "text", text: "" }], at(1, 6.01), "error", { errorMessage: "pi-pool: no account can serve claude-opus-5-5 until 07:00" });
  crawler.row.status = "failed";
  crawler.row.failed = true;

  const frontend = host.addThread({ id: ids.frontend, name: "frontend bro", createdAt: at(2) });
  const frontendAsk = user(frontend, 1, "Ship the board panel redesign to staging.", at(2, 4));
  const frontendAnswer = assistant(frontend, 1, [{ type: "text", text: "Shipped the board panel to staging. The canary build passed." }], at(2, 4.1));

  // A root job of the AI harness VP, listed as a DM.
  const cutover = host.addThread({ id: ids.cutover, name: "pi cutover prep", createdAt: at(1) });
  agentMsg(cutover, 1, ids.harness, "spawn", "Prepare the pi-host cutover: list what moves and in which order.", at(1, 1));
  assistant(cutover, 1, [{ type: "text", text: "The cutover moves the chat first, then the relay, then the pool. The canary send key is in 32dac069." }], at(1, 1.2));

  // A duty run's thread, filed under the AI harness VP: a job, not a DM.
  const dutyAt = at(1);
  const uptimeDuty = host.addThread({ id: ids.uptimeDuty, name: `Relay uptime duty ${runStamp(dutyAt)}`, createdAt: dutyAt });
  agentMsg(uptimeDuty, 1, ids.harness, "duty d1", "You are the duty job of the chat \"AI harness developer environment VP\". Uptime measured 97.2% against a target of at least 99%. Find the cause and fix it, then report in at most 3 lines.", dutyAt);
  assistant(uptimeDuty, 1, [{ type: "text", text: "Uptime dipped while the Mac slept for 41 minutes. Nothing to fix on this box; the next run should meet the target." }], dutyAt + 0.2 * HOUR);

  // A root chat the owner opened and never named, with a job of its own: neither is an agent, and the chat stays in the sidebar's solo group.
  const solo = host.addThread({ id: ids.solo, name: "New thread", createdAt: at(0, -6) });
  user(solo, 1, "What time zone does the box use?", at(0, -6));
  assistant(solo, 1, [{ type: "text", text: "Asia/Seoul. A job is checking the clock source too." }], at(0, -5.99));
  const soloJob = host.addChild(solo, 1, "clock source check", at(0, -5.98));
  user(solo, soloJob.id, "Check which clock source the box syncs from.", at(0, -5.98));
  assistant(solo, soloJob.id, [{ type: "text", text: "chrony, from the two pool servers." }], at(0, -5.97));

  const archived = host.addThread({ id: ids.archived, name: "old relay probe", createdAt: at(6), archived: true });
  const archivedAsk = user(archived, 1, "ping the relay", at(6, 1));
  const archivedAnswer = assistant(archived, 1, [{ type: "text", text: "The relay answers." }], at(6, 1.01));

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

  // The chat server's own files: thread kinds, read marks, channels, duties and the check-in.
  const vp = FIXTURE_AGENTS.harness;
  const state: StateFile = {
    v: 1, threads: { [ids.cutover]: { kind: "job", parent: ids.harness }, [ids.uptimeDuty]: { kind: "job", parent: ids.harness } },
    reads: {
      [ids.vent]: { at: at(1, 3.5) }, [ids.frontend]: { at: now }, [ids.cutoverChannel]: { at: at(1), seq: 4 }, [ids.soloRoom]: { at: at(0, -3), seq: 1 },
      "dm_vent": { at: at(0, -2), seq: 9 }, "dm_frontend-bro": { at: now, seq: 2 }, [`dm_${vp.slice(3)}`]: { at: at(3), seq: 2 },
    },
  };

  // Agents and their DM rooms (agent-store.ts): every root chat is an agent, its root jobs alias to it, and its DM holds posts as the
  // migration copies them, plus Vent's exchange from after the move, whose answer came from a tell_owner call.
  const store = new AgentStore(dataDir);
  const textOf = (entry: EntryRecord): string => {
    const content = entry.model?.[0]?.content ?? "";
    return typeof content === "string" ? content : content.flatMap(b => (b.type === "text" ? [b.text] : [])).join("\n");
  };
  type Draft = { input: EntryRecord; answer?: EntryRecord; why?: string; jobs?: string[]; delivered?: string; call?: { id: string; entry: EntryRecord; text: string } };
  const agent = (thread: T, slug: string, home: string, drafts: Draft[]) => {
    const id = `ag_${slug}`;
    const room = `dm_${slug}`;
    const tid = thread.row.id;
    store.agents.agents.push({ id, slug, name: thread.row.name, room, workThread: tid, host: "fixture", home, createdAt: thread.row.createdAt, archived: thread.row.archived });
    store.agents.aliases[tid] = id;
    store.rooms.rooms.push({ id: room, kind: "dm", agent: id, createdAt: thread.row.createdAt, archived: thread.row.archived });
    let lastPost: string | undefined;
    for (const draft of drafts) {
      const inputAt = draft.input.model?.[0]?.timestamp ?? now;
      const images = draft.input.model?.[0]?.content;
      const refs = Array.isArray(images) ? images.flatMap((b, i) => (b.type === "image" ? [{ url: `/api/images/${tid}/${draft.input.id}/${i}`, mimeType: b.mimeType }] : [])) : [];
      const owner = store.append({
        room, author: "owner", text: textOf(draft.input), images: refs, at: inputAt,
        ...(draft.delivered
          ? { requestId: draft.delivered }
          : { requestId: `h:${tid}:${draft.input.id}`, imported: true }),
      }).post;
      if (draft.delivered) store.set(owner, { delivery: { target: id, state: "delivered", attempts: 1, at: inputAt, requestId: `d:${owner.id}:${id}` } });
      const said = draft.call ?? (draft.answer ? { id: `t${draft.input.id}`, entry: draft.answer, text: textOf(draft.answer) } : undefined);
      if (!said) continue;
      lastPost = store.append({
        room, author: id, text: said.text, images: [], at: said.entry.model?.[0]?.timestamp ?? inputAt,
        requestId: draft.call ? `m:${tid}:${said.id}` : `h:${tid}:${said.id}`, ...(draft.call ? {} : { imported: true }),
        source: { thread: tid, conversation: 1, entry: said.entry.id }, ...(draft.why ? { why: draft.why } : {}), ...(draft.jobs ? { jobs: draft.jobs } : {}),
      }).post.id;
    }
    const mine = thread.entries.filter(e => e.conversationId === 1);
    const lastInput = mine.findLast(e => e.kind === "pi.user" || e.kind === "agent.message");
    const via = (lastInput?.data as { via?: string } | undefined)?.via ?? "";
    store.rooms.feed[id] = {
      entry: mine.at(-1)?.id ?? 0, open: {},
      ...(lastInput ? { turn: { input: lastInput.id, channel: via.startsWith("#"), ...(lastPost ? { lastPost } : {}) } } : {}),
    };
  };
  agent(vent, "vent", join(dataDir, "work", "vent"), [
    { input: ventAsk, answer: ventAnswer },
    { input: ventShot, answer: ventGraph },
    { input: ventDraw, answer: ventFlow },
    { input: ventSpawn, answer: ventFound, why: "done", jobs: [`${ids.vent}:${ventJob.id}`] },
    { input: ventPage, delivered: "seed-dm-vent-page", why: "answer", call: { id: "call_v4", entry: ventTell, text: "No. The Mac sleeps every night, so a page would wake you for nothing; I log it and flag a gap over an hour on the board." } },
  ]);
  agent(harness, vp.slice(3), join(dataDir, "work", "harness"), [{ input: harnessAsk, answer: harnessAnswer, why: "blocker" }]);
  store.agents.aliases[ids.cutover] = vp;
  store.agents.aliases[ids.uptimeDuty] = vp;
  agent(crawler, "crawler-vp", join(dataDir, "work", "crawler"), [{ input: crawlerAsk, answer: crawlerRich }, { input: crawlerMove }]);
  agent(frontend, "frontend-bro", join(dataDir, "home"), [{ input: frontendAsk, answer: frontendAnswer }]);
  agent(archived, "old-relay-probe", join(dataDir, "work", "vent"), [{ input: archivedAsk, answer: archivedAnswer }]);
  store.saveAgents();
  store.saveRooms();
  writeJson(join(dataDir, "state.json"), state);
  // Channels and Solo rooms (group-rooms.ts): rows in rooms.json and posts in rooms/<id>.jsonl, members by agent id. The channels keep the
  // posts the old router left, with a root job ("pi cutover prep") as one author; the open Solo room holds sequence (d)'s first hops, and the
  // closed one sits under "Done".
  type Group = Extract<RoomsRow, { kind: "channel" | "solo" }>;
  const member = (agent: string, wakeOn: "mention" | "all" = "mention") => ({ agent, wakeOn, addedAt: at(3) });
  const a = FIXTURE_AGENTS;
  const groups: Group[] = [
    { id: ids.cutoverChannel, kind: "channel", name: "pi-cutover", purpose: "Move :5182 onto pi-host (p1128)", homeChat: ids.harness, createdAt: at(3), archived: false,
      members: [member(a.harness), member(a.crawler), member(a.frontend)] },
    { id: ids.generalChannel, kind: "channel", name: "general", purpose: "Anything for every agent", createdAt: at(5), archived: false, members: [member(a.vent), member(a.frontend)] },
    { id: ids.soloRoom, kind: "solo", name: "relay protocol", agenda: SOLO_AGENDA, createdAt: at(0, -3), archived: false, members: [member(a.vent, "all"), member(a.frontend, "all")] },
    { id: ids.closedSolo, kind: "solo", name: "wiki cleanup", agenda: "Move the wiki's session pages older than a month into the archive.", createdAt: at(2), archived: false,
      members: [member(a.vent, "all"), member(a.crawler, "all")], closedAt: at(1, 2) },
  ];
  store.rooms.rooms.push(...groups);
  // Crawler VP's comm thread in #pi-cutover is mid-turn on the owner's p5, so the channel row shows a member answering (typing dots).
  const crawlerComm = host.addThread({ name: "Crawler VP · #pi-cutover", createdAt: at(0, -4), status: "running" });
  crawlerComm.row.cwd = join(dataDir, "work", "crawler");
  user(crawlerComm, 1, "[#pi-cutover · post 5 from You (owner) · hops 0]\n\n@Crawler VP is the crawler on us-metal01 still using the old relay port?", at(0, -3.9));
  const crawlerRecord = store.agents.agents.find(r => r.id === a.crawler)!;
  crawlerRecord.comm = { [ids.cutoverChannel]: crawlerComm.row.id };
  const crawlerInput = crawlerComm.entries.at(-1)!.id;
  store.rooms.commFeed = { [crawlerComm.row.id]: { thread: crawlerComm.row.id, entry: crawlerInput, open: {}, turn: { input: crawlerInput, channel: false, post: "p5", hops: 0 } } };
  store.saveAgents();
  store.saveRooms();
  type Seeded = { author: string; text: string; when: number; hops: number; mentions?: string[]; threadRoot?: string; to?: string[]; why?: string; thread?: string };
  const seed = (room: string, posts: Seeded[]) => {
    for (const draft of posts) {
      const id = `p${(store.postsOf(room).at(-1)?.seq ?? 0) + 1}`;
      store.append({
        room, author: draft.author, text: draft.text, images: [], at: draft.when, requestId: `seed:${room}:${id}`, hops: draft.hops, mentions: draft.mentions ?? [],
        ...(draft.threadRoot ? { threadRoot: draft.threadRoot } : {}), ...(draft.why ? { why: draft.why } : {}),
        deliveries: (draft.to ?? []).map(target => ({ target, state: "delivered" as const, attempts: 1, at: draft.when, requestId: `d:${room}:${id}:${target}`, ...(draft.thread ? { thread: draft.thread } : {}) })),
      });
    }
  };
  seed(ids.cutoverChannel, [
    { author: "owner", text: "@AI harness developer environment VP what still blocks the migration?", mentions: [a.harness], when: at(3, 1), hops: 0, to: [a.harness] },
    { author: a.harness, text: "Two of five: cross-box messaging and the canary send key, both with CI and RepoOps.", threadRoot: "p1", when: at(3, 1.1), hops: 1 },
    { author: a.crawler, text: "The crawler still uses the old relay port.", threadRoot: "p1", when: at(2, 1), hops: 1 },
    { author: ids.cutover, text: "Canary send key is in 32dac069. The migration list has one open item fewer.", when: at(1, 2), hops: 1 },
    { author: "owner", text: "@Crawler VP is the crawler on us-metal01 still using the old relay port?", mentions: [a.crawler], when: at(0, -4), hops: 0, to: [a.crawler], thread: crawlerComm.row.id },
    { author: a.harness, text: "@owner the production cutover needs your pick of a day, t1 on my board.", mentions: ["owner"], when: at(0, -2), hops: 1 },
    { author: "owner", text: "@frontend bro can you check the relay page on the canary?", mentions: [a.frontend], when: at(0, -1), hops: 0, to: [a.frontend] },
  ]);
  seed(ids.generalChannel, [
    { author: "owner", text: "Morning. The canary relay is back after the Mac woke up.", when: at(2, 0), hops: 0 },
    { author: a.vent, text: "Confirmed, the relay log is clean since 02:11.", threadRoot: "p1", when: at(2, 0.2), hops: 1 },
  ]);
  seed(ids.soloRoom, [
    { author: "owner", text: SOLO_AGENDA, when: at(0, -3), hops: 0, to: [a.vent, a.frontend] },
    { author: a.vent, text: "One WebSocket per box, and the chat server dials it. A reconnect resumes from the last cursor.", when: at(0, -2.9), hops: 1, to: [a.frontend] },
    { author: a.frontend, text: "Fine for the web. The Mac sleeps at night, so deliveries to it must queue until it wakes.", when: at(0, -2.8), hops: 2, to: [a.vent] },
  ]);
  seed(ids.closedSolo, [
    { author: "owner", text: "Move the wiki's session pages older than a month into the archive.", when: at(2), hops: 0, to: [a.vent, a.crawler] },
    { author: a.crawler, text: "Done: 41 session pages moved to the archive, and the index links to them.", when: at(1, 1), hops: 1, to: [a.vent], why: "done" },
  ]);

  const duty = (id: string, name: string, goal: string, metricKey: string, target: number): Duty => ({
    id, name, ownerWords: `keep ${name.toLowerCase()} healthy`, goal, metrics: [{ key: metricKey, label: name, op: ">=", target, unit: "%", headline: true }],
    schedule: { kind: "daily", at: "07:40" },
    precheck: { command: ["node", "-e", `require("fs").writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { ${metricKey}: ${target + 0.5} } }))`], cwd: tmpdir(), timeoutMs: 60_000 }, onMiss: "Find the cause and fix it.", status: "active",
    createdAt: at(5), updatedAt: at(1), runCount: 3, lastRunAt: now,
  });
  const run = (dutyId: string, key: string, when: number, value: number, target: number): DutyRunRecord => ({
    duty: dutyId, at: when, trigger: "schedule", ms: 3100, verdict: value >= target ? "met" : "missed", metrics: { [key]: { value, target, op: ">=", met: value >= target } },
    summary: value >= target ? `${key} ${value}% met ${target}%` : `${key} ${value}% missed ${target}%`,
  });
  writeJson(join(dataDir, "agents", vp, "duties.json"), {
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
  writeJson(join(dataDir, "agents", vp, "duties", "d1.state.json"), { lastSeenAt: new Date(at(0, -8)).toISOString(), downMinutes: 41 });

  // Vent's agent folder: a brief and one memory its threads wrote, kept when a data dir is seeded again. The other agents start with an
  // empty folder.
  const ventRecord = store.agents.agents.find(a => a.slug === "vent")!;
  const { agentsDir } = fixtureFolders(dataDir);
  writeBrief(agentsDir, ventRecord, "Keep the canary relay answering every minute, and tell me when the Mac sleeps through a test window.\n");
  try {
    createEntry(agentsDir, ventRecord, "memory", { title: "The Mac sleeps from 01:00 to 07:00 KST", content: "Run cross-box relay tests in the day; a gap at night is the Mac asleep, not a relay fault." }, "agent");
  } catch (error) {
    if (!(error instanceof EntryExists)) throw error;
  }

  // Keep one turn streaming for as long as the fixture runs.
  const stream = async () => {
    for (;;) {
      const submission = { id: 900_000 + Math.floor(Math.random() * 99_999), conversationId: 1, type: "input", status: "placed" };
      const input = host.append(harness, 1, { kind: "agent.message", model: [{ role: "user", content: [{ type: "text", text: "[check-in] Keep reporting the cutover status while the canary test runs." }], timestamp: Date.now() }], data: { from: "board", via: "check-in" } });
      harness.submissions.set(submission.id, { ...submission, entry: input.id });
      await host.answer(harness, 1, harness.submissions.get(submission.id)!, "slow status", "The canary relay answers. Cross-box test 3 of 12 passed. The migration waits for the send key review. ".repeat(4));
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  };
  if (host.wordMs > 0) setTimeout(() => void stream(), 500);
}
