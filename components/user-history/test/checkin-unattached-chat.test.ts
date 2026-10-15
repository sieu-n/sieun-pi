import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionSummary } from "prime-agent";
import { chatAgents } from "../src/chat-agents.ts";
import { subagentSessions } from "../src/chat-catalog.ts";
import { checkInRecord } from "../src/chat-checkin.ts";
import { checkInSettings } from "../src/checkin-settings.ts";
import { loadRecord } from "../src/chat-brief.ts";
import type { CheckInRun } from "../src/chat-duty-run.ts";
import { Chats } from "../src/chats.ts";
import { type ChatThreads, type CheckInSource, replyCheckRecord } from "../src/chat-sources.ts";
import { IdIndex } from "../src/id-index.ts";
import type { ChatBoard, PlanItem, SessionRow } from "../src/shared/types.ts";

/**
 * frontend bro 10-13 00:29 and 00:44 KST: the serve restarted at 14:00Z and the chat never attached again (every pin timed out waiting for the
 * snapshot of its 64 MB transcript), so the hub sent no child snapshots and the check-in read no children for it. Its jobs are rlm.spawn
 * subagents, which the catalog keeps out of the top-level rows, so p92 to p99 were flagged "(<job> not found)" and p103 as a goal nobody works
 * on, while the daemon listed every job under the chat and 5 of them were at work. The chat's row carries the daemon's subagents in `agents`.
 */
process.env.TZ = "Asia/Seoul";
const CHAT = "01a11ba8-9d2c-727c-8ded-38f819ca9f29";
const NOW = Date.parse("2026-10-12T15:57:00.000Z");
type Observer = Parameters<ChatThreads["observe"]>[0];

/** The daemon's `list` rows under frontend bro (16:10Z 10-12), the fields the catalog reads. */
const DAEMON: Partial<SessionSummary>[] = [
  {
    "sessionId": "01a1301b-e144-7579-b2fc-e399d201140a",
    "parentSessionId": "01a11ba8-9d2c-727c-8ded-38f819ca9f29",
    "rlmChildId": "sub-e063a6b5",
    "sessionName": "connections from scratch",
    "runtimeKind": "subagent",
    "rlmDepth": 1,
    "activeSessionId": "3e881accf832",
    "rosterStatus": "running",
    "activity": "working",
    "isSessionActive": true,
    "hasRunningRlmChildren": true,
    "lastActivityAt": "2026-10-12T15:52:37.328Z"
  },
  {
    "sessionId": "01a1301b-e9cc-748c-94ff-b9aaa3c84c77",
    "parentSessionId": "01a11ba8-9d2c-727c-8ded-38f819ca9f29",
    "rlmChildId": "sub-e6bb7e96",
    "sessionName": "email from shipped",
    "runtimeKind": "subagent",
    "rlmDepth": 1,
    "activeSessionId": "6782d66c51b3",
    "rosterStatus": "running",
    "activity": "working",
    "isSessionActive": true,
    "hasRunningRlmChildren": true,
    "lastActivityAt": "2026-10-12T15:51:33.683Z"
  },
  {
    "sessionId": "01a1301b-ecec-717d-96e3-fa4d913b8c16",
    "parentSessionId": "01a11ba8-9d2c-727c-8ded-38f819ca9f29",
    "rlmChildId": "sub-f5f4efcf",
    "sessionName": "inbox into staging",
    "runtimeKind": "subagent",
    "rlmDepth": 1,
    "activeSessionId": "3f8d839c80fb",
    "rosterStatus": "idle",
    "activity": "idle",
    "isSessionActive": false,
    "hasRunningRlmChildren": true,
    "lastActivityAt": "2026-10-12T15:53:35.620Z"
  },
  {
    "sessionId": "01a1301b-fb97-75c9-8ca2-dfd5c49d1ed6",
    "parentSessionId": "01a11ba8-9d2c-727c-8ded-38f819ca9f29",
    "rlmChildId": "sub-325155bc",
    "sessionName": "home into staging",
    "runtimeKind": "subagent",
    "rlmDepth": 1,
    "activeSessionId": "959e7752b838",
    "rosterStatus": "idle",
    "activity": "idle",
    "isSessionActive": false,
    "hasRunningRlmChildren": true,
    "lastActivityAt": "2026-10-12T15:52:45.374Z"
  },
  {
    "sessionId": "01a1301c-1068-74e8-bbc4-955503e9009d",
    "parentSessionId": "01a11ba8-9d2c-727c-8ded-38f819ca9f29",
    "rlmChildId": "sub-d47b14ae",
    "sessionName": "fresh start scenario",
    "runtimeKind": "subagent",
    "rlmDepth": 1,
    "activeSessionId": "8adfae6367dc",
    "rosterStatus": "running",
    "activity": "working",
    "isSessionActive": true,
    "hasRunningRlmChildren": true,
    "lastActivityAt": "2026-10-12T15:56:22.348Z"
  },
  {
    "sessionId": "01a1301c-1a94-72ac-a475-11691ba86755",
    "parentSessionId": "01a11ba8-9d2c-727c-8ded-38f819ca9f29",
    "rlmChildId": "sub-13fbd2e1",
    "sessionName": "creators product demos",
    "runtimeKind": "subagent",
    "rlmDepth": 1,
    "activeSessionId": "c9f080b263cb",
    "rosterStatus": "idle",
    "activity": "idle",
    "isSessionActive": false,
    "hasRunningRlmChildren": true,
    "lastActivityAt": "2026-10-12T15:53:45.564Z"
  },
  {
    "sessionId": "01a1306b-c954-709e-8e7b-88f181099df8",
    "parentSessionId": "01a11ba8-9d2c-727c-8ded-38f819ca9f29",
    "rlmChildId": "sub-5e6a1e82",
    "sessionName": "old variant cleanup",
    "runtimeKind": "subagent",
    "rlmDepth": 1,
    "activeSessionId": "87237e6f01a9",
    "rosterStatus": "idle",
    "activity": "idle",
    "isSessionActive": false,
    "hasRunningRlmChildren": true,
    "lastActivityAt": "2026-10-12T15:53:31.212Z"
  },
  {
    "sessionId": "01a13083-8fd6-758a-a764-5a38f05b2cd4",
    "parentSessionId": "01a11ba8-9d2c-727c-8ded-38f819ca9f29",
    "rlmChildId": "sub-3ae1871f",
    "sessionName": "demo folder leftovers",
    "runtimeKind": "subagent",
    "rlmDepth": 1,
    "activeSessionId": "20bfa2066947",
    "rosterStatus": "running",
    "activity": "working",
    "isSessionActive": true,
    "hasRunningRlmChildren": false,
    "lastActivityAt": "2026-10-12T15:56:08.052Z"
  },
  {
    "sessionId": "01a13057-65a0-74df-b3f6-c992c239210a",
    "parentSessionId": "01a11ba8-9d2c-727c-8ded-38f819ca9f29",
    "rlmChildId": "sub-5e2f7163",
    "sessionName": "vite memory leftover",
    "runtimeKind": "subagent",
    "rlmDepth": 1,
    "rosterStatus": "inactive",
    "activity": "idle",
    "isSessionActive": false,
    "lastActivityAt": "2026-10-12T14:44:40.747Z"
  },
  {
    "sessionId": "01a130a5-86ec-7298-bc12-fe15d47c7344",
    "parentSessionId": "01a11ba8-9d2c-727c-8ded-38f819ca9f29",
    "rlmChildId": "sub-3e7ee16d",
    "sessionName": "save contact button",
    "runtimeKind": "subagent",
    "rlmDepth": 1,
    "activeSessionId": "b22ac784cfb8",
    "rosterStatus": "idle",
    "activity": "idle",
    "isSessionActive": false,
    "hasRunningRlmChildren": false,
    "lastActivityAt": "2026-10-12T15:35:47.201Z"
  }
];

/** Goal p103 of frontend bro's board as the 00:44 check-in left it (rev 1190), every step under it with its real job, session id and note. */
const P103: PlanItem = {
  "id": "p103",
  "text": "Demo work in flight on 5180: the app builds for Connections, Email, Inbox, Home and the Creators demos, the fresh start scenario, the old variant cleanup, the memory fix, the next demo CI run and Save contact",
  "status": "doing",
  "children": [
    {
      "id": "p96",
      "text": "A From scratch scenario on 5180: a new user starts with an empty workspace, goes through onboarding (brand setup, competitors to watch, connecting a sender, the first list), lands in the Staging apps with good empty states, and sees data arrive live as they work",
      "status": "doing",
      "job": "fresh start scenario",
      "children": [],
      "sessionId": "01a1301c-1068-74e8-bbc4-955503e9009d",
      "note": "Re-planned for parallel work. The empty-state audit, the type and size check, and the browser walk from sign-up to the first email are running at the same time, followed by one fix round and a re-walk. ETA to 100% is about 14:50Z. Plan: sessions/2026/10/12/2117-fresh-start-scenario/fresh-start-plan.md"
    },
    {
      "id": "p99",
      "text": "Remove every old variant on 5180, keeping only shipped, each app's Staging version and the versions jobs are building now",
      "status": "doing",
      "job": "old variant cleanup",
      "children": [],
      "sessionId": "01a1306b-c954-709e-8e7b-88f181099df8",
      "note": "All 30 old folders are deleted, with 279 tracked files listed in deleted.txt. The final check runs the picker look in Aside now, with no load gate."
    },
    {
      "id": "p86",
      "text": "Find and fix why the 5180 dev server reaches about 3 GB within 5 minutes of a start, so the memory guard stops restarting it about once an hour",
      "status": "doing",
      "children": [],
      "note": "Second cause found and fixed: every variant change reloaded all ~7,700 modules. Memory now stays flat at about 2.1 GB. Run 38269506512 was cancelled in Fable's queue cut, not red. The guard has not restarted 5180 since 20:51 KST. Notes: sessions/2026/10/12/1612-virev-demo-vite-memory/data/notes-2.txt",
      "job": "demo folder leftovers",
      "waitFor": "Fable's rerun of run 38269506512 after promote 8's last m1-air job starts, 16:45Z at the latest",
      "sessionId": "01a13083-8fd6-758a-a764-5a38f05b2cd4",
      "waitUntil": "2026-10-12T16:45:00.000Z"
    },
    {
      "id": "p100",
      "text": "Next demo CI run: the final Staging Watchlist, the memory fix, the Picker fix, the Inbox fixes, the Connections removal and the shared Home code, pushed now that land 32b is on staging",
      "status": "doing",
      "job": "demo folder leftovers",
      "children": [],
      "sessionId": "01a124b1-e999-719c-a199-47ad14fe554f",
      "note": "Demo stack r4 (run 38266683757) was cancelled in Fable's queue cut for promote 8, not red. Fable's script reruns it with the same id once promote's last job starts.",
      "waitFor": "Fable's rerun of run 38266683757 after promote 8's last m1-air job starts, 16:45Z at the latest",
      "waitUntil": "2026-10-12T16:45:00.000Z"
    },
    {
      "id": "p101",
      "text": "Save contact follow-up: hide the Add to contacts button after the save succeeds (the launch VP found it on staging)",
      "status": "doing",
      "job": "save contact button",
      "children": [],
      "sessionId": "01a130a5-86ec-7298-bc12-fe15d47c7344",
      "note": "Pushed to ci/save-contact-button, run https://github.com/sieu-n/auto-sns-agent/actions/runs/38269136575. After a save, the header shows a quiet 'Contact saved' check mark instead of the button, and it stays after a reload. A test covers before and after the save. The job puts it on the dev branch when the run is green.",
      "waitFor": "Fable's rerun of run 38269136575 after promote 8's last m1-air job starts, 16:45Z at the latest",
      "waitUntil": "2026-10-12T16:45:00.000Z"
    },
    {
      "id": "p92",
      "text": "Connections from the shipped screen: delete every old version, then polish the shipped Connections screen part by part (list, connect flow including connecting mid-task, choosing a sender, health and reconnect and disconnect) until it covers every connection the product supports, each part built for Jiwon's task with the Watchlist patterns you liked",
      "status": "doing",
      "job": "connections from scratch",
      "children": [],
      "sessionId": "01a1301b-e144-7579-b2fc-e399d201140a",
      "note": "Not done. The 5 parts are merged into one Staging version that scores 70 of 82, but Staging still has Connections on shipped and no browser walk has passed. The browser checks run now with no load gate, the merged version last after the polish pass. Then it goes on Staging and the flow is walked there."
    },
    {
      "id": "p93",
      "text": "Email from the current Staging screen: polish 5 parts one at a time (template list, new template flow, editor, sending, A/B testing), each built for Jiwon's canonical task and the Watchlist patterns you liked",
      "status": "doing",
      "job": "email from shipped",
      "children": [],
      "sessionId": "01a1301b-e9cc-748c-94ff-b9aaa3c84c77",
      "note": "svelte-check runs in the background, and the browser check walks the merged Email version first, then the other parts, with no load gate. Then it goes on Staging and the flow is walked there."
    },
    {
      "id": "p94",
      "text": "Inbox into Staging: your pick gmail (no split, default density), restyled with Virev's own components, built around Contacts (one person or brand with several accounts and ways to reach them, each account tied to a crawler-v3 profile), with the contact panel moved behind a See profile popup showing every account's feed",
      "status": "doing",
      "job": "inbox into staging",
      "children": [],
      "sessionId": "01a1301b-ecec-717d-96e3-fa4d913b8c16",
      "note": "Re-planned for parallel work. The first-run connect prompt and the gaps in the Inbox reply flow are being built at the same time: Needs reply, one row per creator, Set Agreed or Declined, and a WhatsApp link that opens the WhatsApp card in Connections. Then the type and size check and the flow walks on Staging. ETA is about 16:30Z if the load allows."
    },
    {
      "id": "p95",
      "text": "Home into Staging: brief made scrollable, any date range, configurable charts, a daily AI report, competitor story popups, Overlap, a request form and a live feel; plus creators working with us (clicks, sales, GMV, payouts), an outreach funnel viewer and a live monitoring stream; plus 2 or 3 story-format versions",
      "status": "doing",
      "job": "home into staging",
      "children": [],
      "sessionId": "01a1301b-fb97-75c9-8ca2-dfd5c49d1ed6",
      "note": "Re-planned for parallel work. The code for the 3 new sections is written and waits for its browser check (load was 136). Running now, each in its own subagent: watched brands and first run, configurable charts, the AI report, competitor popups with Overlap, the request form, and the 3 story versions. The job owns the shared Home wiring. Then the type and size check, a browser check and the Staging walk. Code is done by about 14:45Z, and 100% by about 16:00Z if the load allows."
    },
    {
      "id": "p97",
      "text": "Creators demos like a real product: a lists page with funnel numbers, a review where the email finder and AI columns fill in live as the crawler runs, Send email through a chosen template, list Settings with auto-send, default AI columns (group-buy creator, skin tone), one simple canonical flow",
      "status": "doing",
      "children": [],
      "job": "creators product demos",
      "note": "Both builders (campaign page and deck) have their code written, and their browser walks and screenshots run now with no load gate. Then the 4 rejected folders are deleted and each demo gets its check.",
      "sessionId": "01a1301c-1a94-72ac-a475-11691ba86755"
    }
  ]
};

test("check-in of a chat that is not attached finds its subagent jobs through the daemon's sessions under it (frontend bro p92 to p99)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "checkin-unattached-"));
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add(CHAT);
  const board: ChatBoard = { plan: [P103], todos: [] } as unknown as ChatBoard;
  const threads = {
    state: () => undefined, async view() { return null; }, busy: () => false, running: () => false, setWait() {},
    async restart() {}, async prompt() {}, async notice() {}, async deleteSubagent() {}, pin: () => true, unpin() {}, async setSteeringMode() {},
    async heartbeat() { return undefined; }, async clearHeartbeat() {}, async reload() {},
    observe(_next: Observer) { return () => {}; },
  } as unknown as ChatThreads;
  const self = { id: CHAT, name: "frontend bro" };
  // The catalog's chat row: no hub children (not attached), the daemon's sessions under the chat as its subagents.
  const agents = chatAgents({ self, children: [], childSessions: subagentSessions(DAEMON as SessionSummary[]), board, roots: [], messages: [], rows: [], now: NOW });
  const row = { id: CHAT, name: "frontend bro", archived: false, working: true, messageCount: 11634, lastActivityAt: "2026-10-12T15:40:00.000Z", chat: true, agents } as unknown as SessionRow;
  const runs: CheckInRun[] = [];
  const source: CheckInSource = {
    board: async () => board, rows: async () => [row], memory: checkInRecord(join(dir, "check-ins.json")), replyChecks: replyCheckRecord(join(dir, "reply-checks.json")),
    settings: checkInSettings(join(dir, "check-in-settings.json")), tickMs: 0, now: () => NOW, noReportGraceMs: 0,
    duty: { async checkIn(_id, run) { runs.push(run); }, async lastCheckIn() { return runs.at(-1)?.at; } },
  };
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), source);
  await chats.adopt();
  await chats.settled();
  await chats.tick();
  await chats.settled();
  chats.close();
  const [run] = runs;
  assert.ok(run, "one check-in run");
  const wrong = run.output.flagged.filter(slice => slice.kind === "orphan_steps" || slice.kind === "idle_goals").map(slice => `${slice.kind}: ${slice.excerpt}`);
  assert.deepEqual(wrong, [], "every step names a live job of the chat");
  assert.doesNotMatch(run.findings, /not found/);
  assert.match(run.findings, /p92 \(live\) "Connections from the shipped screen[^\n]*owner job connections from scratch \(working\)/);
  assert.match(run.findings, /p94 \(live\) "Inbox into Staging[^\n]*owner job inbox into staging \(working\)/, "a job whose own subagents run is at work");
});

test("check-in waits while the catalog has no rows and the hub has not attached the chat, instead of flagging every job missing (frontend bro 10-13 01:09 and 01:24)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "checkin-blind-"));
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add(CHAT);
  const board: ChatBoard = { plan: [P103], todos: [] } as unknown as ChatBoard;
  const threads = {
    state: () => undefined, async view() { return null; }, busy: () => false, running: () => false, setWait() {},
    async restart() {}, async prompt() {}, async notice() {}, async deleteSubagent() {}, pin: () => true, unpin() {}, async setSteeringMode() {},
    async heartbeat() { return undefined; }, async clearHeartbeat() {}, async reload() {},
    observe(_next: Observer) { return () => {}; },
  } as unknown as ChatThreads;
  const runs: CheckInRun[] = [];
  const memory = checkInRecord(join(dir, "check-ins.json"));
  const source: CheckInSource = {
    board: async () => board, rows: async () => [], memory, replyChecks: replyCheckRecord(join(dir, "reply-checks.json")),
    settings: checkInSettings(join(dir, "check-in-settings.json")), tickMs: 0, now: () => NOW, noReportGraceMs: 0,
    duty: { async checkIn(_id, run) { runs.push(run); }, async lastCheckIn() { return runs.at(-1)?.at; } },
  };
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), source);
  await chats.adopt();
  await chats.settled();
  await chats.tick();
  await chats.settled();
  chats.close();
  assert.deepEqual(runs.map(run => run.output.flagged.filter(slice => slice.kind === "orphan_steps").length), [], "no run with false orphans");
  assert.equal(await memory.get(CHAT), undefined, "no flag streak kept from a blind read");
});
