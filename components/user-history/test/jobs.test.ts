import assert from "node:assert/strict";
import { test } from "node:test";
import { briefFor, briefFromCode, findJob, jobName, jobNames, jobStatusText, jobViews, parentChatOf, reportsFor, spawnCalls, treeJobs, updatesJob } from "../src/client/jobs.ts";
import type { ChatLine } from "../src/shared/chat-feed.ts";
import type { ChildAgent, SessionRow, ThreadMessage } from "../src/shared/types.ts";

const child = (id: string, sessionName: string, status: ChildAgent["status"] = "running"): ChildAgent => ({ id, sessionName, label: "brief first line", status });

test("jobName drops the agent-message role prefix", () => {
  assert.equal(jobName("child:ux-email"), "ux-email");
  assert.equal(jobName("sibling:seo-todo"), "seo-todo");
  assert.equal(jobName("readme-lines"), "readme-lines");
});

test("jobViews lists active jobs first and finds a job by name, key or session id", () => {
  const jobs = jobViews([child("sub-1", "ux-monitor", "done"), child("sub-2", "ux-email")], [{ sessionId: "01a1-root", name: "seo-todo" }],
    [{ sessionId: "01a1-two", rlmChildId: "sub-2" }], () => undefined);
  assert.deepEqual(jobs.map(job => job.name), ["ux-email", "ux-monitor", "seo-todo"]);
  assert.equal(jobs[0]?.sessionId, "01a1-two");
  assert.equal(jobs[1]?.sessionId, null);
  assert.equal(findJob(jobs, "child:ux-monitor")?.key, "child:sub-1");
  assert.equal(findJob(jobs, "child:sub-1")?.name, "ux-monitor");
  assert.equal(findJob(jobs, "session:01a1-root")?.name, "seo-todo");
  assert.equal(findJob(jobs, "01a1-two")?.name, "ux-email");
  assert.equal(findJob(jobs, "nobody"), undefined);
});

test("reportsFor returns the job's messages newest first, from the chat's lines", () => {
  const lines: ChatLine[] = [
    { kind: "job", id: "m1", from: "ux-email", title: "first", body: "first", at: 1 },
    { kind: "job", id: "m2", from: "ux-monitor", title: "other", body: "other", at: 2 },
    { kind: "notes", id: "m3", text: "passing it on", at: 3 },
    { kind: "job", id: "m4", from: "ux-email", title: "second", body: "second", at: 4 },
    { kind: "agent", id: "m5", text: "ok", at: 5 },
  ];
  assert.deepEqual(reportsFor(lines, "child:ux-email").map(item => item.id), ["m4", "m1"]);
  assert.deepEqual(reportsFor(lines, "nobody"), []);
});

test("briefFromCode reads the first argument of the spawn call that names the job", () => {
  const code = [
    'common = """',
    'Repo: /x. Follow AGENTS.md.',
    '"""',
    'monitor = await rlm.spawn("Surface: Monitor.\\n" + common, name="ux-monitor")',
    "email = await rlm.spawn('Surface: Email, with a \"quote\" and name=\"not-this\".' + common, name='ux-email', model=\"m\")",
    'print(monitor, email)',
  ].join("\n");
  assert.equal(briefFromCode(code, "ux-monitor"), "Surface: Monitor.\n\nRepo: /x. Follow AGENTS.md.\n");
  assert.equal(briefFromCode(code, "ux-email"), 'Surface: Email, with a "quote" and name="not-this".\nRepo: /x. Follow AGENTS.md.\n');
  assert.equal(briefFromCode(code, "nobody"), null);
  assert.equal(briefFromCode('h = await rlm("do it", name="w", thinking="max")', "w"), "do it");
  assert.equal(briefFromCode('h = await rlm.create_session(brief=f"go {x}", name="w", cwd="/r")', "w"), "go {x}");
  assert.equal(briefFromCode('brief = persona + "\\n\\n## Task\\n" + task\nh = await rlm.spawn(brief, name="w")', "w"), "\n\n## Task\n");
  assert.equal(briefFromCode('h = await rlm.spawn(make_brief(), name="w")', "w"), null);
  assert.equal(briefFromCode('h = await rlm.spawn("unfinished', "w"), null);
});

test("briefFor takes the last naming call across the chat's ipython tool calls", () => {
  const call = (code: string): ThreadMessage => ({ role: "assistant", content: [{ type: "toolCall", id: "c", name: "ipython", arguments: { code } }], provider: "p", model: "m", stopReason: "toolUse", timestamp: 1 });
  const messages: ThreadMessage[] = [
    { role: "user", content: "go", timestamp: 0 },
    call('h = await rlm.spawn("first brief", name="w")'),
    call('print(await rlm.list_subagents())'),
    call('h = await rlm.spawn("second brief", name="w")'),
  ];
  assert.equal(briefFor(messages, "w"), "second brief");
  assert.equal(briefFor(messages, "other"), null);
});

test("treeJobs and parentChatOf read a chat's agents from its row; jobNames adds the sessions its transcript started", () => {
  const row = (over: Partial<SessionRow>): SessionRow => ({ id: "r", name: "row", cwd: "/r", kind: "live", status: "idle", archived: false, messageCount: 1, working: false, subagentsRunning: 0, unread: false, tags: [], priority: 0, progress: "none", ...over });
  const chat = row({ id: "chat", name: "ux", chat: true, agents: [
    { key: "child:sub-2", sessionId: "s2", childId: "sub-2", name: "ux-monitor", job: "ux-monitor", sender: "ux-monitor", link: "subagent", state: "working", activity: "Reading routes", lastActivityAt: "2026-10-08T09:00:00.000Z", steps: ["p2"] },
    { key: "thread:01a1-root", sessionId: "01a1-root", name: "seo todo", job: "session:01a1-root", sender: "seo-todo", link: "root", state: "working", activity: "queued", steps: [] },
    { key: "thread:01a1-main", sessionId: "01a1-main", name: "main stripe clerk", job: "session:01a1-main", sender: "main stripe clerk", link: "step", state: "waiting", activity: "May I push?", steps: ["p3"] },
    { key: "child:sub-1", sessionId: "s1", childId: "sub-1", name: "ux-email", job: "ux-email", sender: "ux-email", link: "subagent", state: "done", steps: [] },
  ] });
  const created = row({ id: "01a1-root", name: "seo-todo", working: true, statusLabel: "queued", origin: "agent" });
  const messages: ThreadMessage[] = [{ role: "toolResult", toolCallId: "t", toolName: "ipython", content: [{ type: "text", text: "RLMCreateSessionHandle(active_session_id='a', session_id='01a1-root', name='seo-todo', session_file=PosixPath('/x'))" }], isError: false, timestamp: 1 }];
  const rows = [chat, created];
  const rowOf = (id: string) => rows.find(entry => entry.id === id);
  const tree = treeJobs(chat);
  assert.deepEqual(tree.map(job => [job.key, job.running, job.waiting, job.saved, job.activity, job.open, job.report]), [
    ["child:sub-2", true, false, false, "Reading routes", "ux-monitor", "ux-monitor"],
    ["thread:01a1-root", true, false, false, "queued", "session:01a1-root", "seo-todo"],
    ["thread:01a1-main", false, true, false, "May I push?", "session:01a1-main", "main stripe clerk"],
    ["child:sub-1", false, false, true, "", "ux-email", "ux-email"],
  ]);
  assert.deepEqual(tree.map(job => job.at), [Date.parse("2026-10-08T09:00:00.000Z"), 0, 0, 0]);
  assert.deepEqual(treeJobs(row({ chat: true })), []);
  const messagesOf = (id: string) => id === "chat" ? messages : undefined;
  assert.deepEqual(parentChatOf("s1", rows, messagesOf), { chat, open: "ux-email" });
  assert.deepEqual(parentChatOf("01a1-root", rows, messagesOf), { chat, open: "session:01a1-root" });
  assert.equal(parentChatOf("01a1-main", rows, messagesOf), null, "a step owner is no job of the chat");
  assert.equal(parentChatOf("nobody", rows, messagesOf), null);
  assert.deepEqual(jobNames(chat, { children: [child("c1", "ux-monitor"), child("c2", "ux-review")], messages }, rowOf), ["ux-monitor", "seo todo", "main stripe clerk", "ux-email", "seo-todo", "ux-review"], "the row's agents, the started sessions by catalog name, then the daemon's children, once each");
  assert.deepEqual(jobNames(undefined, { children: [], messages }, rowOf), ["seo-todo"], "no row yet: the started sessions by their catalog name");
  assert.deepEqual(jobNames(undefined, null, rowOf), []);
  assert.deepEqual(tree.map(jobStatusText), ["Reading routes", "queued", "Waiting for the chat", "Finished"]);
  assert.equal(jobStatusText({ ...tree[0]!, activity: "" }), "Running");
  assert.equal(jobStatusText({ ...tree[3]!, saved: false }), "Idle");
  assert.equal(jobStatusText({ ...tree[3]!, failed: true }), "Failed");
});

test("updatesJob previews the sender of the last job message in a folded run", () => {
  const job = (from: string, at: number): ChatLine => ({ kind: "job", id: "m" + at, from, title: "t", body: "b", at });
  const notes: ChatLine = { kind: "notes", id: "n", text: "note", at: 3 };
  assert.equal(updatesJob({ kind: "updates", id: "u", at: 1, entries: [job("ux-email", 1), job("ux-monitor", 2), notes] as never }), "ux-monitor");
  assert.equal(updatesJob({ kind: "updates", id: "u", at: 3, entries: [notes] as never }), null);
});

test("spawnCalls keeps every truncated cell, since the call may sit past the head", () => {
  const call = (id: string, code: string, truncated?: true): ThreadMessage => ({ role: "assistant", content: [{ type: "toolCall", id, name: "ipython", arguments: { code }, ...(truncated ? { truncated } : {}) }], provider: "p", model: "m", stopReason: "toolUse", timestamp: 1 });
  const calls = spawnCalls([call("a", "print(1)"), call("b", 'common = """long brief', true), call("c", 'h = await rlm.spawn("x", name="w")')]);
  assert.deepEqual(calls.map(entry => [entry.toolCallId, entry.truncated]), [["b", true], ["c", false]]);
});
