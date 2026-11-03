// 11-03 07:14Z: d9 read only the Prime chats and reported duties_green_pct 75, while the :5184 chat app, where vent, seo and mcp run since 10-29,
// showed vent d2 (old_model_calls_24h 8 against 0) and seo d1 and d2 red. d9 reads those chats' duties through the app's own API, counts them
// with no push, since sw factory runs them, and stops counting the paused Prime copy of each chat that moved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { appsChatDuties, greenPct, movedPrimeChats, readAppsChats } from "../scripts/duties/chat-system-apps.ts";
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
const board = (plan: unknown[]) => ({ board: { v: 2, rev: 1, updatedAt: "2026-11-03T00:00:00Z", todos: [], plan } });

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
    { id: "p117", text: "dropped_pages back to 0", status: "doing", duty: "d1/dropped_pages", job: "seo dropped pages", children: [] },
    { id: "p121", text: "Get the 12 articles indexed", status: "doing", duty: "d2/new_unindexed_3d", job: "unindexed articles 11-03",
      waitUntil: "2026-11-04T02:45:00Z", children: [] }] }]),
  "/api/agents/ag_seo/agents": { agents: [{ name: "seo dropped pages", state: "idle" }] },
  "/api/agents/ag_mcp/duties": { duties: [duty("d1", "Prod MCP", ["mcp_failing"], [run("d1", now - day, { mcp_failing: 0 })])] },
  "/api/agents/ag_mcp/board": board([]),
  "/api/agents/ag_mcp/agents": { agents: [] },
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
  assert.deepEqual(out, { chats: [], error: "fetch failed" });
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
