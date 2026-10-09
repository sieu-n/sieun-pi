import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { boardClasses, type DaemonSession } from "../scripts/duties/board-classes.ts";
import { fixArgs } from "../scripts/corrections-fix.ts";
import { checkInDigest, checkInJobBrief, checkInJobMessage, isHandoffTarget, matchTopic, scopeLine, scopeMisses, STEP_STALE_MS } from "../src/chat-checkin.ts";
import { applyCorrection, type ChatRef, CorrectionLedger, correctionResult, handoffRules, type HandoffRule, type Ledger, ledgerPrompt, parseCorrectionCall, parseLedger } from "../src/chat-corrections.ts";
import type { PrecheckOutput } from "../src/shared/chat-duties.ts";
import type { ChatBoard, OwnerTodo, PlanItem } from "../src/shared/types.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse("2026-10-09T15:00:00Z");
const VP: ChatRef = { id: "vp", name: "dev VP" };
const OPS = "ops guy (+observability)";
const TOPICS = ["M1 Air", "M2 Air", "Mac load", "load average", "swap", "memory pressure", "launchd"];
const RULE: HandoffRule = { correction: "c7", to: OPS, topics: TOPICS };
const step = (id: string, text: string, status: PlanItem["status"], extra: Partial<PlanItem> = {}): PlanItem => ({ id, text, status, children: [], ...extra });
const board = (plan: PlanItem[], todos: OwnerTodo[] = []): ChatBoard => ({ v: 2, rev: 1, updatedAt: "", scratch: [], todos, plan });
const todo = (id: string, text: string, extra: Partial<OwnerTodo> = {}): OwnerTodo => ({ id, text, done: false, from: "agent", at: "", ...extra });

test("ledger handoff: an add and a fix carry it, the file round-trips it, a bad one is dropped alone, the prompt names it, a retired entry has none", async () => {
  const ledger: Ledger = { corrections: [] };
  const first = applyCorrection(ledger, parseCorrectionCall({ words: "ops guy owns the Macs", rule: "Machine work goes to ops guy.", theme: "mac machine ops guy",
    enforcedBy: "brief", ref: "s76", handoff: { to: OPS, topics: "M1 Air, swap ,swap" } }), VP, "2026-10-09T10:00:00.000Z");
  assert.deepEqual(first.entry.handoff, { to: OPS, topics: ["M1 Air", "swap"] });
  applyCorrection(ledger, parseCorrectionCall({ words: "explain it", rule: "Explanations get a todo.", theme: "explanation article link", enforcedBy: "brief", ref: "x" }), VP, "2026-10-09T10:01:00.000Z");
  const handoffOnly = parseCorrectionCall({ id: "c2", handoff: { to: "docs thread", topics: ["article"] } });
  assert.deepEqual(handoffOnly, { kind: "fix", fix: { id: "c2", handoff: { to: "docs thread", topics: ["article"] } } }, "a handoff alone leaves the status");
  ledger.corrections[1]!.status = "reopened";
  applyCorrection(ledger, handoffOnly, VP, "2026-10-09T10:02:00.000Z");
  assert.equal(ledger.corrections[1]!.status, "reopened");
  const pending = applyCorrection(ledger, parseCorrectionCall({ id: "c1", enforcedBy: "code", ref: "pending commit", status: "reopened", handoff: { to: OPS, topics: TOPICS } }), VP, "");
  assert.deepEqual([pending.entry.status, pending.entry.enforcedBy, pending.entry.ref, pending.entry.handoff?.topics.length], ["reopened", "code", "pending commit", 7]);
  assert.match(correctionResult(pending), /^Updated c1: enforced by code \(pending commit\), reopened; steps on M1 Air, M2 Air, .* go to ops guy \(\+observability\)\.$/);
  assert.equal(parseCorrectionCall({ id: "c1", ref: "abc1234" }).kind === "fix" && (parseCorrectionCall({ id: "c1", ref: "abc1234" }) as { fix: { status?: string } }).fix.status, "active",
    "a ref alone means the fix landed");
  assert.throws(() => parseCorrectionCall({ id: "c1" }), /a fix gives/);
  assert.throws(() => parseCorrectionCall({ id: "c1", handoff: { to: OPS, topics: [] } }), /handoff.topics/);

  const dir = await mkdtemp(join(tmpdir(), "scope-ledger-"));
  try {
    const store = new CorrectionLedger(dir);
    await store.apply(parseCorrectionCall({ words: "ops guy owns the Macs", rule: "Machine work goes to ops guy.", theme: "mac machine ops guy", enforcedBy: "brief", ref: "s76" }), VP);
    await store.apply(parseCorrectionCall({ id: "c1", handoff: { to: OPS, topics: TOPICS } }), VP);
    const read = await store.read();
    assert.deepEqual(read.corrections[0]!.handoff, { to: OPS, topics: TOPICS });
    assert.deepEqual(parseLedger(JSON.parse(await readFile(store.path, "utf8"))), read);
    const broken = parseLedger({ corrections: [{ ...read.corrections[0], handoff: { to: "", topics: ["x"] } }] });
    assert.equal(broken.corrections.length, 1, "the entry stays");
    assert.equal(broken.corrections[0]!.handoff, undefined);
    assert.deepEqual(handoffRules(read), [{ correction: "c1", to: OPS, topics: TOPICS }]);
    assert.match(ledgerPrompt(read)!, /- c1 Machine work goes to ops guy\. Steps on M1 Air, M2 Air, Mac load, load average, swap, memory pressure, launchd belong to ops guy \(\+observability\)\./);
    await store.apply(parseCorrectionCall({ id: "c1", status: "retired" }), VP);
    assert.deepEqual(handoffRules(await store.read()), []);
    const args = fixArgs(["c1", "--ref", "abc1234", "--status", "active", "--handoff-to", OPS, "--topics", "swap,launchd", "--data-dir", dir]);
    assert.deepEqual(args, { dataDir: dir, call: { id: "c1", ref: "abc1234", status: "active", handoff: { to: OPS, topics: "swap,launchd" } } });
    const run = spawnSync(process.execPath, ["--import", "tsx", join(import.meta.dirname, "..", "scripts", "corrections-fix.ts"), "c1", "--enforced-by", "code", "--ref", "abc1234", "--data-dir", dir],
      { cwd: join(import.meta.dirname, ".."), encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^Updated c1: enforced by code \(abc1234\), active; steps on .* go to ops guy/);
    assert.equal((await store.read()).corrections[0]!.status, "active");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("scope: a topic as whole words in a step's text or note; not in the target chat, not when handed off, waiting on or owned by the target", () => {
  const cases: [string, string | undefined][] = [
    ["Check the M2 Air swap use", "M2 Air"], ["Find why the m1-air is slow", "M1 Air"], ["Mac load is 40", "Mac load"], ["Lower memory pressure on this Mac", "memory pressure"],
    ["Swapper service config", undefined], ["Air quality chart", undefined], ["Reload averages", undefined], ["Ship the launch page", undefined], ["Two launchd agents", "launchd"],
  ];
  for (const [text, topic] of cases) assert.equal(matchTopic(text, TOPICS), topic, text);
  assert.equal(isHandoffTarget(OPS, ["01a11af8-962e-773d-a19a-ee4104011987", OPS]), true);
  assert.equal(isHandoffTarget(OPS, ["x", "Ops Guy"]), true, "the name without its parenthesis");
  assert.equal(isHandoffTarget("thread 01a11af8-962e-773d-a19a-ee4104011987", ["01a11af8-962e-773d-a19a-ee4104011987"]), true, "by session id");
  assert.equal(isHandoffTarget(OPS, ["vp", "dev VP"]), false);

  const plan = board([
    step("p1", "Machines", "doing", { note: "the M1 Air swaps", children: [step("p2", "Check swap on the M1 Air", "todo"), step("p3", "Also launchd", "todo")] }),
    step("p4", "Usage panel", "doing", { note: "load average spikes at 14:00", children: [] }),
    step("p5", "Land the fix", "doing"),
    step("p6", "Memory pressure", "todo", { note: "handed off to ops guy at 13:10" }),
    step("p7", "Mac load", "blocked", { waitFor: "ops guy answer" }),
    step("p8", "Swap audit", "doing", { job: OPS }),
    step("p10", "Launchd plist", "todo", { job: "thread:01a11af8-962e-773d-a19a-ee4104011987" }),
    step("p9", "M2 Air", "done"),
  ]);
  const misses = scopeMisses(plan, [RULE], ["vp", "dev VP"]);
  assert.deepEqual(misses.map(miss => `${miss.item.id} ${miss.topic}`), ["p1 M1 Air", "p4 load average", "p10 launchd"],
    "a goal covers its steps; a done step, a handoff, a wait on the target and the target as owner are left");
  assert.equal(scopeLine(misses[0]!), `p1 "Machines" belongs to ${OPS} (correction c7): hand it off with a message to that thread and remove it from this plan`);
  const byId = { ...RULE, to: `${OPS}, thread:01a11af8-962e-773d-a19a-ee4104011987` };
  assert.deepEqual(scopeMisses(plan, [byId], ["vp", "dev VP"]).map(miss => miss.item.id), ["p1", "p4"], "an owner by the session id that `to` holds");
  assert.deepEqual(scopeMisses(plan, [RULE], ["01a11af8-962e-773d-a19a-ee4104011987", OPS]), [], "the target chat keeps its own work");
});

test("check-in digest: a step on another thread's work gives the scope line, again after 2 h; it is a scope item for the fan-out and its brief", () => {
  const context = { self: ["vp", "dev VP"], name: "dev VP", handoffs: [RULE] };
  const plan = board([step("p1", "Find what eats memory", "todo", { note: "swap 12 GB, load average 30" }), step("p2", "Write the docs", "doing", { job: "vp" })]);
  const first = checkInDigest(undefined, [], plan, NOW, context);
  const line = `p1 "Find what eats memory" belongs to ${OPS} (correction c7): hand it off with a message to that thread and remove it from this plan`;
  assert.ok(first.lines.includes(line), first.lines.join(" | "));
  assert.equal(first.memory.steps.p1!.scope, NOW);
  const soon = checkInDigest(first.memory, [], plan, NOW + 15 * MIN, context);
  assert.ok(!soon.lines.includes(line), "told once");
  assert.equal(soon.memory.steps.p1!.scope, NOW);
  assert.ok(checkInDigest(soon.memory, [], plan, NOW + STEP_STALE_MS, context).lines.includes(line), "again after 2 h");
  const other = checkInDigest(undefined, [], plan, NOW, { ...context, self: ["ops", OPS], name: OPS });
  assert.ok(!other.lines.some(text => text.includes("belongs to")), "not in the target chat");

  const fan = checkInDigest(undefined, [], plan, NOW, { ...context, fanOut: true });
  assert.deepEqual(fan.job?.items.map(item => `${item.id} ${item.kind}`), ["p1 scope", "p1 orphan"], "scope and orphan are two kinds: the fan-out threshold");
  assert.match(fan.job!.items[0]!.facts, /^p1 "Find what eats memory" todo, belongs to ops guy \(\+observability\) by correction c7 \(topic "load average"\); note: "swap 12 GB, load average 30"$/);
  assert.match(checkInJobMessage("[check-in] ", fan.job!, "/b.md"), /^\[check-in\] 2 items need checking: scope p1, orphan p1\./);
  assert.match(checkInJobBrief(fan.job!, { id: "vp", name: "dev VP", board: "/b.json" }), /### Scope \(the owner gave this work to another thread: hand it off and remove it from the plan\)\n- p1 "Find/);
  assert.equal(checkInDigest(undefined, [], plan, NOW, { ...context, fanOut: true, handoffs: [] }).job, undefined, "without the handoff: one kind, one item");
});

test("board classes: a step on another thread's work is a scope miss; chat health counts scope_misses and placeholder_todos per chat", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scope-health-"));
  try {
    await mkdir(join(dir, "boards"), { recursive: true });
    await writeFile(join(dir, "chats.json"), JSON.stringify({ ids: ["vp", "ops"] }));
    const store = new CorrectionLedger(dir);
    await store.apply(parseCorrectionCall({ words: "ops guy owns the Macs", rule: "Machine work goes to ops guy.", theme: "mac machine ops guy", enforcedBy: "code",
      ref: "pending commit", handoff: { to: OPS, topics: TOPICS } }), VP);
    await writeFile(join(dir, "boards", "vp.json"), JSON.stringify(board([step("p1", "Lower the Mac load", "todo"), step("p2", "Docs", "done")])));
    await writeFile(join(dir, "boards", "ops.json"), JSON.stringify(board([step("p1", "Lower the Mac load", "todo")])));
    const sessions: DaemonSession[] = [{ sessionId: "vp", sessionName: "dev VP" }, { sessionId: "ops", sessionName: OPS }];
    const chats = await boardClasses({ dataDir: dir, now: NOW, sessions: () => sessions });
    assert.deepEqual(chats.map(chat => [chat.id, chat.misses.scope_misses]), [["vp", 1], ["ops", 0]]);
    assert.deepEqual(chats[0]!.flagged.filter(slice => slice.kind === "scope_misses").map(slice => slice.excerpt),
      [`p1 "Lower the Mac load" belongs to ${OPS} (correction c1): hand it off with a message to that thread and remove it from this plan`]);

    // Chat health: closed plans (the daemon's sessions are not read); placeholder todos from the agent, open, with no choices.
    await writeFile(join(dir, "boards", "vp.json"), JSON.stringify(board([step("p2", "Docs", "done")], [todo("t3", "Read: GitHub Pro vs Team, the link lands here when ready", { at: new Date(NOW - HOUR).toISOString() }),
      todo("t4", "Read: done one, when ready", { done: true }), todo("t5", "Read: which plan?", { choices: ["Pro", "Team"] }), todo("t6", "Pick the price")])));
    await writeFile(join(dir, "boards", "ops.json"), JSON.stringify(board([], [todo("t1", "Read: my own note", { from: "owner" })])));
    const output = join(dir, "health.json");
    const result = spawnSync(process.execPath, ["--import", "tsx", join(import.meta.dirname, "..", "scripts", "duties", "chat-health.ts")], { cwd: join(import.meta.dirname, ".."),
      encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: "/nonexistent", CHAT_HEALTH_GIT_DIR: "/nonexistent", OUTPUT_FILE: output, CHAT_HEALTH_NOW: String(NOW),
        CHAT_HEALTH_DATA_DIR: dir, CHAT_HEALTH_SESSIONS_DIR: dir } });
    assert.equal(result.status, 0, result.stderr);
    const health = JSON.parse(await readFile(output, "utf8")) as PrecheckOutput;
    assert.equal(health.metrics.placeholder_todos, 1);
    assert.equal(health.metrics.article_link_not_in_todo, undefined, "c5's row is gone");
    assert.equal(health.metrics.scope_misses, 0);
    assert.deepEqual((health.flagged ?? []).filter(slice => slice.kind === "placeholder_todos"), [{ chat: "vp", at: NOW - HOUR, kind: "placeholder_todos",
      excerpt: 't3 "Read: GitHub Pro vs Team, the link lands here when ready" is a placeholder in For you: make it a plan step and send the link in a chat message when it exists' }]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
