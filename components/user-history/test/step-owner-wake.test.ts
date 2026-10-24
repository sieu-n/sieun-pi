// Guards the 10-15 incident where repo guard push land (p469) sat idle after its 13:48Z pi-pool token error: it was linked to its chat only as a
// step owner, and the chat's name came only from the hub, so the registry's roots filed under that name dropped out once the hub let go.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import { jobRegistry } from "../src/chat-sources.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import type { InterruptedRun } from "../src/shared/interrupted.ts";
import type { ChatAgent, ChatBoard, SessionRow } from "../src/shared/types.ts";
import { fakeThreads, row, source } from "./chats-helpers.ts";

const at = "2026-10-15T13:48:27Z";
const cut = (id: string, head: string): InterruptedRun =>
  ({ id: id.slice(-12), name: id, reason: "error", session_id: id, error: "from shell command: pi-pool-token exited 1", errored_at: at, head: head.slice(-12), head_session_id: head });

test("a thread linked to its chat only as the owner of an open step gets its continue after a token hook cut", async () => {
  const dir = await mkdtemp(join(tmpdir(), "step-owner-wake-"));
  try {
    const index = new IdIndex(join(dir, "chats.json"), "Chat index");
    await index.add("c1");
    const owner: ChatAgent = { key: "thread:s-owner", sessionId: "s-owner", name: "repo guard push land", job: "session:s-owner", sender: "repo guard push land",
      link: "step", state: "idle", steps: ["p469"], lastActivityAt: at };
    const board: ChatBoard = { v: 2, rev: 1, updatedAt: at, todos: [],
      plan: [{ id: "p469", text: "Land the repo guard push", status: "doing", sessionId: "s-owner", children: [] }] };
    const rows = (): SessionRow[] => [row("c1", at, { chat: true, agents: [owner] })];
    const asked: string[][] = [];
    const owners: string[][] = [];
    const paused = [cut("s-owner", "other-head"), cut("s-stranger", "other-head")];
    const chats = new Chats(index, fakeThreads([]), async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
      { ...source(dir, { c1: board }, () => Date.parse(at) + 60_000, rows),
        interrupted: async (isJob, held) => { asked.push(paused.filter(isJob).map(run => run.session_id!)); owners.push([...held]); return null; } }, () => {});
    await chats.adopt();
    await chats.tick();
    await chats.settled();
    assert.deepEqual(asked, [["s-owner"]], "the step owner is resumed, a run of another tree is not");
    assert.deepEqual(owners, [["s-owner"]]);
    chats.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// Crawler VP on 10-23: the idle unload stopped instagram posts search resumed 06:42 (01a16ab6-dbd7) at 22:01:51Z, 9 s before its pi-pool slot,
// and the resume pass logged "turn stopped: no account token from pi-pool, retries at 07:02 at 2026-10-23T22:00:36.548Z. Not resumed: no work
// is owed to it, since no open step names it", because p689 named it but had p935 open under it. It sat parked until 23:48:52Z.
test("the owner of an open step with open steps under it gets its continue after a pool wait stop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "step-owner-parent-"));
  try {
    const index = new IdIndex(join(dir, "chats.json"), "Chat index");
    await index.add("crawler-vp");
    const stopped = "2026-10-23T22:01:53Z";
    const posts = "01a16ab6-dbd7-7058-b822-2c7e27987343", census = "01a16ab7-417b-7106-be67-770a91c632a7";
    const owner: ChatAgent = { key: `thread:${posts}`, sessionId: posts, name: "instagram posts search resumed 06:42", job: `session:${posts}`,
      sender: "instagram posts search resumed 06:42", link: "root", state: "idle", steps: ["p689"], lastActivityAt: stopped };
    const board: ChatBoard = { v: 2, rev: 1, updatedAt: stopped, todos: [], plan: [{
      id: "p689", text: "Every Instagram post searchable in OpenSearch, fitting on the disk we have", status: "doing",
      job: "instagram posts search resumed 06:42", sessionId: posts, children: [
        { id: "p871", text: "Raise the Instagram posts OpenSearch backfill", status: "done", children: [] },
        { id: "p935", text: "Fix Instagram census post-history reads", status: "todo", job: "census seed order resumed 06:42", sessionId: census, children: [] }] }] };
    const rows = (): SessionRow[] => [row("crawler-vp", stopped, { chat: true, agents: [owner] })];
    const owners: string[][] = [];
    const chats = new Chats(index, fakeThreads([]), async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
      { ...source(dir, { "crawler-vp": board }, () => Date.parse(stopped) + 60_000, rows),
        interrupted: async (_isJob, named) => { owners.push([...named].sort()); return null; } }, () => {});
    await chats.adopt();
    await chats.tick();
    await chats.settled();
    assert.deepEqual(owners, [[posts, census].sort()], "p689's job is owed work while p689 is open, whatever its children read");
    chats.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a chat's links find the roots filed under its name when the hub does not hold the chat", async () => {
  const dir = await mkdtemp(join(tmpdir(), "links-name-"));
  try {
    const index = new IdIndex(join(dir, "chats.json"), "Chat index");
    await index.add("c1");
    const registry = jobRegistry(join(dir, "chat-jobs.json"));
    await registry.add(["repo guard push land"], "Crawler VP");
    await registry.add(["census writer speed"], "Crawler VP", "c1");
    const threads = fakeThreads([]);
    const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
      { ...source(dir, {}, () => Date.parse(at), () => [row("c1", at, { chat: true, agents: [] })]), registry }, () => {});
    await chats.adopt();
    assert.equal(threads.state("c1"), undefined, "the hub does not hold the chat");
    assert.deepEqual((await chats.links("c1", "Crawler VP")).roots, ["repo guard push land", "census writer speed"]);
    chats.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
