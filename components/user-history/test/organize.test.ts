import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionSummary } from "prime-agent";
import { parseSchedules, projectRow, runningByParent, sessionPulse } from "../src/chat-catalog.ts";
import { applyLabelAction, ChatLabels, LabelError, type LabelsState } from "../src/chat-labels.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import { readPulse } from "../src/shared/pulse.ts";
import { activeFilters, compareRows, createdAge, elapsed, emptyFilter, emptyRowFilter, groupRows, groupRowsByTag, matchesRowFilter, matchesFilter, modelShort, money, needsResponse, sortBy, statusOf, tabOf } from "../src/client/organize.ts";
import type { SessionRow, Tag } from "../src/shared/types.ts";

const artifacts = () => process.env.HISTORY_TEST_ARTIFACTS_DIR ?? join(import.meta.dirname, "../.test-artifacts");
const fresh = (): LabelsState => ({ tags: [], threads: Object.create(null) });
const row = (id: string, extra: Partial<SessionRow> = {}): SessionRow => ({ id, name: id, named: true, cwd: "/w", kind: "live", status: "idle", archived: false, messageCount: 2,
  unread: false, tags: [], priority: 0, progress: "none", created: "2026-09-10T10:00:00Z", lastActivityAt: "2026-09-20T10:00:00Z", ...extra });

test("labels: create reuses a tag by name, rename refuses a clash, delete strips it from every thread, empty entries are pruned", () => {
  const state = fresh();
  const bug = applyLabelAction(state, { op: "create", name: "  bug  ", ids: ["a", "b"] });
  assert(bug);
  assert.equal(applyLabelAction(state, { op: "create", name: "BUG", ids: ["c"] }), bug, "same name, any case, is the same tag");
  assert.deepEqual(state.tags.map(tag => tag.name), ["bug"]);
  assert.deepEqual(Object.keys(state.threads).sort(), ["a", "b", "c"]);
  const infra = applyLabelAction(state, { op: "create", name: "infra", ids: [] })!;
  assert.throws(() => applyLabelAction(state, { op: "rename", tagId: infra, name: "Bug" }), (error: unknown) => error instanceof LabelError && error.status === 409);
  applyLabelAction(state, { op: "rename", tagId: infra, name: "ops" });
  assert.equal(state.tags.find(tag => tag.id === infra)?.name, "ops");
  applyLabelAction(state, { op: "tag", tagId: infra, ids: ["a"], on: true });
  applyLabelAction(state, { op: "tag", tagId: infra, ids: ["a"], on: true });
  assert.deepEqual(state.threads.a?.tags, [bug, infra], "assigning twice keeps one copy");
  applyLabelAction(state, { op: "priority", ids: ["a", "z"], priority: 3 });
  assert.equal(state.threads.z?.priority, 3);
  applyLabelAction(state, { op: "delete", tagId: bug });
  assert.deepEqual(state.threads.a, { tags: [infra], priority: 3, progress: "none" });
  applyLabelAction(state, { op: "progress", ids: ["p"], progress: "qa" });
  assert.equal(state.threads.p?.progress, "qa");
  applyLabelAction(state, { op: "progress", ids: ["p"], progress: "none" });
  assert.equal(state.threads.p, undefined, "progress none with no tags or priority prunes the entry");
  assert.equal(state.threads.b, undefined, "a thread with no tags and priority 0 has no entry");
  applyLabelAction(state, { op: "priority", ids: ["z"], priority: 0 });
  assert.equal(state.threads.z, undefined);
  assert.throws(() => applyLabelAction(state, { op: "tag", tagId: bug, ids: ["a"], on: true }), (error: unknown) => error instanceof LabelError && error.status === 404);
  assert.throws(() => applyLabelAction(state, { op: "create", name: " ", ids: [] }), (error: unknown) => error instanceof LabelError && error.status === 400);
  applyLabelAction(state, { op: "priority", ids: ["__proto__"], priority: 2 });
  assert.equal(Object.getPrototypeOf(state.threads), null, "thread ids never reach an object prototype");
});

test("labels file: private, atomic, and concurrent writers all land", async () => {
  await mkdir(artifacts(), { recursive: true });
  const directory = await mkdtemp(join(artifacts(), "labels-"));
  const path = join(directory, "labels.json");
  const store = new ChatLabels(path);
  const { tagId } = await store.apply({ op: "create", name: "review", ids: [] });
  assert(tagId);
  await Promise.all(Array.from({ length: 20 }, (_, index) => new ChatLabels(path).apply(index % 2 ? { op: "tag", tagId, ids: [`s${index}`], on: true } : { op: "priority", ids: [`s${index}`], priority: 2 })));
  const saved = await new ChatLabels(path).snapshot();
  assert.equal(Object.keys(saved.threads).length, 20, "no write was lost under the lock");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).tags.map((tag: Tag) => tag.name), ["review"]);
  const reads = new ChatReadState(join(directory, "read-state.json"));
  await reads.mark("s1", { entryId: "4", timestamp: 50 });
  await reads.mark("s1", { entryId: "3", timestamp: 40 });
  assert.deepEqual((await reads.snapshot()).sessions.s1, { entryId: "4", timestamp: 50 }, "read markers share the lock and only move forward");
});

test("schedules come from active or paused jobs; heartbeat sources are heartbeats, the rest are cron", () => {
  const schedules = parseSchedules({ jobs: [
    { sessionId: "a", status: "cancelled", source: "rlm_heartbeat", schedule: { expression: "every 5m" } },
    { sessionId: "b", status: "paused", source: "heartbeat", label: "watch", schedule: { expression: "every 10m" } },
    { sessionId: "b", status: "active", source: "rlm_heartbeat", label: "recap", schedule: { expression: "5 21 * * *" }, nextRunAt: "2026-09-23T21:05:00Z" },
    { sessionId: "c", status: "active", source: "cron", schedule: { expression: "0 9 * * *" }, nextRunAt: "2026-09-24T09:00:00Z" },
    { sessionId: "c", status: "active", source: "cron", schedule: { expression: "0 8 * * *" }, nextRunAt: "2026-09-24T08:00:00Z" },
  ] });
  assert.equal(schedules.has("a"), false, "a cancelled job no longer makes a heartbeat thread");
  assert.deepEqual(schedules.get("b"), { kind: "heartbeat", status: "active", expression: "5 21 * * *", label: "recap", nextRunAt: "2026-09-23T21:05:00Z" });
  assert.equal(schedules.get("c")?.kind, "cron");
  assert.equal(schedules.get("c")?.expression, "0 8 * * *", "the next run wins");
  assert.equal(parseSchedules(null).size, 0);
});

test("catalog rows carry labels, schedule, and a working start only while busy", () => {
  const base = { id: "a", lifecycle: "live", activity: "working", isSessionActive: true, sessionId: "a", activeSessionId: "live-a", cwd: "/tmp", isStreaming: true, isCompacting: false,
    attachedClients: 0, messageCount: 3, sessionActions: { queuedCount: 0, steering: [], followUps: [] } } as unknown as SessionSummary;
  const busy = projectRow({ ...base, usage: { inputTokens: 10, outputTokens: 5, cost: 1.25 } } as SessionSummary, undefined, 0, { labels: { tags: ["t1"], priority: 2, progress: "plan" }, workingSince: Date.parse("2026-09-23T08:00:00Z"),
    schedule: { kind: "heartbeat", status: "active", expression: "every 5m" } });
  assert.equal(busy.status, "running");
  assert.deepEqual([busy.tags, busy.priority, busy.workingSince, busy.schedule?.kind], [["t1"], 2, "2026-09-23T08:00:00.000Z", "heartbeat"]);
  const idle = projectRow({ ...base, isStreaming: false }, undefined, 0, { workingSince: 1 });
  assert.equal(idle.workingSince, undefined);
  assert.deepEqual([idle.tags, idle.priority, idle.progress, idle.cost], [[], 0, "none", undefined], "no usage from the daemon means an unknown cost");
  assert.deepEqual([busy.progress, busy.cost], ["plan", 1.25]);
});

test("sidebar order: needs response, then working, then the rest by priority and recency", () => {
  const rows = [
    row("old-high", { priority: 3, lastActivityAt: "2026-09-01T00:00:00Z" }),
    row("recent", { lastActivityAt: "2026-09-22T00:00:00Z" }),
    row("working", { status: "running" }),
    row("needs-low", { unread: true, lastActivityAt: "2026-09-02T00:00:00Z" }),
    row("needs-high", { unread: true, priority: 2, lastActivityAt: "2026-09-01T00:00:00Z" }),
    row("heartbeat", { schedule: { kind: "heartbeat", status: "active", expression: "every 5m" } }),
  ];
  assert.deepEqual([...rows].sort(compareRows).map(item => item.id), ["needs-high", "needs-low", "working", "old-high", "recent", "heartbeat"]);
  assert.deepEqual(groupRows(rows).map(group => [group.bucket, group.rows.length]), [["needs", 2], ["working", 1], ["other", 3]]);
  assert.equal(needsResponse(row("x", { status: "running", unread: true })), false, "a running thread never needs a response");
  assert.equal(statusOf(row("s", { status: "saved" })), "saved");
  assert.equal(tabOf(rows[5]!), "heartbeats");
  assert.deepEqual([elapsed(20_000), elapsed(12 * 60_000), elapsed(125 * 60_000), elapsed(50 * 3_600_000)], ["<1m", "12m", "2h 5m", "2d"]);
});

test("agents filters combine and sort by any column", () => {
  const tags = new Map<string, Tag>([["t1", { id: "t1", name: "infra", hue: 1 }]]);
  const rows = [
    row("a", { tags: ["t1"], priority: 1, created: "2026-09-20T12:00:00", model: "anthropic/opus" }),
    row("b", { created: "2026-09-10T12:00:00", cwd: "/other", archived: true }),
    row("c", { created: "2026-09-21T12:00:00", schedule: { kind: "cron", status: "paused", expression: "0 9 * * *" } }),
  ];
  const ids = (filter: Partial<ReturnType<typeof emptyFilter>>) => rows.filter(item => matchesFilter(item, { ...emptyFilter(), ...filter }, tags)).map(item => item.id);
  assert.deepEqual(ids({}), ["a", "c"], "archived threads stay out unless asked for");
  assert.deepEqual(ids({ archived: true, cwd: "/other" }), ["b"]);
  assert.deepEqual(ids({ query: "infra" }), ["a"], "search covers tag names");
  assert.deepEqual(ids({ tag: "none" }), ["c"]);
  assert.deepEqual(ids({ kind: "heartbeats" }), ["c"]);
  assert.deepEqual(ids({ from: "2026-09-20", to: "2026-09-20" }), ["a"], "the date range includes the whole last day");
  assert.deepEqual(ids({ priority: 1, model: "anthropic/opus" }), ["a"]);
  assert.deepEqual(sortBy(rows, "created", true, tags).map(item => item.id), ["c", "a", "b"]);
  assert.deepEqual(sortBy(rows, "tags", false, tags).map(item => item.id)[2], "a");
});

test("row shorthand: model names and session cost", () => {
  assert.deepEqual(["anthropic/claude-opus-5-5", "anthropic/claude-fable-5-1", "openai-codex/gpt-6-astra", "anthropic/claude-haiku-4-5-20251001", "openai-codex/gpt-5.4-mini", undefined].map(modelShort),
    ["opus-5.5", "fable-5.1", "astra-6", "haiku-4.5", "gpt-5.4-mini", ""]);
  assert.deepEqual([money(0), money(1.234), money(250.4), money(undefined)], ["$0.00", "$1.23", "$250", "–"]);
});

test("sidebar: chronological sort is one unlabeled list by activity, created age counts calendar days, row filters count and match", () => {
  const rows = [row("old", { lastActivityAt: "2026-09-20T10:00:00Z" }), row("needs", { unread: true, lastActivityAt: "2026-09-19T10:00:00Z" }), row("new", { lastActivityAt: "2026-09-21T10:00:00Z" })];
  assert.deepEqual(groupRows(rows).map(group => group.bucket), ["needs", "other"]);
  const recent = groupRows(rows, "recent");
  assert.equal(recent.length, 1);
  assert.equal(recent[0]!.bucket, null);
  assert.deepEqual(recent[0]!.rows.map(entry => entry.id), ["new", "old", "needs"]);
  assert.deepEqual(groupRows([], "recent"), []);
  const tags: Tag[] = [{ id: "t1", name: "infra", hue: 10 }, { id: "t2", name: "seo", hue: 200 }, { id: "t3", name: "unused", hue: 300 }];
  const tagged = [row("a", { tags: ["t2"], lastActivityAt: "2026-09-21T10:00:00Z" }), row("b", { tags: ["t1", "t2"], status: "running" }), row("c", { tags: ["gone"] }), row("d")];
  const byTag = groupRowsByTag(tagged, tags);
  assert.deepEqual(byTag.map(group => [group.tag?.name ?? null, group.rows.map(entry => entry.id)]),
    [["infra", ["b"]], ["seo", ["b", "a"]], [null, ["c", "d"]]], "tag order from the list, a row under each of its tags, unknown tag ids count as no tag, unused tags are left out");
  assert.deepEqual(groupRowsByTag(tagged, tags, "recent")[1]!.rows.map(entry => entry.id), ["a", "b"], "chronological sort orders inside each tag");
  assert.deepEqual(groupRowsByTag([row("a", { tags: ["t1"] })], tags).map(group => group.tag?.id), ["t1"], "no empty No tag section");
  const now = new Date(2026, 8, 23, 15, 0).getTime();
  assert.equal(createdAge(new Date(2026, 8, 23, 0, 5).toISOString(), now), "", "created today shows nothing");
  assert.equal(createdAge(new Date(2026, 8, 22, 23, 50).toISOString(), now), "1d");
  assert.equal(createdAge(new Date(2026, 8, 11, 12, 0).toISOString(), now), "12d");
  assert.equal(createdAge(new Date(2026, 5, 1).toISOString(), now), "3mo");
  assert.equal(createdAge(undefined, now), "");
  const filter = { ...emptyRowFilter(), priority: 2 as const, tag: "none" };
  assert.equal(activeFilters(filter), 2);
  assert.equal(activeFilters(emptyFilter()), 0);
  assert.equal(matchesRowFilter(row("a", { priority: 2 }), filter), true);
  assert.equal(matchesRowFilter(row("b", { priority: 2, tags: ["t1"] }), filter), false);
  assert.equal(matchesRowFilter(row("c", { priority: 1 }), filter), false);
});

test("pulse: live under a minute, quiet to five, then stalled; a current failure line is failed, one that later messages passed is not", () => {
  const now = Date.parse("2026-09-23T12:00:00Z");
  const at = (secondsAgo: number) => new Date(now - secondsAgo * 1000).toISOString();
  const base = { streaming: true, tools: false, bash: false, children: false };
  assert.equal(readPulse({ ...base, activityAt: at(20) }, now).level, "live");
  assert.deepEqual(readPulse({ ...base, activityAt: at(180) }, now), { level: "quiet", quietMs: 180_000, text: "quiet 3m" });
  assert.deepEqual(readPulse({ ...base, activityAt: at(41 * 60) }, now), { level: "stalled", quietMs: 41 * 60_000, text: "no activity 41m" });
  const limit = "Model request failed: Provider rate limit exceeded (rate_limit_error, 429): This request would exceed your account's rate limit.";
  assert.equal(readPulse({ ...base, activityAt: at(5), summary: limit, summaryCurrent: true }, now).level, "failed", "the daemon judged the line at this message count");
  assert.equal(readPulse({ ...base, streaming: false, children: true, activityAt: at(5), summary: limit, summaryCurrent: true }, now).level, "failed", "a parent whose last call failed while its subagents run");
  assert.equal(readPulse({ ...base, activityAt: at(5), summary: limit }, now).level, "live", "a thread that ran on past the failed call is judged by activity");
  assert.deepEqual(readPulse({ ...base, activityAt: at(200), summary: limit }, now), { level: "quiet", quietMs: 200_000, text: "quiet 3m" });
  assert.equal(readPulse({ ...base, activityAt: at(5), silentSince: at(120) }, now).text, "worker silent 2m");
  assert.equal(readPulse({ ...base, activityAt: at(5), failed: true }, now).level, "failed");
});

test("session pulse takes activity from running subagents below the thread and lists its direct ones", () => {
  const summary = (extra: Record<string, unknown>) => ({ sessionId: "s", cwd: "/w", isStreaming: false, isCompacting: false, messageCount: 1, sessionActions: { active: null, queuedCount: 0 }, ...extra }) as unknown as SessionSummary;
  const parent = summary({ sessionId: "p", hasRunningRlmChildren: true, lastActivityAt: "2026-09-23T10:00:00Z", summary: "Model request failed: 403", taskState: "error" });
  const child = summary({ sessionId: "c", parentSessionId: "p", rlmChildId: "sub-1", isStreaming: true, isRunningTools: true, lastActivityAt: "2026-09-23T10:05:00Z" });
  const grandchild = summary({ sessionId: "g", parentSessionId: "c", rlmChildId: "sub-2", isStreaming: true, lastActivityAt: "2026-09-23T10:09:00Z" });
  const idle = summary({ sessionId: "i", parentSessionId: "p", rlmChildId: "sub-3", lastActivityAt: "2026-09-23T11:00:00Z" });
  const pulse = sessionPulse(parent, runningByParent([child, grandchild, idle]));
  assert.equal(pulse.activityAt, "2026-09-23T10:09:00.000Z", "the freshest running descendant counts, finished ones do not");
  assert.deepEqual(pulse.subagents.map(entry => [entry.rlmChildId, entry.tools, entry.activityAt]), [["sub-1", true, "2026-09-23T10:09:00.000Z"]]);
  assert.equal(pulse.summary, "Model request failed: 403");
  assert.equal(pulse.summaryCurrent, true, "taskState on the wire means the daemon judged the summary at this message count");
  assert.equal(sessionPulse(summary({ sessionId: "p", isStreaming: true, summary: "Model request failed: 403" }), new Map()).summaryCurrent, undefined);
});
