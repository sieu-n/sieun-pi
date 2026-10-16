import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { boardClasses, type DaemonSession } from "../scripts/duties/board-classes.ts";
import { fixArgs } from "../scripts/corrections-fix.ts";
import { checkInPrecheck, checkInPrecheckText } from "../src/chat-checkin.ts";
import { isHandoffTarget, matchTopic, scopeLine, scopeMisses } from "../src/checkin-findings.ts";
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
const board = (plan: PlanItem[], todos: OwnerTodo[] = []): ChatBoard => ({ v: 2, rev: 1, updatedAt: "", todos, plan });
const todo = (id: string, text: string, extra: Partial<OwnerTodo> = {}): OwnerTodo => ({ id, text, done: false, from: "agent", at: "", ...extra });

test("ledger handoff: an add and a fix carry it, the file round-trips it, a bad one is dropped alone, the prompt shows the rule, a retired entry has none", async () => {
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
  const words = ledger.corrections[1]!.words;
  const reworded = applyCorrection(ledger, parseCorrectionCall({ id: "c2", rule: "  Explanations get  an article todo. " }), VP, "");
  assert.equal(reworded.entry.rule, "Explanations get an article todo.", "an id with a new rule rewrites the rule (c58)");
  assert.equal(reworded.entry.words, words, "the owner's words stay as recorded");
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
    assert.match(ledgerPrompt(read, new Set())!, /\n- c1 Machine work goes to ops guy\.$/, "the prompt has the id and the rule sentence; handoffRules holds the topics");
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

test("scope: a topic as whole words in a step's text; not in the target chat, not when handed off, waiting on or owned by the target", () => {
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
    step("p1", "Machines on the M1 Air", "doing", { note: "the M1 Air swaps", children: [step("p2", "Check swap on the M1 Air", "todo"), step("p3", "Also launchd", "todo")] }),
    step("p4", "Usage panel: load average spikes at 14:00", "doing", { children: [] }),
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
  assert.equal(scopeLine(misses[0]!), `p1 "Machines on the M1 Air" belongs to ${OPS} (correction c7): hand it off with a message to that thread and remove it from this plan`);
  const byId = { ...RULE, to: `${OPS}, thread:01a11af8-962e-773d-a19a-ee4104011987` };
  assert.deepEqual(scopeMisses(plan, [byId], ["vp", "dev VP"]).map(miss => miss.item.id), ["p1", "p4"], "an owner by the session id that `to` holds");
  assert.deepEqual(scopeMisses(plan, [RULE], ["01a11af8-962e-773d-a19a-ee4104011987", OPS]), [], "the target chat keeps its own work");
});

test("check-in precheck: a step on another thread's work is listed with its scope line for the duty job, not in the target chat", () => {
  const context = { self: ["vp", "dev VP"], handoffs: [RULE] };
  const plan = board([step("p1", "Find what eats swap on this Mac", "todo", { note: "12 GB, load 30" }), step("p2", "Write the docs", "doing", { job: "vp" })]);
  const first = checkInPrecheck(undefined, [], plan, NOW, context);
  const line = `p1 "Find what eats swap on this Mac" belongs to ${OPS} (correction c7): hand it off with a message to that thread and remove it from this plan`;
  assert.deepEqual(first.scope.map(scopeLine), [line]);
  assert.match(checkInPrecheckText(first, [], [], NOW), new RegExp(`### Owned by another thread by an owner ruling\\n- ${line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  const other = checkInPrecheck(undefined, [], plan, NOW, { ...context, self: ["ops", OPS] });
  assert.deepEqual(other.scope, [], "not in the target chat");
  assert.deepEqual(checkInPrecheck(undefined, [], plan, NOW, { ...context, handoffs: [] }).scope, [], "without the handoff");
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

test("scope: only a step's own text names machine work; a note that names a machine as context never flags (VP of CI 10-09, Crawler VP 10-10)", () => {
  const plan = board([step("p1", "Goal", "doing", { children: [
    step("p2", "Always-on CI dashboard with charts", "doing", { note: "The ops thread's board gets CPU, memory, swap and Docker VM numbers for both Airs." }),
    step("p3", "A services test flakes under load on a busy runner", "doing"),
    step("p4", "Cut swap on this Mac", "todo"),
    step("p5", "Watch the build", "doing", { note: "Mac load average went over 60 again during the build." }),
    step("p79", "Build: staging memory caps in compose (crawler-api 12 to 16 GiB, redis 10 to 6 GiB, total unchanged)", "doing",
      { note: "Committed as 1f3a5c6c69; rides land 31. Land 31's final CI (run 38023165747) runs since 04:46Z after an M1 Air queue; staging lands about 05:45Z, then two staging memory reads." }),
    step("p8", "Free memory on the M1 Air: stop idle kernels", "todo"),
  ] })]);
  assert.deepEqual(scopeMisses(plan, [RULE], ["crawler", "Crawler VP"]).map(miss => `${miss.item.id} ${miss.topic}`), ["p4 swap", "p8 M1 Air"],
    "notes never flag (p2 swap, p5 Mac load average, p79 the M1 Air CI queue); a step whose own text is machine work still flags (p4, p8)");
});

test("scope: the M1 Air named only as where checks run is not machine work; a cleanup or restart on the Air still flags (slack green 10-13, p113 in 3 check-ins)", () => {
  const live: HandoffRule = { correction: "c7", to: OPS, topics: ["M1 Air", "M2 Air", "Mac load", "load average", "swap", "memory pressure", "alert bot"] };
  const plan = board([
    step("p113", "Owner-approved PRs merge once the M1 Air checks pass, and nothing merges without his approval of that PR", "doing", { children: [
      step("p123", "Build: make #234's CI jobs green on the M1 Air runner (loopback tests rewritten to run in-process, never skipped; jest cache dir fixed), pushed to #234's branch", "done")] }),
    step("p2", "Land #240 after its checks pass on the M2 Air", "todo"),
    step("p3", "Read the m1-air probe output for the login flow", "todo"),
    step("p101", "Clean up: delete the 7 npm debug logs on the M1 Air that hold the Vercel token in plain text, and confirm no other file on the Air holds it", "todo"),
    step("p4", "Restart the M1 Air runner after the macOS update", "todo"),
    step("p5", "Find why the M2 Air is slow", "todo"),
  ]);
  assert.deepEqual(scopeMisses(plan, [live], ["01a11b0b-7c15-73da-9481-8de15903eab4", "slack green guy"]).map(miss => `${miss.item.id} ${miss.topic}`),
    ["p101 M1 Air", "p4 M1 Air", "p5 M2 Air"], "p113, p2 and p3 name an Air as the check host; ops guy's p101 cleanup, a runner restart and a slow Air still flag");
});

test("scope: a bare resource word flags only next to a machine or what it measures; swapping data is not machine work (launch main bro 10-14, p93 in 3 check-ins)", () => {
  const live: HandoffRule = { correction: "c7", to: OPS, topics: ["M1 Air", "M2 Air", "Mac load", "load average", "swap", "memory pressure", "alert bot"] };
  const generic: HandoffRule = { correction: "c99", to: OPS, topics: ["memory", "disk", "load"] };
  const plan = board([
    step("p93", "Swap the 196 renamed Watchlist usernames to their new Instagram usernames on prod, keep the old data, and list the rest for the owner", "doing",
      { job: "removed handle swaps" }),
    step("p2", "Load the creator list into memory before the disk export", "todo"),
    step("p3", "Read swap usage after the build", "todo"),
    step("p4", "Check swap on the M2 Air after the macOS update", "todo"),
    step("p5", "Free disk space: delete the old release folders", "todo"),
    step("p6", "Cut memory use on this Mac", "todo"),
    step("p7", "Swap memory hit 12 GB during the build", "todo"),
  ]);
  assert.deepEqual(scopeMisses(plan, [live, generic], ["01a11bd7-072f-7591-ad1d-f123c276cde5", "launch main bro"]).map(miss => `${miss.item.id} ${miss.rule.correction} ${miss.topic}`),
    ["p3 c7 swap", "p4 c7 M2 Air", "p5 c99 disk", "p6 c99 memory", "p7 c7 swap"],
    "p93 swaps usernames and p2 loads data; swap usage, the M2 Air, disk space, memory on this Mac and swap memory still flag");
});

test("scope: a handoff with `with` words flags only steps that also name one of them (VP of CI 10-10, c36: a CI health check is not a local uptime check)", () => {
  const rule: HandoffRule = { correction: "c36", to: OPS, topics: ["200 check", "health check", "uptime", "local environment"],
    with: ["wiki", "5174", "Convex", "crawler API", "local environment", "frontend app", "localhost"] };
  const plan = board([step("p1", "Goal", "doing", { children: [
    step("p37", "Fix: the daily CI health check counts failed probes as a red dev branch", "doing"),
    step("p69", "Daily CI guarantees: verify-dev, land and agent-experience targets, measured every day by the existing health check", "doing"),
    step("p70", "Plan and build: the guarantee list with targets from today's numbers, computed in the daily health check, plus an article", "todo"),
    step("p80", "Uptime checks for the wiki and Convex: answer 200 every 10 min", "todo"),
  ] })]);
  assert.deepEqual(scopeMisses(plan, [rule], ["ci", "VP of CI"]).map(miss => `${miss.item.id} ${miss.topic}`), ["p80 uptime"],
    "the three CI steps name no local target; the wiki and Convex uptime step still flags");
  assert.deepEqual(scopeMisses(plan, [{ ...rule, with: undefined } as unknown as HandoffRule], ["ci", "VP of CI"]).map(miss => miss.item.id), ["p70", "p80"],
    "without `with`, a step that names CI is CI work; p70 does not name CI and its goal here does not either");
});

test("scope: a step that names CI, or sits under a goal that does, is never another thread's by a handoff whose topics do not name CI (VP of CI 10-12, c36 with no `with` words in the live ledger)", () => {
  const rule: HandoffRule = { correction: "c36", to: OPS, topics: ["200 check", "health check", "uptime", "local environment"] };
  const plan = board([
    step("p15", "This thread watches how CI is used", "doing", { children: [
      step("p37", "Fix: the daily CI health check counts failed probes as a red dev branch", "doing", { job: "disk guard rework" })] }),
    step("p60", "Standing duty: 50 agents ship code without waiting on CI, and every land rule holds", "doing", { children: [
      step("p69", "Daily CI guarantees: verify-dev, land and agent-experience targets, measured every day by the existing health check", "doing"),
      step("p70", "Plan and build: the guarantee list with targets from today's numbers, computed in the daily health check, plus an article", "doing")] }),
    step("p90", "Local dev servers stay up", "doing", { children: [step("p91", "Uptime checks for the wiki and Convex: answer 200 every 10 min", "todo")] }),
  ]);
  assert.deepEqual(scopeMisses(plan, [rule], ["ci", "VP of CI"]).map(miss => `${miss.item.id} ${miss.topic}`), ["p91 uptime"]);
  assert.deepEqual(scopeMisses(plan, [{ ...rule, topics: [...rule.topics, "CI runner"] }], ["ci", "VP of CI"]).map(miss => miss.item.id), ["p69", "p70", "p91"],
    "a handoff about CI work still takes CI steps; p37 fixes the code that counts failed probes, so it is code work");
});

test("scope: a step that changes code is its chat's own work; a hand-off topic takes it only when it runs or watches that thing (Crawler VP 10-13, c36 flagged p139)", () => {
  const c36: HandoffRule = { correction: "c36", to: OPS, topics: ["200 check", "health check", "uptime", "local environment"] };
  const c7: HandoffRule = { correction: "c7", to: OPS, topics: ["M1 Air", "M2 Air", "Mac load", "load average", "swap", "memory pressure", "alert bot"] };
  const plan = board([step("p146", "Crawler ops: deploys keep the API up, health and keys stay safe, server tools and Grafana live in the code, and every documented route works", "doing", { children: [
    step("p139", "Fix the crawler API health check stalling on slow internal queries", "blocked", { job: "api health snapshots",
      waitFor: "fb parse r5 (38378523498), snapshot reads r5 (38378533253) and 0146 r7 3f95d71305 (38379950942, mgb 38379949827) green, then land 34",
      note: "0146 r3's live verify-dev is 38353217363 (queued). fb parse r2 38352280715, snapshot reads r2 38352284840 and 0146's mgb 38352592547 are queued." }),
    step("p2", "Fix the health check handler so the crawler API answers 200 under load", "todo"),
    step("p3", "Run the 200 checks of the local wiki and the crawler API every 10 min and post a red one", "todo"),
    step("p4", "Watch the crawler API health check after land 34", "todo", { waitFor: "run 38378523498 green" }),
    step("p5", "Fix the M1 Air runner: restart it after the macOS update", "todo"),
    step("p101", "Clean up: delete the 7 npm debug logs on the M1 Air that hold the Vercel token in plain text, and confirm no other file on the Air holds it", "todo"),
    step("p6", "Find why the M2 Air is slow", "todo"),
    step("p7", "Read swap usage after the build", "todo"),
  ] })]);
  assert.deepEqual(scopeMisses(plan, [c7, c36], ["01a115e2-9544-7204-b8db-8ce4d5319048", "Crawler VP"]).map(miss => `${miss.item.id} ${miss.rule.correction} ${miss.topic}`),
    ["p3 c36 200 check", "p4 c36 health check", "p5 c7 M1 Air", "p101 c7 M1 Air", "p6 c7 M2 Air", "p7 c7 swap"],
    "p139 and p2 fix the code behind /health; running or watching the checks, the Air restart and cleanup, a slow Air and swap usage still flag");
});
