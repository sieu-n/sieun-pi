import assert from "node:assert/strict";
import { appendFile, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { jobRegistry } from "../src/chat-sources.ts";
import { CHAT_BRIEF, extensionBuild, jobOf, jobPersonaGuideline, jobReplyGuideline, loadRecord, reloadAction } from "../src/chat-brief.ts";
import { Chats } from "../src/chats.ts";
import { createSessionNames, jobNameLiterals, topSession } from "../src/chat-guard.ts";
import { IdIndex } from "../src/id-index.ts";
import type { ChatAgent, SessionRow } from "../src/shared/types.ts";
import { MERGE_RULE_SHORT } from "../src/shared/chat-board.ts";
import { source, fakeThreads, row, reply } from "./chats-helpers.ts";

/** The board skill and its references, which the brief points to for the rules of one kind of action. */
const boardSkill = async (file: string): Promise<string> => readFile(new URL(`../../../skills/board/${file}`, import.meta.url), "utf8");
const SKILL_FILES = ["SKILL.md", "references/jobs.md", "references/check-ins.md", "references/git.md", "references/owner.md", "references/corrections.md"];

test("brief: the core rules stay in the prompt in one short line each, and the brief points to every board skill file", async () => {
  const brief = CHAT_BRIEF.join("\n");
  assert.equal(CHAT_BRIEF[1], "Mark a step done or a feature live only from the real state you checked (a feature on the real screen), and say what you checked.",
    "live means seen, the item after the first");
  assert.ok(CHAT_BRIEF.includes("Name every job and thread like the owner names threads: a few plain lowercase words naming the topic (stripe and payments), with no " +
    "kebab-case, ids or numbered suffixes like -2."), "the naming line, verbatim");
  assert.match(brief, /Your one goal is to drive every board item to done\. Every open step names its owner \(a job, or a thread as `thread:<id>`\) and its next action, or is blocked with the exact thing that unblocks it\. A step waiting on someone else is still yours: chase a stuck owner once, then replace it with a job\./);
  assert.match(brief, /Reach the owner only through tell_owner, on every kind of turn, within the \[reply cap\]\./);
  assert.match(brief, /On a wake-up the owner did not start, call it once when a goal finished, something is blocked or you need a decision, with several updates in one call; never write 'nothing needs you', 'already handled' or a relay line\./);
  assert.match(brief, /A brief, in English, opens with `Owner's words \(verbatim\):` and the 1 or 2 owner messages that started it, numbered, timed and exact \(or `Owner's words: none, started by <who>`\), then `My read:`, a `Split:` line/);
  assert.match(brief, /End state: every open step is done, moved by a live owner \(a job at work, or a thread active in the last 2 h\), or blocked only by an open For you todo\./);
  assert.match(brief, /Never ask the owner to relay a message to another thread\./);
  assert.match(brief, /Delete heartbeats and watcher loops the check-in already covers\./);
  assert.match(brief, /anthropic\/claude-opus-5-5", thinking=\\?"high\\?"\)`, the model of this chat and every job unless the owner says otherwise \(c31\)/);
  assert.match(brief, /Act directly and ship; invent no waiting rules, review rounds or safety gates unless the owner asks for caution \(c47\)\./);
  assert.match(brief, /Nothing goes outside \(an email, a ticket or support reply, a customer message, a post\) until the owner approves the draft on a For you todo \(c37\)\./);
  assert.match(brief, /record it with `correction_add` in the same turn\./);
  assert.doesNotMatch(brief, /—/, "no em dashes");
  assert.ok(!/board convergence/i.test(brief), "no separate Board convergence duty: the check-in owns board convergence (correction c15)");
  for (const file of SKILL_FILES) {
    assert.ok(brief.includes(file === "SKILL.md" ? "SKILL.md before a board write" : file), `the brief points to ${file}`);
    assert.ok((await boardSkill(file)).length > 0, file);
  }
});

test("brief: every rule that left the prompt sits in the board skill file the brief points to, once", async () => {
  const brief = CHAT_BRIEF.join("\n");
  const homes: [string, string, string][] = [
    ["SKILL.md", "Every goal gets its phases as child steps from the start: Plan (research or design), Decide (only when the owner must choose), Build and Verify.", "board shape"],
    ["SKILL.md", "including blocked steps nobody works on yet", "blocked steps show"],
    ["SKILL.md", "Link a job on the step it does, not on the goal.", "jobs on steps"],
    ["SKILL.md", "Plan (doing, job messenger-bridge-research), Decide (blocked), Build (blocked), Verify (todo)", "the board shape example"],
    ["SKILL.md", "A goal that is a feature of one app goes under that app's goal as a child, not as a new top-level goal.", "app features nest"],
    ["SKILL.md", "act on it in that turn: record the job's result, do the next action, or close it done or dropped", "plan upkeep (c44)"],
    ["SKILL.md", "fold the goal in the same turn (c46)", "fold a goal (c46)"],
    ["SKILL.md", "remove it with plan_remove and add one scratch note naming its new owner", "hand-off (c8)"],
    ["SKILL.md", "does not stay open (c45)", "a goal that only waits closes (c45)"],
    ["SKILL.md", "Send a job only its own plan item, never the whole board.", "a job gets its own item"],
    ["SKILL.md", "no all-caps labels (SECURITY:, URGENT:), no slash-joined names, and no repo jargon (origin/main, xoxb, HEAD)", "plain board notes"],
    ["SKILL.md", "A go said in chat does not count", "the go gate"],
    ["SKILL.md", "Push the step that closes the largest gap, because waiting steps are not progress (c23).", "goal targets drive the check-in"],
    ["references/jobs.md", "cut only with \"...\" between exact pieces", "brief quotes"],
    ["references/jobs.md", "`receiver_role=\"sibling\", receiver_name=<your session name>`", "root reply line"],
    ["references/jobs.md", "translate any Korean (c2)", "relays in English"],
    ["references/jobs.md", "never one context writing 10 articles", "one subagent per output"],
    ["references/jobs.md", "Work of 1 to 3 tool calls stays inline", "inline small work"],
    ["references/jobs.md", "never start a \"-2\" or \"finish\" copy of it", "steer a live job"],
    ["references/jobs.md", "`[job] <name> ended at <time> with no report` or `[job] <name> stopped ... and sent no report` means", "silent job ends"],
    ["references/jobs.md", "`[job] <name> is waiting for you since <time>` means the job waits on you", "waiting jobs"],
    ["references/jobs.md", "delete the job with `await rlm.delete_subagent(name)` unless a step keeps it waiting on purpose", "delete finished jobs"],
    ["references/jobs.md", "`node apps/llm-wiki/scripts/prose-lint.mjs <page>` pass", "wiki pages (c20)"],
    ["references/check-ins.md", "named like `check-in 14:00`, with the precheck as context", "duty jobs"],
    ["references/check-ins.md", "like \"Chat system\" or \"Skills and harness\"", "duty names"],
    ["references/check-ins.md", "the server refuses size metrics (c39)", "duty metrics"],
    ["references/git.md", "rebase, amend) before a push needs no owner ask (c21)", "unpushed sieun-pi commits"],
    ["references/git.md", "run `git add -- <your files>` on the shared index afterwards", "private index commits"],
    ["references/owner.md", "ask yourself whether the CTO would be annoyed to be asked", "few asks"],
    ["references/owner.md", "one screenshot per variant inline in the chat message itself", "UI picks inline (c3)"],
    ["references/owner.md", "complete the Google or GitHub sign-in there", "logins through Aside (c4)"],
    ["references/owner.md", "`gh auth login --web`, a GitHub web sign-in, a device code or browser flow) is yours or the job's to start and finish (c4)", "GitHub sign-ins are the agent's too (c4, owner 10-14)"],
    ["references/owner.md", "If the owner says talk first, reply with your proposal and the default you start at your next wake-up", "talk first"],
    ["references/owner.md", "like [secrets walkthrough](job:secrets walkthrough)", "job links"],
    ["references/owner.md", "mermaid diagrams", "images and diagrams"],
    ["references/corrections.md", "receiver_role=\"sibling\", receiver_name=\"realtime layer\"", "corrections change the brief"],
    ["references/corrections.md", "await refine.run()", "corrections change a skill"],
    ["references/corrections.md", "pass `handoff: {to, topics, with?}`", "correction handoff"],
    ["references/jobs.md", "sends `[brief check]` when one breaks these rules; fix it in the job with a message", "brief check"],
    ["SKILL.md", "Give 2 to 4 short choices, your recommendation first.", "todo choices"],
  ];
  const texts = new Map(await Promise.all(SKILL_FILES.map(async file => [file, await boardSkill(file)] as const)));
  for (const [file, phrase, why] of homes) {
    assert.ok(texts.get(file)!.includes(phrase), `${why}: in ${file}`);
    assert.ok(!brief.includes(phrase), `${why}: not repeated in the brief`);
    assert.deepEqual(SKILL_FILES.filter(other => texts.get(other)!.includes(phrase)), [file], `${why}: in one file`);
  }
});

test("job reply: a direct subagent of a chat and a root the chat started get the guideline; nothing else does", async () => {
  assert.deepEqual(jobOf({ depth: 1, marked: false, parentChat: "chat-ab12" }), { chat: "chat-ab12", root: false });
  assert.deepEqual(jobOf({ depth: 1, marked: false, parentChat: "" }), { chat: "", root: false }, "a chat with no name still gets the guideline");
  assert.equal(jobOf({ depth: 1, marked: false, parentChat: null }), null, "the parent is a plain thread");
  assert.equal(jobOf({ depth: 2, marked: false, parentChat: "chat-ab12" }), null, "a job's own subagent reports to the job");
  assert.deepEqual(jobOf({ depth: 0, marked: false, registered: "Feature X" }), { chat: "Feature X", root: true });
  assert.equal(jobOf({ depth: 0, marked: true, registered: "Feature X" }), null, "a chat is never a job");
  assert.equal(jobOf({ depth: 0, marked: false, registered: undefined }), null);
  assert.equal(jobReplyGuideline({ chat: "chat-ab12", root: false }), 'You are a job of the chat chat-ab12. When you finish, fail or get blocked, send your report ' +
    `first with \`await agent_message.send(report, receiver_role="parent")\`, and lead it with the answer. ${MERGE_RULE_SHORT} No cap, throttle, timeout, rate or caution line without a measurement, a vendor limit or an incident cited next to the number; remove unbacked ones.`);
  assert.ok(CHAT_BRIEF.join(" ").includes("Base limits (c43)"), "the brief names c43; tell_owner, the board and agent messages refuse an unbacked limit in code, and a job gets the full line above");
  assert.match(jobReplyGuideline({ chat: "Feature X", root: true }), /receiver_role="sibling", receiver_name="Feature X"/);
  assert.match(jobReplyGuideline({ chat: "", root: false }), /^You are a job of the chat\. /);

  assert.deepEqual(createSessionNames('await rlm.create_session(brief, name="api-audit", cwd="/repo")'), ["api-audit"]);
  assert.deepEqual(createSessionNames("h = await rlm.create_session(f'Owner said {x}', cwd=c, name='w2')\nawait rlm.create_session(b, name=n)"), ["w2"], "a computed name is not found");
  assert.deepEqual(createSessionNames("brief = 'call rlm.create_session(b, name=\"x\")'\nawait rlm.spawn(brief, name='y')"), [], "a call inside a string and a spawn are not roots");
  assert.deepEqual(createSessionNames('await rlm.create_session(b, cwd=c, name=f"job-{n}")'), [], "an f-string with a field is computed");
  assert.deepEqual(createSessionNames('await rlm.create_session(b + "receiver_name=\'z\'", name="ok")'), ["ok"]);

  const dir = await mkdtemp(join(tmpdir(), "jobs-"));
  let now = 1_000;
  const registry = jobRegistry(join(dir, "chat-jobs.json"), () => now);
  await registry.add(["old"], "chat-a");
  now += 31 * 24 * 60 * 60_000;
  await registry.add(["api-audit"], "chat-b");
  assert.equal(await registry.chatOf("api-audit"), "chat-b");
  assert.equal(await registry.chatOf("old"), undefined, "entries older than 30 days go on the next add");
  assert.equal(await registry.chatOf("nobody"), undefined);
  await registry.add(["seo daily"], "chat-b");
  assert.deepEqual(await registry.rootsOf(["01a1-b", "chat-b"]), ["api-audit", "seo daily"], "the roots a chat started, by any of its names");
  assert.deepEqual(await registry.rootsOf(["chat-a"]), []);
  assert.deepEqual(jobNameLiterals("h = await rlm(b, name='readme check')\nawait rlm.spawn(b, name=\"x-y\")\nawait rlm.create_session(b, name='r', cwd=c)"),
    [{ call: "rlm", name: "readme check" }, { call: "rlm.spawn", name: "x-y" }, { call: "rlm.create_session", name: "r" }]);

  const lines = (entries: object[]) => entries.map(entry => JSON.stringify(entry)).join("\n") + "\n";
  const chatFile = join(dir, "chat.jsonl");
  const plainFile = join(dir, "plain.jsonl");
  await writeFile(chatFile, lines([{ type: "session", id: "c" }, { type: "session_info", id: "i", name: "chat-ab12" }, { type: "session_state", id: "s" },
    { type: "custom", customType: "chat_mode", data: { v: 1 } }, { type: "session_info", id: "j", name: "renamed later" }]));
  await writeFile(plainFile, lines([{ type: "session", id: "p" }, { type: "session_info", id: "i", name: "plain" }]));
  assert.deepEqual(await topSession(chatFile), { id: "c", name: "chat-ab12", chat: true });
  assert.deepEqual(await topSession(plainFile), { id: "p", name: "plain", chat: false });
  assert.equal(await topSession(join(dir, "missing.jsonl")), null);
  const jobFile = join(dir, "job.jsonl");
  const helperFile = join(dir, "helper.jsonl");
  await writeFile(jobFile, lines([{ type: "session", id: "j", parentSession: chatFile, rlmDepth: 1 }, { type: "session_info", id: "i", name: "job" }]));
  await writeFile(helperFile, lines([{ type: "session", id: "h", parentSession: jobFile, rlmDepth: 2 }]));
  assert.deepEqual(await topSession(helperFile), { id: "c", name: "chat-ab12", chat: true }, "a job's own subagent finds the chat at the top");
  await writeFile(join(dir, "orphan.jsonl"), lines([{ type: "session", id: "o", parentSession: join(dir, "missing.jsonl") }]));
  assert.equal(await topSession(join(dir, "orphan.jsonl")), null);
});

test("stale extension: the decision, and the reload once a chat attaches (now when idle, at the end of its turn when busy; never twice for one build)", async () => {
  assert.equal(reloadAction(undefined, "b2", false), "reload", "no record: the chat may run any build");
  assert.equal(reloadAction("b1", "b2", false), "reload");
  assert.equal(reloadAction("b1", "b2", true), "wait");
  assert.equal(reloadAction("b2", "b2", false), null);
  assert.equal(reloadAction("b2", "b2", true), null);
  const build = extensionBuild();
  assert.match(build, /^[0-9a-f]{16}$/);
  assert.equal(extensionBuild(), build, "the same sources hash the same");
  const tree = await mkdtemp(join(tmpdir(), "build-"));
  const src = join(tree, "components", "user-history", "src");
  await cp(join(import.meta.dirname, "..", "src"), src, { recursive: true });
  await cp(join(import.meta.dirname, "..", "extension"), join(tree, "components", "user-history", "extension"), { recursive: true });
  await cp(join(import.meta.dirname, "..", "..", "global-rules"), join(tree, "components", "global-rules"), { recursive: true });
  let before = extensionBuild(src);
  // The context hook (correction-delivery, prime-notices, context-images, the reply cap's reply-lint notes and turns text), the board tool's schema
  // (chat-board, types) and global-rules, which runs in every session.
  for (const file of ["correction-delivery.ts", "prime-notices.ts", "context-images.ts", "shared/reply-lint.ts", "shared/turns.ts", "shared/types.ts", "shared/chat-board.ts",
    "../../global-rules/index.ts"]) {
    await appendFile(join(src, file), "\n");
    const after = extensionBuild(src);
    assert.notEqual(after, before, `${file} shapes a session's requests, so a change to it reloads the chat and its jobs`);
    before = after;
  }
  await rm(tree, { recursive: true, force: true });

  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  for (const id of ["old", "busy", "fresh", "plain"]) if (id !== "plain") await index.add(id);
  const loads = loadRecord(join(dir, "extension-loads.json"));
  await loads.set("fresh", "b2");
  await loads.set("busy", "b1");
  const calls: string[] = [];
  const threads = fakeThreads(calls);
  threads.busyIds.add("busy");
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b2", loads, source(dir));
  await chats.adopt();
  calls.length = 0;
  for (const id of ["old", "busy", "fresh", "plain"]) threads.fire().live(id, []);
  await chats.settled();
  assert.deepEqual(calls.filter(call => call.startsWith("reload")), ["reload old"], "no record reloads; a matching record, a busy chat and a plain thread do not");
  assert.equal(await loads.get("old"), "b2");
  assert.equal(await loads.get("busy"), "b1", "still waiting for the turn to end");
  calls.length = 0;
  threads.fire().idle("fresh");
  threads.fire().idle("plain");
  await chats.settled();
  assert.equal(calls.length, 0, "a turn ending in a chat that is not waiting does nothing");
  threads.busyIds.delete("busy");
  threads.fire().idle("busy");
  await chats.settled();
  assert.deepEqual(calls, ["reload busy"]);
  assert.equal(await loads.get("busy"), "b2");
  calls.length = 0;
  threads.fire().live("old", []);
  threads.fire().live("busy", []);
  await chats.settled();
  assert.deepEqual(calls.filter(call => call.startsWith("reload")), [], "a plain restart with the same build reloads nothing");
  await chats.forget("old");
  assert.equal(await loads.get("old"), undefined, "a forgotten chat drops its record");
  chats.close();
});

test("stale extension in a job: a job of a chat that runs an older build than the one on disk is reloaded once it runs nothing, one job at a time, never twice for one build", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  const loads = loadRecord(join(dir, "extension-loads.json"));
  await loads.set("old", "b1");
  await loads.set("current", "b2");
  await loads.set("kernel", "b1");
  await loads.set("working", "b1");
  const threads = fakeThreads([]);
  threads.sessionBusy.add("kernel");
  const agent = (sessionId: string, link: ChatAgent["link"], state: ChatAgent["state"] = "idle"): ChatAgent =>
    ({ key: `thread:${sessionId}`, sessionId, name: sessionId, job: sessionId, sender: sessionId, link, state, lastActivityAt: new Date(0).toISOString(), steps: [] });
  let agents: ChatAgent[] = [agent("old", "subagent"), agent("unknown", "root"), agent("current", "subagent"), agent("kernel", "subagent"),
    agent("working", "subagent", "working"), agent("t3", "step")];
  const rows = (): SessionRow[] => [row("c1", new Date(0).toISOString(), { chat: true, agents })];
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b2", loads, { ...source(dir, {}, () => 0, rows), tickMs: 0 });
  await chats.adopt();
  await chats.tick();
  await chats.settled();
  assert.deepEqual(threads.reloaded, ["old", "unknown"],
    "a job on an older build, or one already running at the first look, keeps stale prompt-shaping code unless it is reloaded; a step owner is no job");
  assert.equal(await loads.get("old"), "b2");
  assert.equal(await loads.get("unknown"), "b2");
  assert.equal(await loads.get("kernel"), "b1", "background work in its kernel: the reload waits, a reload would drop it");
  assert.equal(await loads.get("working"), "b1", "a working job is not reloaded mid-turn");

  threads.reloaded.length = 0;
  threads.sessionBusy.delete("kernel");
  agents = [...agents.filter(item => item.sessionId !== "working"), agent("working", "subagent"), agent("fresh", "subagent")];
  await chats.tick();
  await chats.settled();
  assert.deepEqual(threads.reloaded, ["kernel", "working"], "each reloads once it runs nothing; the ones done before are not reloaded again");
  assert.equal(await loads.get("fresh"), "b2", "a job that shows up after the first look started on this build: recorded, not reloaded");

  threads.reloaded.length = 0;
  await chats.tick();
  await chats.settled();
  assert.deepEqual(threads.reloaded, [], "the same build reloads nothing");
  chats.close();
});

test("jobs of a chat work in poteto-mode when the skill is installed, and get nothing extra when it is not", () => {
  const skill = "/home/x/.prime/agent/skills/poteto-mode/SKILL.md";
  const line = jobPersonaGuideline(skill, path => path === skill);
  assert.equal(line, `Work in poteto-mode: read ${skill} before your first step.`);
  assert.equal(jobPersonaGuideline(skill, () => false), null, "no skill installed: no persona line");
});

test("a job that ended its task is not reloaded at a service start, so its Python kernel is not rebuilt, and is reloaded once it is idle on new work", async () => {
  // 10-14 07:12Z to 07:15Z: 70 kernels (4.3 GB) started within 60 s of their job's "extension reloaded" line, 13 of them in finished jobs.
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  const loads = loadRecord(join(dir, "extension-loads.json"));
  for (const id of ["finished", "asks", "root"]) await loads.set(id, "b1");
  const threads = fakeThreads([]);
  const agent = (sessionId: string, link: ChatAgent["link"], state: ChatAgent["state"]): ChatAgent =>
    ({ key: `thread:${sessionId}`, sessionId, name: sessionId, job: sessionId, sender: sessionId, link, state, lastActivityAt: new Date(0).toISOString(), steps: [] });
  let agents: ChatAgent[] = [agent("finished", "subagent", "done"), agent("asks", "subagent", "waiting"), agent("root", "root", "idle")];
  const rows = (): SessionRow[] => [row("c1", new Date(0).toISOString(), { chat: true, agents })];
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b2", loads, { ...source(dir, {}, () => 0, rows), tickMs: 0 });
  await chats.adopt();
  await chats.tick();
  await chats.settled();
  assert.deepEqual(threads.reloaded, ["asks", "root"], "a job the chat still owes an answer and an idle root are reloaded; a finished job is not");
  assert.equal(await loads.get("finished"), "b1", "its record keeps the build it runs");
  agents = [agent("finished", "subagent", "working"), ...agents.slice(1)];
  await chats.tick();
  await chats.settled();
  assert.deepEqual(threads.reloaded, ["asks", "root"], "not mid-turn");
  agents = [agent("finished", "subagent", "waiting"), ...agents.slice(1)];
  await chats.tick();
  await chats.settled();
  assert.deepEqual(threads.reloaded, ["asks", "root", "finished"], "given new work, it is reloaded once it runs nothing and has not ended");
  chats.close();
});
