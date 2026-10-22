// AI harness developer environment VP, check-in of 10-21 14:00Z (23:00 KST): its Jobs list called d9 residuals 10-21, digest cache integration,
// wiki behind code root cause and duties green push 10-18 "failed" on a 429, and stalled_steps flagged p773, p804, p818, p831, p850 and p795.
// Each sat in a provider quota park with an active quota-resume job in its scheduled-jobs.json (d9 residuals until 14:45:17Z, digest cache
// until 14:48:26Z), and from about 14:15Z duties green waited 62nd in pi-pool's queue. A job waiting for an account is moving, not failed.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkInPrecheck, checkInPrecheckText, convergenceMisses } from "../src/chat-checkin.ts";
import { type ArtifactDisk, chatDisk, localDisk, parkSchedules, quotaParks, withQuotaParks } from "../src/checkin-load.ts";
import type { JobFact } from "../src/checkin-steps.ts";
import type { Host } from "../src/hosts.ts";
import { withQueuePlaces } from "../src/chat-turn-queue.ts";
import { withFailedTurns } from "../src/held-turns.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

const chat = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const d9 = "01a15d35-ad18-726c-8b7f-64ddb4dea411";
const digest = "01a15c17-f39c-7179-9f87-b1fdbacdb9f6";
const handoff = "01a153ef-8ff3-70e9-aae1-97df3eed1f47";
const greens = "01a14d72-63fa-776f-9d90-766b7ce76d30";
const now = Date.parse("2026-10-21T14:00:13.681Z");
const error = "Provider rate limit exceeded (rate_limit_error, 429): This request would exceed your account's rate limit. Please try again later.";
const resume = (session: string, id: string, createdAt: string, at: string, status = "active") => ({ id, status, source: "cron", runtimeKind: "top-level",
  sessionId: session, label: "quota-resume", schedule: { kind: "once", expression: `at ${at}` }, createdAt, updatedAt: createdAt, runCount: 0,
  ...status === "active" ? { nextRunAt: at } : {} });

const home = mkdtempSync(join(tmpdir(), "checkin-quota-park-"));
const schedules = (session: string, jobs: unknown[]) => {
  mkdirSync(join(home, ".prime", "agent", "session-artifacts", session), { recursive: true });
  writeFileSync(join(home, ".prime", "agent", "session-artifacts", session, "scheduled-jobs.json"), JSON.stringify({ jobs }));
};
schedules(d9, [resume(d9, "c0a9f299", "2026-10-21T11:40:29.246Z", "2026-10-21T13:21:47.043Z", "completed"),
  resume(d9, "5dd4428c", "2026-10-21T13:21:48.914Z", "2026-10-21T14:45:17.026Z")]);
schedules(digest, [resume(digest, "69d9045a", "2026-10-21T13:53:39.087Z", "2026-10-21T14:48:26.035Z")]);
schedules(greens, [resume(greens, "ad51d046", "2026-10-21T13:38:26.329Z", "2026-10-21T14:43:48.024Z")]);
// The detached handoff thread's last park was resumed at 12:21Z and its next turn failed again with nothing pending.
schedules(handoff, [resume(handoff, "e1", "2026-10-21T11:02:00.000Z", "2026-10-21T12:21:00.000Z", "completed")]);

const step = (id: string, text: string, job: string, sessionId: string, status: PlanItem["status"] = "doing"): PlanItem =>
  ({ id, text, status, job, sessionId, children: [] });
const board = { v: 2, rev: 1, updatedAt: "2026-10-21T07:00:00.000Z", todos: [], plan: [
  { id: "p624", text: "Every red duty in every chat gets its fix landed", status: "doing", children: [
    step("p773", "New open steps in every chat get a Done when line", "d9 residuals 10-21", d9, "todo"),
    step("p831", "Cache reads climb back above 94% and the skill checks pass", "digest cache integration", digest),
    step("p795", "Sort the duties red 15 runs or more by cause", "duties green push 10-18", greens),
    step("p823", "A Prime update attempt on us-metal02 does not refuse sessions", "detached handoff integration", handoff),
  ] },
] } as unknown as ChatBoard;
const thread = (id: string, name: string, item: PlanItem, activity: string): JobFact => ({ key: `thread:${id}`, name, state: "failed", error,
  activityAt: Date.parse(activity), item: { id: item.id, text: item.text, status: item.status } });
const items = board.plan[0]!.children;
const read: JobFact[] = [thread(d9, "d9 residuals 10-21", items[0]!, "2026-10-21T13:21:48.890Z"),
  thread(digest, "digest cache integration", items[1]!, "2026-10-21T13:53:38.900Z"),
  thread(greens, "duties green push 10-18", items[2]!, "2026-10-21T13:38:26.300Z"),
  thread(handoff, "detached handoff integration", items[3]!, "2026-10-21T12:21:30.000Z")];
const rows = read.map(fact => ({ id: fact.key.slice("thread:".length), name: fact.name, archived: false }));
const roots = rows.map(row => row.id);

const precheck = (facts: JobFact[], at = now) => checkInPrecheck(undefined, facts, board, at, { self: [chat, "AI harness developer environment VP"], rows });

test("a job in a quota park reads waiting for an account until its resume, and its steps leave stalled_steps", async () => {
  const parks = quotaParks(await parkSchedules(chat, roots, new Set(), localDisk(home)), now);
  assert.deepEqual([...parks.keys()].sort(), [digest, d9, greens].sort());
  const facts = withQuotaParks(read, parks, () => undefined);
  const found = precheck(facts);
  assert.deepEqual(found.stalled.map(stall => stall.view.item.id), ["p823"], "only the failed job with no pending park stalls");
  const text = checkInPrecheckText(found, facts, [], now);
  const jobs = text.slice(text.indexOf("### Jobs"));
  assert.match(jobs, /d9 residuals 10-21 thread: waiting for an account until 10-21 \d\d:45,/);
  assert.match(jobs, /digest cache integration thread: waiting for an account until 10-21 \d\d:48,/);
  assert.doesNotMatch(jobs.split("\n").find(line => line.includes("d9 residuals"))!, /failed|429/);
  assert.match(jobs, /detached handoff integration thread: failed, .*error: Provider rate limit exceeded/);
  const { metrics } = convergenceMisses(chat, found.steps, found, {}, 60 * 60_000, now);
  assert.equal(metrics.stalled_steps, 1);
  assert.deepEqual(found.end.filter(entry => entry.state === "moving").map(entry => entry.reason).filter(reason => reason.includes("account")).length, 3);
});

test("a park whose resume time passed with nothing pending reads failed again", async () => {
  const later = Date.parse("2026-10-21T14:50:00Z");
  const facts = withQuotaParks(read, quotaParks(await parkSchedules(chat, roots, new Set(), localDisk(home)), later), () => undefined);
  assert.deepEqual(facts.filter(fact => fact.state === "failed").map(fact => fact.name).sort(),
    ["d9 residuals 10-21", "digest cache integration", "detached handoff integration", "duties green push 10-18"].sort());
});

test("a job queued in pi-pool after its park resumed reads queued Nth for an account, and its step is not stalled", async () => {
  const at = Date.parse("2026-10-21T14:20:00Z");
  const parks = quotaParks(await parkSchedules(chat, roots, new Set(), localDisk(home)), at);
  const queued = new Map([[greens, { position: 62, total: 114, since: Date.parse("2026-10-21T14:12:37Z") }]]);
  const facts = withQueuePlaces(withQuotaParks(read, parks, () => undefined), { queued, working: new Set() }, []);
  const greensFact = facts.find(fact => fact.name === "duties green push 10-18")!;
  assert.equal(greensFact.parkedUntil, undefined, "the queue place is newer than the park");
  const found = precheck(facts, at);
  assert.ok(!found.stalled.some(stall => stall.view.item.id === "p795"));
  const text = checkInPrecheckText(found, facts, [], at);
  assert.match(text, /duties green push 10-18 thread: queued 62nd of 114 for an account, in the queue for 7 min,/);
});

test("a job in Prime's provider retry reads retrying for an account, then queued Nth; an idle one with the same 429 reads failed", async () => {
  // digest cache integration from 16:05Z: each 429 is followed by a pi-pool-queue entry while the daemon lists it working. wiki behind code root
  // cause failed at 15:25:27Z after its 15:24:16Z queue entry, and the daemon lists it idle.
  const agentDir = join(home, ".prime", "agent");
  mkdirSync(join(agentDir, "sessions"), { recursive: true });
  const line = (entry: object) => JSON.stringify(entry);
  const failed = (at: string) => line({ type: "message", timestamp: at, message: { role: "assistant", stopReason: "error", errorMessage: error, content: [] } });
  const queue = (at: string, position: number) => line({ type: "custom", customType: "pi-pool-queue", timestamp: at,
    data: { text: `Queued for a working slot, ${position}th of ${position}`, position, total: position, at: Date.parse(at) } });
  const wiki = "01a15cc9-3d6e-71ea-9611-fbbadddc2a2d";
  writeFileSync(join(agentDir, "sessions", `${digest}.jsonl`), [line({ type: "message", timestamp: "2026-10-21T16:00:00.000Z", message: { role: "assistant", stopReason: "stop", content: [] } }),
    failed("2026-10-21T16:05:32.471Z"), queue("2026-10-21T16:11:30.061Z", 50), failed("2026-10-21T16:13:35.655Z"), queue("2026-10-21T16:16:30.080Z", 41),
    failed("2026-10-21T16:19:34.861Z")].join("\n") + "\n");
  writeFileSync(join(agentDir, "sessions", `${wiki}.jsonl`), [queue("2026-10-21T15:24:16.066Z", 22), failed("2026-10-21T15:25:27.528Z")].join("\n") + "\n");
  const at = Date.parse("2026-10-21T16:20:00Z");
  const facts = await withFailedTurns([{ key: `thread:${digest}`, name: "digest cache integration", state: "working" },
    { key: `thread:${wiki}`, name: "wiki behind code root cause", state: "ended" }], agentDir, chat);
  assert.equal(facts[0]!.state, "working");
  assert.equal(facts[0]!.retrying, true);
  assert.equal(facts[0]!.queued, undefined, "the 41st place its 16:19Z try used is not shown");
  assert.equal(facts[1]!.state, "failed");
  const text = checkInPrecheckText(precheck(facts, at), facts, [], at);
  assert.match(text, /digest cache integration thread: retrying for an account after a rate limit$/m);
  assert.match(text, /wiki behind code root cause thread: failed,/);
  // At 16:20:30Z the retry queued 53rd: the failed turn is over, and pi-pool's live reading gives the place.
  const queued = withQueuePlaces(facts, { queued: new Map([[digest, { position: 53, total: 53, since: Date.parse("2026-10-21T16:20:30.072Z") }]]), working: new Set() }, []);
  assert.equal(queued[0]!.retrying, undefined);
  assert.match(checkInPrecheckText(precheck(queued, at + 60_000), queued, [], at + 60_000), /digest cache integration thread: queued 53rd of 53 for an account,/);
});

// sep launch!! runs on the Mac. Its 17:06:16Z check-in on 10-22 ran on us-metal02 and called mail integrations and mcp connector failed on their
// 429 ("pi-pool: Manual 89045843-... remains selected", the owner's own pick of an account at 100% until 19:20Z), and counted p81, p82, p87 and p94
// stuck as job_ended and p88, which waits for mail integrations, stuck on an event. Prime had parked both jobs until 19:20Z, with quota resumes in
// /Users/sieunpark/.prime/agent/session-artifacts/<chat>/session-artifacts/<job session>/scheduled-jobs.json, the folder Prime keeps a chat's
// subagent schedules in, on the Mac's disk.
test("a subagent job's park in the chat's session-artifacts folder on the chat's own box reads waiting for an account, and its steps are not stuck", async () => {
  const sep = "01a15427-145f-751d-ba15-d27b6c30f65f";
  const mail = "01a16237-eff7-731c-a295-d70d8cdc4700";
  const mcp = "01a16238-01fd-72de-b048-b4885df525fb";
  const at = Date.parse("2026-10-22T17:06:16.105Z");
  const mac = "/Users/sieunpark";
  const folder = `${mac}/.prime/agent/session-artifacts/${sep}`;
  const subagentResume = (session: string, id: string, createdAt: string, runAt: string) => ({ ...resume(session, id, createdAt, runAt), runtimeKind: "subagent", activeSessionId: session });
  const files = new Map<string, string>([
    [`${folder}/scheduled-jobs.json`, JSON.stringify({ jobs: [] })],
    [`${folder}/session-artifacts/${mail}/scheduled-jobs.json`, JSON.stringify({ jobs: [subagentResume(mail, "4126d951", "2026-10-22T16:10:06.420Z", "2026-10-22T19:20:00.420Z")] })],
    [`${folder}/session-artifacts/${mcp}/scheduled-jobs.json`, JSON.stringify({ jobs: [subagentResume(mcp, "ea3c217a", "2026-10-22T16:21:22.495Z", "2026-10-22T19:20:00.495Z")] })],
  ]);
  const listed = new Map<string, string[]>([[folder, ["scheduled-jobs.json", "session-artifacts", "sub-132118ee"]], [`${folder}/session-artifacts`, [mail, mcp, "01a15456-827a-748b-9fdc-c3d35bf06aef"]]]);
  const reads: string[] = [];
  const disk: ArtifactDisk = { home: mac, list: async dir => listed.get(dir) ?? [], read: async file => { reads.push(file); return files.get(file) ?? null; } };
  const manual = `${error} [request_id: req_011CgHe8hr4JewuCmEKWHPQ7] pi-pool: Manual 89045843-4543-43a0-a5e5-f7bd8eaa40bf remains selected.`;
  const steps = [step("p81", "Mail senders work on staging: Gmail, custom domains, SMTP and real health states", "mail integrations", mail),
    step("p82", "The MCP connector's sign-in and every tool pass an automated test on local and staging", "mcp connector", mcp),
    { id: "p88", text: "Mailbox warmup", status: "blocked", waitFor: "mail integrations finishing its current mail sender parts", children: [] }];
  const sepBoard = { v: 2, rev: 1, updatedAt: "2026-10-22T07:00:00.000Z", todos: [], plan: [{ id: "p2", text: "The 5180 app works for real", status: "doing", children: steps }] } as unknown as ChatBoard;
  const job = (key: string, name: string, item: PlanItem, sessionId: string): JobFact => ({ key, name, state: "failed", error: manual, sessionId,
    activityAt: Date.parse("2026-10-22T17:06:21.585Z"), item: { id: item.id, text: item.text, status: item.status } });
  const read = [job("mail-key", "mail integrations", steps[0] as PlanItem, mail), job("mcp-key", "mcp connector", steps[1] as PlanItem, mcp)];
  const check = (facts: JobFact[]) => checkInPrecheck(undefined, facts, sepBoard, at, { self: [sep, "sep launch!!"], rows: [] });
  const before = check(read).end.filter(entry => !["moving", "foryou", "parked"].includes(entry.state)).map(entry => entry.view.item.id);
  assert.deepEqual(before.sort(), ["p81", "p82", "p88"], "with no park read, both jobs read failed and their steps are stuck");
  const facts = withQuotaParks(read, quotaParks(await parkSchedules(sep, [], new Set([mail, mcp]), disk), at), () => undefined);
  assert.deepEqual(facts.map(fact => [fact.name, fact.state, fact.parkedUntil]), [["mail integrations", "working", Date.parse("2026-10-22T19:20:00.420Z")],
    ["mcp connector", "working", Date.parse("2026-10-22T19:20:00.495Z")]]);
  const found = check(facts);
  assert.deepEqual(found.end.filter(entry => !["moving", "foryou", "parked"].includes(entry.state)).map(entry => entry.view.item.id), []);
  assert.ok(!reads.some(file => file.includes("01a15456")), "a session that is none of the chat's jobs is not read");
});

test("a chat on another box reads its artifacts through that box's relay, under the home its row's file names", async () => {
  const host = { name: "mac", address: "100.66.173.18", relayPort: 7790 } as unknown as Host;
  const catalog = { hostOf: (id: string) => id === "mac-chat" ? "mac" : null, hostEntry: (name: string) => name === "mac" ? host : undefined,
    remoteRows: () => [{ sessionId: "mac-chat", sessionFile: "/home/sieun/.cache/sieun-pi/hosts/mac/Users/sieunpark/.prime/agent/sessions/mac-chat.jsonl" }],
    daemonPath: (row: { sessionFile?: string }) => row.sessionFile?.replace("/home/sieun/.cache/sieun-pi/hosts/mac", "") };
  assert.equal((await chatDisk(catalog, "mac-chat"))?.home, "/Users/sieunpark");
  assert.equal(await chatDisk(catalog, "box-chat"), null);
});
