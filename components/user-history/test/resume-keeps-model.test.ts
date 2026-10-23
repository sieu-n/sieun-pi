// Guards chat-2572 on us-metal02, 10-22 and 10-23. The chat spawned "mcp metadata access", "mcp claude check" and "mcp chatgpt login" on
// openai-codex/gpt-6-astra at thinking high (each rlm-subagent.json has "model": {"provider": "openai-codex", "modelId": "gpt-6-astra"}). The
// cleanup ended each while its step waited and started "... resumed 00:11" (01a1642b), "... resumed 00:37" (01a16443) and "... resumed 02:10"
// (01a16497) with no model, so each started on the daemon default anthropic/claude-opus-5-5 and stopped on the Claude limit. The chat then
// gave p10, p8 and p5 to new workers, and the resume pass still continued the three old roots each time pi-pool admitted them.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseBriefRecord, recordModel } from "../src/brief-keeper.ts";
import { loadRecord } from "../src/chat-brief.ts";
import { dutyJobHost } from "../src/chat-duty-job.ts";
import { PARK_IDLE_MS } from "../src/chat-checkin.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import { jobResumes, savedStatePath, type JobResume } from "../src/job-resume.ts";
import type { InterruptedRun } from "../src/shared/interrupted.ts";
import type { BoardOp, ChatAgent, ChatBoard, ChildAgent, SessionRow, ThreadMessage } from "../src/shared/types.ts";
import { fakeThreads, row, source } from "./chats-helpers.ts";

const CHILD = "sub-ddcaca04";

test("a job the cleanup ends while its step waits is resumed on the model and thinking level it was started with", async () => {
  const dir = await mkdtemp(join(tmpdir(), "resume-keeps-model-"));
  try {
    let now = Date.parse("2026-10-22T14:00:00Z");
    const threads = fakeThreads([]);
    const index = new IdIndex(join(dir, "chats.json"), "Chat index");
    await index.add("c1");
    const childDir = join(dir, "session-artifacts", "c1", CHILD);
    const childFile = join(childDir, "01a1636c-d150-717b-be2b-a7a4ed76bbaf.jsonl");
    await mkdir(childDir, { recursive: true });
    await writeFile(join(childDir, "rlm-subagent.json"), JSON.stringify({ type: "rlm_subagent", childId: CHILD, sessionName: "mcp metadata access",
      sessionFile: childFile, prompt: "Finish the Vent caller-table change.", model: { provider: "openai-codex", modelId: "gpt-6-astra" }, createdAt: now - 3_600_000 }));
    await writeFile(childFile, [
      { type: "session", version: 3, id: "01a1636c-d150-717b-be2b-a7a4ed76bbaf", timestamp: "2026-10-22T11:43:58.288Z", cwd: dir, rlmDepth: 1 },
      { type: "model_change", id: "9293b28b", parentId: null, timestamp: "2026-10-22T11:43:58.423Z", provider: "openai-codex", modelId: "gpt-6-astra" },
      { type: "thinking_level_change", id: "33f58ffe", parentId: "9293b28b", timestamp: "2026-10-22T11:43:58.423Z", thinkingLevel: "xhigh" },
    ].map(line => JSON.stringify(line)).join("\n") + "\n");
    let board: ChatBoard = { v: 2, rev: 1, updatedAt: "", todos: [], plan: [
      { id: "p10", text: "Hosted metadata check", status: "blocked", job: "mcp metadata access", waitFor: "Vent deployment by the release owner in p6", children: [] }] };
    // The fresh job starts through the duty job host the backend wires to `resumes.restart`, so the create the daemon gets is the one checked.
    const created: { name: string; provider?: string; modelId?: string; thinkingLevel?: string }[] = [];
    const host = dutyJobHost({
      threads: { create: async input => { created.push(input); return { id: "01a1642b-31c8-77bd-a92f-14555cbe837f" }; }, prompt: async () => {} },
      archives: { add: async () => {} }, rows: async () => [],
      registry: { add: async () => {}, chatOf: async () => undefined, chatIdOf: async () => undefined, rootsOf: async () => [], remove: async () => {} },
      board: id => join(dir, "boards", `${id}.json`) });
    const chats = new Chats(index, threads, async () => ({ lifecycle: "live", sessionFile: join(dir, "sessions", "c1.jsonl") }), "b1",
      loadRecord(join(dir, "extension-loads.json")), {
        ...source(dir, {}, () => now), board: async () => board, waking: async () => false, wakes: async () => [],
        resumes: { store: jobResumes(join(dir, "job-resumes")),
          restart: (_chat, name, brief, model) => host.start({ id: "c1", name: "chat-2572", cwd: dir, board: "" }, name, brief("chat-2572"), undefined, model),
          applyBoard: async (_id: string, ops: readonly BoardOp[]) => {
            board = { ...board, plan: board.plan.map(item => {
              const op = ops.find(each => each.op === "plan_update" && each.id === item.id);
              return op && op.op === "plan_update" ? { ...item, ...op.job ? { job: op.job } : {}, ...op.sessionId ? { sessionId: op.sessionId } : {}, ...typeof op.note === "string" ? { note: op.note } : {} } : item;
            }) };
          } },
      }, () => {});
    await chats.adopt();
    const job: ChildAgent = { id: CHILD, label: "mcp metadata access", sessionName: "mcp metadata access", sessionId: "01a1636c-d150-717b-be2b-a7a4ed76bbaf",
      status: "done", repliedSinceTask: true, lastActivityAt: now };
    threads.transcripts.set("c1", [{ role: "custom", customType: "agent_message", display: true, timestamp: now,
      content: "[agent-message from child:mcp metadata access]\nReady for the deployed revision; p10 waits on the Vent deploy." } as ThreadMessage]);
    await chats.roster(new Map([["c1", [job]]]));
    threads.fire().live("c1", [job]);
    await chats.settled();
    now += PARK_IDLE_MS + 6 * 60_000;
    await chats.tick();
    await chats.settled();
    chats.close();
    assert.equal(created.length, 1, "one fresh job starts for p10");
    assert.match(created[0]!.name, /^mcp metadata access resumed \d\d:\d\d$/);
    assert.deepEqual({ provider: created[0]!.provider, modelId: created[0]!.modelId, thinkingLevel: created[0]!.thinkingLevel },
      { provider: "openai-codex", modelId: "gpt-6-astra", thinkingLevel: "xhigh" }, "the fresh job runs on the model and thinking the ended job was started with");
    const saved = JSON.parse(await readFile(savedStatePath(board.plan[0]!)!, "utf8")) as JobResume;
    assert.deepEqual(saved.model, { provider: "openai-codex", modelId: "gpt-6-astra", thinkingLevel: "xhigh" }, "the saved state records them");
    assert.deepEqual(saved.resumed, { id: "01a1642b-31c8-77bd-a92f-14555cbe837f", name: created[0]!.name }, "and the fresh job it started");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

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

test("a saved state file of another shape is left out, so the replaced-root sweep neither throws nor stops the service", async () => {
  const dir = await mkdtemp(join(tmpdir(), "replaced-root-odd-"));
  try {
    const index = new IdIndex(join(dir, "chats.json"), "Chat index");
    await index.add("c1");
    const store = jobResumes(join(dir, "job-resumes"));
    await mkdir(join(dir, "job-resumes", "c1"), { recursive: true });
    // us-metal02 10-23: Crawler VP's job-resumes/<chat>/checkin-0410-pending-jobs.json, a chat's own list of jobs to start, has this shape,
    // and the first sweep of fbd5a0a0 threw "Cannot read properties of undefined (reading 'includes')" on it and stopped the service.
    await writeFile(join(dir, "job-resumes", "c1", "checkin-0410-pending-jobs.json"), JSON.stringify({
      "check-in stuck root cause": { cwd: "/Users/sieunpark/Documents/Github/sieun-pi", brief: "# check-in stuck root cause: make the check-in's stuck_steps converge in code" },
      "crawler duty fixes": { cwd: "/Users/sieunpark/Documents/Github/sieun-pi", brief: "# crawler duty fixes" },
      "release follow through": { cwd: "/Users/sieunpark/Documents/Github/sieun-pi", brief: "# release follow through" } }, null, 1));
    await writeFile(join(dir, "job-resumes", "c1", "half.json"), JSON.stringify({ chat: "c1", childId: "sub-2", job: "census connect race", endedAt: 1 }));
    await store.save({ chat: "c1", childId: "sub-1", job: "mcp metadata access", steps: ["p10"], event: "p10 waits", brief: "b", report: "r",
      endedAt: Date.parse(at) - 3_600_000, resumed: { id: "s-old", name: "mcp metadata access resumed 00:11" } });
    assert.deepEqual((await store.list("c1")).map(entry => entry.resume.childId), ["sub-1"]);
    const board: ChatBoard = { v: 2, rev: 1, updatedAt: at, todos: [], plan: [
      { id: "p10", text: "Hosted metadata check", status: "todo", job: "hosted metadata check", sessionId: "s-new", children: [] }] };
    const rows = (): SessionRow[] => [row("c1", at, { chat: true, agents: [agent("s-old", "mcp metadata access resumed 00:11", "root"),
      agent("s-new", "hosted metadata check", "subagent", ["p10"])] })];
    const threads = fakeThreads([]);
    const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), {
      ...source(dir, { c1: board }, () => Date.parse(at) + 60_000, rows), resumes: { store, applyBoard: async () => {} },
      interrupted: async () => null }, () => {});
    await chats.adopt();
    await chats.tick();
    await chats.settled();
    chats.close();
    assert.deepEqual([...threads.archivedBy], [["s-old", "replaced_job_end"]]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
