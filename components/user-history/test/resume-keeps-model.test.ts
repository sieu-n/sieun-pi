// Guards chat-2572 on us-metal02, 10-22 and 10-23. The chat spawned "mcp metadata access", "mcp claude check" and "mcp chatgpt login" on
// openai-codex/gpt-6-astra at thinking high (each rlm-subagent.json has "model": {"provider": "openai-codex", "modelId": "gpt-6-astra"}). The
// cleanup ended each while its step waited and started "... resumed 00:11" (01a1642b), "... resumed 00:37" (01a16443) and "... resumed 02:10"
// (01a16497) with no model, so each started on the daemon default anthropic/claude-opus-5-5 and stopped on the Claude limit. The chat then
// gave p10, p8 and p5 to new workers, and the resume pass still continued the three old roots each time pi-pool admitted them. Since 10-26
// the cleanup ends no waiting job (waiting-job-same-session.test.ts), and these tests keep the roots such saved states started in line.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseBriefRecord, recordModel } from "../src/brief-keeper.ts";
import { loadRecord } from "../src/chat-brief.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import { jobResumes, type JobResume } from "../src/job-resume.ts";
import type { InterruptedRun } from "../src/shared/interrupted.ts";
import type { ChatAgent, ChatBoard, SessionRow } from "../src/shared/types.ts";
import { fakeThreads, row, source } from "./chats-helpers.ts";

test("a root the brief keeper starts in place of a lost child runs on the model and thinking its spawn named", () => {
  const record = parseBriefRecord({ kind: "child", id: "sub-5c92e43f", name: "mcp chatgpt login", prompt: "Log in.", at: 1, root: "01a162bc-47b4-770b-a9fc-19c3a742e730",
    model: "openai-codex/gpt-6-astra", thinking: "high" });
  assert.deepEqual(recordModel(record!), { provider: "openai-codex", modelId: "gpt-6-astra", thinkingLevel: "high" });
  assert.equal(recordModel(parseBriefRecord({ kind: "child", id: "sub-1", prompt: "x", at: 1, root: "r1" })!), undefined, "a spawn with no model keeps the default");
});

const at = "2026-10-23T00:47:37Z";
const cut = (id: string): InterruptedRun =>
  ({ id: id.slice(-12), name: id, reason: "error", session_id: id, error: "429 rate_limit_error", errored_at: at, head: id.slice(-12), head_session_id: id });
const agent = (sessionId: string, name: string, link: ChatAgent["link"], steps: string[] = []): ChatAgent =>
  ({ key: `thread:${sessionId}`, sessionId, name, job: `session:${sessionId}`, sender: name, link, state: link === "root" ? "failed" : "idle", steps, lastActivityAt: at });

test("a resumed root whose step the chat gave to another worker is archived instead of resumed, and one whose step still names it is resumed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "replaced-root-"));
  try {
    const index = new IdIndex(join(dir, "chats.json"), "Chat index");
    await index.add("c1");
    const store = jobResumes(join(dir, "job-resumes"));
    const saved = (childId: string, job: string, step: string, id: string, name: string): JobResume =>
      ({ chat: "c1", childId, job, steps: [step], event: `${step} waits`, brief: "b", report: "r", endedAt: Date.parse(at) - 3_600_000, resumed: { id, name } });
    await store.save(saved("sub-ddcaca04", "mcp metadata access", "p10", "s-old", "mcp metadata access resumed 00:11"));
    await store.save(saved("sub-de30a216", "mcp claude check", "p8", "s-kept", "mcp claude check resumed 00:37"));
    await store.save(saved("sub-5c92e43f", "mcp chatgpt login", "p5", "s-tree", "mcp chatgpt login resumed 02:10"));
    const board: ChatBoard = { v: 2, rev: 1, updatedAt: at, todos: [], plan: [
      { id: "p10", text: "Hosted metadata check", status: "todo", job: "hosted metadata check", sessionId: "s-new", children: [] },
      { id: "p8", text: "Claude connection check", status: "doing", job: "mcp claude check resumed 00:37", sessionId: "s-kept", children: [] },
      // A step the resumed root handed to its own subagent: that worker is no worker of the chat, so the root keeps its tree.
      { id: "p5", text: "Staging sign in check", status: "todo", job: "login probe", sessionId: "s-below", children: [] }] };
    const rows = (): SessionRow[] => [row("c1", at, { chat: true, agents: [
      agent("s-old", "mcp metadata access resumed 00:11", "root"), agent("s-kept", "mcp claude check resumed 00:37", "root", ["p8"]),
      agent("s-tree", "mcp chatgpt login resumed 02:10", "root"), agent("s-new", "hosted metadata check", "subagent", ["p10"]),
      agent("s-below", "login probe", "step", ["p5"])] })];
    const threads = fakeThreads([]);
    const lines: string[] = [];
    const asked: string[][] = [];
    const paused = [cut("s-old"), cut("s-kept"), cut("s-tree")];
    const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), {
      ...source(dir, { c1: board }, () => Date.parse(at) + 60_000, rows), resumes: { store, applyBoard: async () => {} },
      interrupted: async isJob => { asked.push(paused.filter(isJob).map(run => run.session_id!)); return null; } }, line => lines.push(line));
    await chats.adopt();
    await chats.tick();
    await chats.settled();
    chats.close();
    assert.deepEqual([...threads.archivedBy], [["s-old", "replaced_job_end"]], "only the replaced root is archived, as the service's own archive");
    assert.deepEqual(asked, [["s-kept", "s-tree"]], "the resume pass never continues the replaced root");
    assert.ok(lines.some(line => line.includes("archived replaced root mcp metadata access resumed 00:11 instead of resuming it: p10 now name hosted metadata check")), lines.join("\n"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("old saved state shapes never archive a worker: only a state that names its fresh job, whose steps all moved off it, retires that job", async () => {
  const dir = await mkdtemp(join(tmpdir(), "replaced-root-old-"));
  try {
    const index = new IdIndex(join(dir, "chats.json"), "Chat index");
    await index.add("c1");
    const store = jobResumes(join(dir, "job-resumes"));
    const folder = join(dir, "job-resumes", "c1");
    await mkdir(folder, { recursive: true });
    const endedAt = Date.parse(at) - 3_600_000;
    // us-metal02 10-23: Crawler VP's job-resumes/<chat>/checkin-0410-pending-jobs.json, a chat's own list of jobs to start, has this shape,
    // and the first sweep of fbd5a0a0 threw "Cannot read properties of undefined (reading 'includes')" on it and stopped the service 4 times.
    await writeFile(join(folder, "checkin-0410-pending-jobs.json"), JSON.stringify({
      "check-in stuck root cause": { cwd: "/Users/sieunpark/Documents/Github/sieun-pi", brief: "# check-in stuck root cause: make the check-in's stuck_steps converge in code" },
      "crawler duty fixes": { cwd: "/Users/sieunpark/Documents/Github/sieun-pi", brief: "# crawler duty fixes" },
      "release follow through": { cwd: "/Users/sieunpark/Documents/Github/sieun-pi", brief: "# release follow through" } }, null, 1));
    await writeFile(join(folder, "no-steps.json"), JSON.stringify({ chat: "c1", childId: "sub-2", job: "census connect race", endedAt, brief: "b", report: "r" }));
    await writeFile(join(folder, "not-json.json"), "{\"chat\": \"c1\", ");
    // The 669 states saved before fbd5a0a0 have this shape: no model and no resumed. "ci reads resumed 00:07" still runs as a root of the
    // chat while p336 names another worker, and it stays, since nothing in the file says the cleanup started it.
    await writeFile(join(folder, "sub-66bee306.json"), JSON.stringify({ chat: "c1", childId: "sub-66bee306", job: "ci reads", steps: ["p336"],
      event: "p336 waits for promote 19", brief: "Read the CI runs.", report: "Waiting on promote 19.", endedAt: Date.parse("2026-10-21T15:07:00Z") }, null, 1));
    const save = (childId: string, job: string, step: string, id: string, name: string) =>
      store.save({ chat: "c1", childId, job, steps: [step], event: `${step} waits`, brief: "b", report: "r", endedAt, resumed: { id, name } });
    await save("sub-1", "mcp metadata access", "p10", "s-old", "mcp metadata access resumed 00:11");
    // A step that still holds the resumed root by its session id, under another job name, keeps it.
    await save("sub-3", "mcp claude check", "p8", "s-held", "mcp claude check resumed 00:37");
    assert.deepEqual((await store.list("c1")).map(entry => entry.resume.childId).sort(), ["sub-1", "sub-3", "sub-66bee306"], "files of other shapes are left out");
    const board: ChatBoard = { v: 2, rev: 1, updatedAt: at, todos: [], plan: [
      { id: "p10", text: "Hosted metadata check", status: "todo", job: "hosted metadata check", sessionId: "s-new", children: [] },
      { id: "p8", text: "Claude connection check", status: "doing", job: "claude connection check", sessionId: "s-held", children: [] },
      { id: "p336", text: "Land verify rows", status: "doing", job: "alert triage CI and RepoOps 07:12", sessionId: "s-triage", children: [] },
      { id: "p900", text: "Census race", status: "doing", job: "census connect race resumed 03:51", sessionId: "s-census", children: [] }] };
    const rows = (): SessionRow[] => [row("c1", at, { chat: true, agents: [agent("s-old", "mcp metadata access resumed 00:11", "root"),
      agent("s-held", "mcp claude check resumed 00:37", "root", ["p8"]), agent("s-ci", "ci reads resumed 00:07", "root"),
      agent("s-census", "census connect race resumed 03:51", "root", ["p900"]),
      agent("s-new", "hosted metadata check", "subagent", ["p10"]), agent("s-triage", "alert triage CI and RepoOps 07:12", "root", ["p336"])] })];
    const threads = fakeThreads([]);
    const lines: string[] = [];
    const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), {
      ...source(dir, { c1: board }, () => Date.parse(at) + 60_000, rows), resumes: { store, applyBoard: async () => {} },
      interrupted: async () => null }, line => lines.push(line));
    await chats.adopt();
    await chats.tick();
    await chats.settled();
    chats.close();
    const named = new Set(board.plan.flatMap(step => step.sessionId ? [step.sessionId] : []));
    assert.deepEqual([...threads.archivedBy.keys()].filter(id => named.has(id)), [], "no worker a board step names is archived, by an old file or a new one");
    assert.ok(!threads.archivedBy.has("s-ci"), "a root an old file without resumed matches by name is never counted as replaced");
    assert.deepEqual([...threads.archivedBy], [["s-old", "replaced_job_end"]], "only the root its saved state names, whose step moved, is archived");
    assert.ok(!lines.some(line => /TypeError|replaced roots:/.test(line)), lines.join("\n"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
