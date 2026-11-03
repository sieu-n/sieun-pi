// 11-03 07:14Z: d9 read only the Prime chats and reported duties_green_pct 75, while the :5184 chat app, where vent, seo and mcp run since 10-29,
// showed vent d2 (old_model_calls_24h 8 against 0) and seo d1 and d2 red. d9 reads those chats' duties through the app's own API, counts them
// with no push, since sw factory runs them, and stops counting the paused Prime copy of each chat that moved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { greenPct, movedPrimeChats, readAppsChats } from "../scripts/duties/chat-system-apps.ts";
import { appsChatDuties, appsOwnerReads, appsStuckSteps, type AppsChat, type AppsSession } from "../src/apps-step-owners.ts";
import type { Wake } from "../src/wakes.ts";
import { chatSystemOutput, type RedDuty } from "../scripts/duties/chat-system.ts";

const now = Date.parse("2026-11-03T07:20:00Z");
const PRIME_VENT = "01a14dd5-e9d3-705d-bd63-245c21b2eee2";
const metric = (key: string, value: number, headline = false) => ({ key, label: key, op: "<=", target: 0, ...headline ? { headline } : {}, value });
const run = (duty: string, at: number, results: Record<string, number>, extra: Record<string, unknown> = {}) => ({ duty, at, trigger: "schedule", ms: 1000,
  verdict: Object.values(results).some(value => value > 0) ? "missed" : "met", summary: "", ...extra,
  metrics: Object.fromEntries(Object.entries(results).map(([key, value]) => [key, { value, target: 0, op: "<=", met: value <= 0 }])) });
const day = 86_400_000;
const duty = (id: string, name: string, keys: string[], runs: unknown[]) => ({ duty: { id, name, status: "active",
  metrics: keys.map((key, index) => { const { value: _value, ...rest } = metric(key, 0, index === 0); return rest; }) }, paused: false, running: false, runs });
const board = (plan: unknown[]) => ({ board: { v: 2, rev: 1, updatedAt: "2026-11-03T00:00:00Z", plan,
  todos: [{ id: "t3", text: "Sign in Search Console", done: false, step: "p90" }] } });

const FIXTURE: Record<string, unknown> = {
  "/api/agents": [{ id: "ag_vent", name: "vent", kind: "chat" }, { id: "ag_seo", name: "seo", kind: "chat" }, { id: "ag_mcp", name: "mcp", kind: "chat" },
    { id: "ag_old", name: "old", kind: "chat", archived: true }],
  "/api/agents/ag_vent/duties": { duties: [
    duty("d1", "Vent gateway", ["through_vent_pct"], [run("d1", now - day, { through_vent_pct: 0 },
      { detail: `/home/sieun/.prime/agent/browser-chat/duties/${PRIME_VENT}/d1-261028-0704.json` })]),
    duty("d2", "Vent integrations", ["vent_success", "old_model_calls_24h"], [8, 5, 1].map((value, index) =>
      run("d2", now - (index + 1) * day, { vent_success: 0, old_model_calls_24h: value }))),
  ] },
  "/api/agents/ag_vent/board": board([{ id: "p28", text: "Vent calls succeed", status: "todo", children: [
    { id: "p123", text: "Move the last callers off older models", status: "doing", duty: "d2/old_model_calls_24h", waitUntil: "2026-11-03T21:50:00Z", children: [] }] }]),
  "/api/agents/ag_vent/agents": { agents: [{ name: "vent refused key caller", state: "idle" }] },
  "/api/agents/ag_seo/duties": { duties: [
    duty("d1", "Search traffic", ["dropped_pages"], [9, 8].map((value, index) => run("d1", now - (index + 1) * day, { dropped_pages: value }))),
    duty("d2", "New articles get indexed", ["new_unindexed_3d"], [12, 31].map((value, index) => run("d2", now - (index + 1) * day, { new_unindexed_3d: value }))),
  ] },
  "/api/agents/ag_seo/board": board([{ id: "p56", text: "Reach 10,000 visits a day", status: "doing", children: [
    { id: "p67", text: "Lift visits with new reach", status: "doing", children: [] },
    { id: "p90", text: "Request indexing from the owner's Mac", status: "blocked", waitFor: "the owner's answer on t3", children: [] },
    { id: "p117", text: "dropped_pages back to 0", status: "doing", duty: "d1/dropped_pages", job: "seo dropped pages", sessionId: "b99a7650-d2bd-4712-825e-eae6b96595f8", children: [] },
    { id: "p121", text: "Get the 12 articles indexed", status: "doing", duty: "d2/new_unindexed_3d", job: "unindexed articles 11-03",
      sessionId: "67e9709a-1aa7-45f4-ac89-fc43d0b578d8", waitUntil: "2026-11-04T02:45:00Z", children: [] }] }]),
  "/api/agents/ag_seo/agents": { agents: [{ name: "seo dropped pages", state: "idle" }] },
  "/api/agents/ag_mcp/duties": { duties: [duty("d1", "Prod MCP", ["mcp_failing"], [run("d1", now - day, { mcp_failing: 0 })])] },
  "/api/agents/ag_mcp/board": board([]),
  "/api/agents/ag_mcp/agents": { agents: [] },
  "/api/conversations": [{ id: "b99a7650-d2bd-4712-825e-eae6b96595f8", kind: "solo", name: "seo dropped pages", status: "idle", lastActivityAt: now - 5 * 3_600_000 },
    { id: "67e9709a-1aa7-45f4-ac89-fc43d0b578d8", kind: "solo", name: "unindexed articles 11-03", status: "idle", lastActivityAt: now - 4 * 3_600_000 },
    { id: "67e9709a-1aa7-45f4-ac89-fc43d0b578d8:12", kind: "job", name: "ja caption page", status: "idle", lastActivityAt: now - 60_000, parent: "67e9709a-1aa7-45f4-ac89-fc43d0b578d8" }],
  ...Object.fromEntries(["ag_vent", "ag_seo", "ag_mcp"].map(id => [`/api/agents/${id}/check-in`, { everyMs: 7_200_000 }])),
};
const get = async (url: string): Promise<unknown> => {
  const path = url.replace("http://chat.test", "");
  if (!(path in FIXTURE)) throw new Error(`${url} answered 404`);
  return FIXTURE[path];
};

test("d9 reads the :5184 chats' duties: vent d2 and seo d1 are red with no fix, seo d2 waits on its fix step's time", async () => {
  const { chats, error } = await readAppsChats("http://chat.test", get);
  assert.equal(error, undefined);
  assert.deepEqual(chats.map(chat => chat.id), ["ag_vent", "ag_seo", "ag_mcp"]);
  const duties = chats.flatMap(chat => appsChatDuties(chat, now));
  const red = duties.filter(entry => !entry.green);
  assert.deepEqual(red.map(entry => [entry.chat, entry.duty, entry.metric?.key, entry.metric?.value, entry.misses, entry.fix ?? null, entry.stuck]), [
    ["ag_vent", "d2", "old_model_calls_24h", 8, 3, null, true],
    ["ag_seo", "d1", "dropped_pages", 9, 2, null, true],
    ["ag_seo", "d2", "new_unindexed_3d", 12, 2, "p121", false],
  ]);
  assert.equal(greenPct(duties), 40);
});

test("a :5184 chat that does not answer reads as an error and adds no duty", async () => {
  const out = await readAppsChats("http://chat.test", async () => { throw new Error("fetch failed"); });
  assert.deepEqual(out, { chats: [], sessions: [], error: "fetch failed" });
});

test("the Prime copies of moved chats leave the count, by their imported runs or their name", async () => {
  const { chats } = await readAppsChats("http://chat.test", get);
  const prime = new Map([[PRIME_VENT, "vent copy"], ["01a162bc-47b4-770b-a9fc-19c3a742e730", "(temp) mcp"], ["01a1180e-6567-747f-bf44-452520ebdd1b", "CI and RepoOps"]]);
  assert.deepEqual([...movedPrimeChats(chats, prime)].sort(), [PRIME_VENT, "01a162bc-47b4-770b-a9fc-19c3a742e730"].sort());
});

test("a :5184 red duty counts in red_duty and stuck_duties, and no push goes to its chat", async () => {
  const { chats } = await readAppsChats("http://chat.test", get);
  const duties = chats.flatMap(chat => appsChatDuties(chat, now));
  const red = duties.filter(entry => !entry.green) as RedDuty[];
  const out = chatSystemOutput({ names: new Map([["ag_vent", "vent (:5184)"], ["ag_seo", "seo (:5184)"]]), stuck: [], upkeep: [],
    fleet: { pct: greenPct(duties), red }, idleGoals: [], followUps: [], detail: "/tmp/d9.md", noPush: new Set(["ag_vent", "ag_seo"]),
    stuckDuties: red.filter(entry => entry.stuck).map(entry => ({ chat: entry.chat, line: `${entry.chat} ${entry.duty}` })) });
  assert.equal(out.metrics.duties_green_pct, 40);
  assert.equal(out.metrics.stuck_duties, 2);
  assert.match(out.flagged!.find(slice => slice.kind === "red_duty")!.excerpt, /^3 red duties in 2 chats/);
  assert.equal(out.flagged!.some(slice => slice.kind === "push"), false);
});

test("d9 counts a :5184 chat's open steps nobody moves, as a paused Prime chat's, and a wake or a subagent at work moves a step", async () => {
  const { chats, sessions } = await readAppsChats("http://chat.test", get);
  const wakes = [{ session: "b99a7650-d2bd-4712-825e-eae6b96595f8--1", on: { kind: "time", at: now + 3_600_000 }, note: "", since: now - day }] as Wake[];
  const stuck = (id: string, owed: readonly Wake[]) => { const chat = chats.find(entry => entry.id === id)!;
    return appsStuckSteps(chat, appsOwnerReads(chat, sessions, owed, now), now).map(item => item.id); };
  // p117's job sleeps on a wake, p121's job has a subagent that wrote a minute ago, p90 waits on the open todo t3, and p67 has no owner.
  assert.deepEqual(stuck("ag_seo", wakes), ["p67"]);
  assert.deepEqual(stuck("ag_seo", []), ["p67", "p117"]);
  assert.deepEqual(stuck("ag_vent", wakes), ["p123"]);
  const seo = chats.find(entry => entry.id === "ag_seo")!;
  const fixed = appsChatDuties(seo, now, appsOwnerReads(seo, sessions, wakes, now)).find(entry => entry.duty === "d1")!;
  assert.deepEqual([fixed.fix, fixed.stuck], ["p117", false]);
  const out = chatSystemOutput({ names: new Map([["ag_seo", "seo (:5184)"]]), upkeep: [], fleet: { pct: 100, red: [] }, idleGoals: [], followUps: [],
    detail: "/tmp/d9.md", noPush: new Set(["ag_seo"]), stuckDuties: [], stuck: [{ chat: "ag_seo", id: "p67", text: "Lift visits with new reach" }] });
  assert.equal(out.metrics.stuck_steps_all, 1);
  assert.equal(out.flagged!.some(slice => slice.kind === "push"), false);
});

test("a :5184 step the chat's own thread watches moves: a thread wake names it or goes off at its waitUntil, or its red duty's next run is due before it", async () => {
  // 11-03 07:51Z: d9 counted seo's p67, p68, p81 and p102 and vent's p117 stuck while the chat threads' own wakes named them or went off at
  // their waitUntil, and vent's p123, the fix of red d2, waited until 21:50Z for d2's 21:44Z run.
  const VENT = "230bbdbf-4d84-475f-95d2-63db2f90ca34", SEO = "95399ef6-9e52-4b9e-8d71-737332eee4dd";
  const nextAt = Date.parse("2026-11-03T21:44:00Z");
  const ventDuties = FIXTURE["/api/agents/ag_vent/duties"] as { duties: Record<string, unknown>[] };
  const ventBoard = FIXTURE["/api/agents/ag_vent/board"] as { board: { plan: { children: unknown[] }[] } };
  const fixture: Record<string, unknown> = { ...FIXTURE,
    "/api/agents": (FIXTURE["/api/agents"] as Record<string, unknown>[]).map(row => ({ ...row, ...row.id === "ag_vent" ? { thread: VENT } : row.id === "ag_seo" ? { thread: SEO } : {} })),
    "/api/agents/ag_vent/duties": { duties: ventDuties.duties.map(row => ({ ...row, nextAt, schedule: { kind: "daily", at: "06:44" } })) },
    "/api/agents/ag_vent/board": { board: { ...ventBoard.board, plan: [{ ...ventBoard.board.plan[0], children: [...ventBoard.board.plan[0]!.children,
      { id: "p117", text: "Remove the paid Anthropic fallback", status: "blocked", waitUntil: "2026-11-10T00:30:00.000Z", waitFor: "Nov 10; this chat's wake starts the job", children: [] }] }] } },
  };
  const { chats, sessions } = await readAppsChats("http://chat.test", async url => fixture[url.replace("http://chat.test", "")]);
  const wakes = [
    { session: `${VENT}--1`, on: { kind: "time", at: Date.parse("2026-11-10T00:30:00Z") }, note: "Paid Anthropic account lapses Nov 10. Start a job to remove the fallback.", since: now - day },
    { session: `${SEO}--1`, on: { kind: "time", at: now + day }, note: "p67: read the 11-13 ledger lines; also p6 and p1170.", since: now - day },
    { session: "b99a7650-d2bd-4712-825e-eae6b96595f8--1", on: { kind: "time", at: now + 3_600_000 }, note: "", since: now - day },
  ] as Wake[];
  const chat = (id: string) => chats.find(entry => entry.id === id)!;
  const stuck = (id: string, owed: readonly Wake[], at = now) => appsStuckSteps(chat(id), appsOwnerReads(chat(id), sessions, owed, at), at).map(item => item.id);
  assert.deepEqual(stuck("ag_vent", wakes), []);
  assert.deepEqual(stuck("ag_seo", wakes), []);
  // Without the thread's wakes p117 and p67 have no owner, and p123 stays held only until its waitUntil passes.
  assert.deepEqual(stuck("ag_vent", []), ["p117"]);
  assert.deepEqual(stuck("ag_seo", wakes.slice(2)), ["p67"]);
  assert.deepEqual(stuck("ag_vent", wakes, Date.parse("2026-11-03T21:51:00Z")), ["p123"]);
  // A wake of another chat's thread that names p67 does not hold seo's p67.
  assert.deepEqual(stuck("ag_seo", [{ ...wakes[1]!, session: `${VENT}--1` }, wakes[2]!]), ["p67"]);
  const vent = appsChatDuties(chat("ag_vent"), now, appsOwnerReads(chat("ag_vent"), sessions, wakes, now)).find(entry => entry.duty === "d2")!;
  assert.deepEqual([vent.fix, vent.metric?.fix?.step, vent.stuck], ["p123", "p123", false]);
});

test("a :5184 step whose job is a subagent of the chat's own duty job moves while that subagent works", () => {
  // 11-03 09:16Z: d9 counted agent factory's p72 and p73 stuck while "fast agents list" and "fast accounts and usage", subagents of the chat's d2
  // duty job, worked on them; the chat's job rows list no subagent of a root job, so only the conversation rows below the chat name them.
  const at = Date.parse("2026-11-03T09:16:00Z");
  const step = (id: string, job: string) => ({ id, text: id, status: "doing", children: [], job, duty: "d2/slowest_api_p90_ms" });
  const chat: AppsChat = { id: "ag_agent-factory", name: "agent factory", thread: "72ba1ed2", duties: [], everyMs: 7_200_000,
    board: { plan: [step("p72", "fast agents list"), step("p73", "fast accounts and usage")], todos: [] } as never,
    jobs: [{ name: "sw factory stays snappy duty", state: "working", sessionId: "921268a2", lastActivityAt: new Date(at).toISOString() }] };
  const sessions = (status: string, wrote: number): AppsSession[] => [
    { id: "921268a2", name: "sw factory stays snappy duty", status, lastActivityAt: wrote, parent: "ag_agent-factory" },
    { id: "921268a2:59", name: "fast agents list", status, lastActivityAt: wrote, parent: "921268a2" },
    { id: "921268a2:71", name: "fast accounts and usage", status, lastActivityAt: wrote, parent: "921268a2" },
    { id: "5dd8a232:9", name: "fast agents list", status: "working", lastActivityAt: wrote, parent: "ag_mcp" },
  ];
  const stuck = (rows: AppsSession[], now: number) => appsStuckSteps(chat, appsOwnerReads(chat, rows, [], now), now).map(item => item.id);
  assert.deepEqual(stuck(sessions("working", at), at), []);
  // An hour after the subagents went idle nobody moves either step, and a job of the same name under another chat does not move p72.
  assert.deepEqual(stuck(sessions("idle", at), at + 3_600_000), ["p72", "p73"]);
});
