/**
 * An agent's comm thread and work thread (`comm.ts`, `agent-profile.ts`), on DurableThreads with a real kernel and the faux model:
 * 1. An `agent.ref` parses in its three shapes, and writing one sets the root's tools filter and instructions for the role in the same
 *    commit, again with no change, and never clears a value pi-host did not set.
 * 2. While the work thread runs a slow turn, a status turn of the comm thread reads it with agent_observe (status, messages, live rlm
 *    child with its progress note), and the work conversation's entries and inputs do not change; stop_work then ends the work turn.
 * 3. A task the comm thread hands the work thread with agent_message.send that settles with no reply sends the comm thread one
 *    `[work-done: no-reply ...]` input, a task the work thread reported on sends none, and a hand-over cut by a pi-host restart sends its
 *    notice once.
 * 4. A second comm thread of the agent, for a Solo room, gets the group instructions, hands the same work thread tasks, and gets the notice
 *    of its own hand-over while the DM comm thread gets none; a report the work thread sends it by the name in the task's header counts as
 *    its reply.
 */
import { strict as assert } from "node:assert";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxProvider, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { AgentDoc, ROOT_CONVERSATION_ID, type CommitPublication, type EntryRecord } from "@earendil-works/pi-durable";
import { testPython } from "@sieun-pi/pi-rlm/test-helpers";
import { AgentRoleDoc, commInstructions, parseAgentRef, STOP_WORK_TOOL, workInstructions } from "../../src/durable/agent-profile.ts";
import { HAND_TASK } from "../../src/durable/comm.ts";
import { DurableRlm } from "../../src/durable/rlm.ts";
import { DurableThreads } from "../../src/durable/threads.ts";
import { MODEL } from "./crash-scenario.ts";
import { call, cell, context, inputs, results, rlmOptions, say, textOf, until } from "./rlm-rig.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-host-comm-"));
process.env.HOME = join(dir, "home");
mkdirSync(process.env.HOME);
cpSync(join(import.meta.dirname, "../fixtures/prime-agent"), join(dir, "agent"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
process.env.PRIME_AGENT_CODING_AGENT_DIR = join(dir, "agent");
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";
const folder = join(dir, "agents", "vent");
mkdirSync(folder, { recursive: true });

let rlm: DurableRlm;
before(async () => {
  await testPython();
  rlm = await DurableRlm.load(rlmOptions(dir));
});
after(async () => {
  await rlm?.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

/** The newest user message's text and whether a tool result came after it, which is all the faux models answer from. */
function turn(messages: readonly Message[]): { text: string; answered: boolean } {
  const at = messages.findLastIndex(m => m.role === "user");
  return { text: at < 0 ? "" : textOf(messages[at]!.content as never), answered: messages.slice(at + 1).some(m => m.role === "toolResult") };
}

const ids = { work: "", comm: "", room: "" };
const ROOM_COMM = "vent · Solo relay";

const STATUS_CODE = () => `
import json
row = await agent_observe.get_agent("${ids.work}")
row = row.get("agent", row)
recent = await agent_observe.recent_messages("${ids.work}", limit=3)
listed = await agent_observe.list_agents()
lrow = [a for a in listed["agents"] if a["sessionId"] == "${ids.work}"][0]
print(json.dumps({"row": {k: row.get(k) for k in ("kind", "status", "isStreaming", "messageCount", "firstMessage", "children")}, "recent": len(recent["messages"]), "listed": [lrow.get("status"), lrow.get("messageCount")]}))
`;
const send = (text: string, to: () => string) => cell(`await agent_message.send(${JSON.stringify(text)}, receiver_role="sibling", receiver_name="${to()}")`);

function workModel(messages: Message[]): ReturnType<typeof say> {
  const { text, answered } = turn(messages);
  if (text.includes("wait a while")) return answered ? say("helper done") : cell(`await rlm.progress_note("halfway")\nimport asyncio\nawait asyncio.sleep(120)`);
  if (text.includes("long task")) return answered ? say("long task ended") : cell(`await rlm.spawn("wait a while", name="helper")\nimport asyncio\nawait asyncio.sleep(120)`);
  if (text.includes("build the slow page")) return answered ? say("slow page built") : cell("import asyncio\nawait asyncio.sleep(3)");
  if (text.includes("build the page")) return say("page built");
  if (text.includes("write the report")) return answered ? say("sent the report") : send("report: written", () => ids.comm);
  if (text.includes("write the room report")) return answered ? say("sent the room report") : send("room report: written", () => /sibling:([^\]]+)\]/.exec(text)![1]!);
  return say("ok");
}

function commModel(messages: Message[]): ReturnType<typeof say> {
  const { text, answered } = turn(messages);
  if (text === "so what is status?") return answered ? say("status read") : cell(STATUS_CODE());
  if (text === "stop it") return answered ? say("stopped") : call(STOP_WORK_TOOL, {});
  if (text === "do the slow page") return answered ? say("handed") : send("build the slow page", () => ids.work);
  if (text === "do the page") return answered ? say("handed") : send("build the page", () => ids.work);
  if (text === "do the report") return answered ? say("handed") : send("write the report", () => ids.work);
  if (text === "do the room page") return answered ? say("handed") : send("build the room page", () => ids.work);
  if (text === "do the room report") return answered ? say("handed") : send("write the room report", () => ids.work);
  return say("noted");
}

function threadsIn(name: string): DurableThreads {
  return new DurableThreads({
    dir: join(dir, name),
    models: threadId => {
      const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 0 });
      faux.setResponses(Array.from({ length: 200 }, () => ({ messages }: { messages: Message[] }) => (threadId === ids.comm || threadId === ids.room ? commModel(messages) : workModel(messages))));
      const models = createModels();
      models.setProvider(faux.provider);
      return models;
    },
    defaultModel: MODEL, defaultThinkingLevel: "off", defaultCwd: dir, rlm, primeRoots: null,
  });
}

/** A work thread and its comm thread, with both refs written. */
async function pair(threads: DurableThreads): Promise<void> {
  ids.work = (await threads.create({ name: "vent" })).id;
  ids.comm = (await threads.create({ name: "vent · DM" })).id;
  await threads.docPut(ids.work, "agent.ref", { agent: "ag_vent", dir: folder, role: "work", comm: ids.comm });
  await threads.docPut(ids.comm, "agent.ref", { agent: "ag_vent", dir: folder, role: "comm", room: "dm_vent", work: ids.work });
}

const rootEntries = async (threads: DurableThreads, id: string): Promise<EntryRecord[]> => (await threads.entries(id, { after: 0, limit: 500 })).entries;
const notices = async (threads: DurableThreads) => inputs(await rootEntries(threads, ids.comm)).filter(input => /^\[work-(done|failed)/.test(input.text));
async function ask(threads: DurableThreads, id: string, text: string): Promise<void> {
  const { submission } = await threads.submit(id, { text });
  assert.equal((await threads.wait(id, submission)).status, "done");
}
async function handsLive(threads: DurableThreads): Promise<number> {
  const open = await threads.thread(ids.comm);
  return (await open.harness.inspect(context)).tasks.filter(task => task.record.kind === HAND_TASK).length;
}

test("an agent.ref parses as work, work with comm, job or comm, and nothing else", () => {
  const dirAt = "/a/vent";
  assert.deepEqual(parseAgentRef({ agent: "ag_vent", dir: dirAt, role: "work" }), { agent: "ag_vent", dir: dirAt, role: "work" });
  assert.deepEqual(parseAgentRef({ agent: "ag_vent", dir: dirAt, role: "work", comm: "c1" }), { agent: "ag_vent", dir: dirAt, role: "work", comm: "c1" });
  assert.deepEqual(parseAgentRef({ agent: "ag_vent", dir: dirAt, role: "job", room: "dm_vent" }), { agent: "ag_vent", dir: dirAt, role: "job" });
  assert.deepEqual(parseAgentRef({ agent: "ag_vent", dir: dirAt, role: "comm", room: "dm_vent", work: "w1" }), { agent: "ag_vent", dir: dirAt, role: "comm", room: "dm_vent", work: "w1" });
  for (const bad of [
    { agent: "ag_vent", dir: dirAt, role: "work", comm: "" }, { agent: "ag_vent", dir: dirAt, role: "work", comm: 7 },
    { agent: "ag_vent", dir: dirAt, role: "comm", room: "dm_vent" }, { agent: "ag_vent", dir: dirAt, role: "comm", work: "w1" },
    { agent: "ag_vent", dir: "vent", role: "comm", room: "dm_vent", work: "w1" }, { agent: "ag_vent", dir: dirAt, role: "owner" },
  ]) assert.equal(parseAgentRef(bad), undefined, JSON.stringify(bad));
});

test("an agent.ref sets the root's tools and instructions for its role in its commit, once, and leaves a value pi-host did not set", async () => {
  const threads = threadsIn("roles");
  try {
    const thread = await threads.create({ name: "roles" });
    const open = await threads.thread(thread.id);
    const state = async () => ({ ...(await open.harness.snapshot(AgentDoc, ROOT_CONVERSATION_ID, context)) });
    const offered = async () => (await open.root.agent(context)).tools.map(tool => tool.name);
    const changes: string[] = [];
    open.harness.subscribeCommits((publication: CommitPublication) => {
      for (const change of publication.changes) if (change.type === "document" && change.conversationId === ROOT_CONVERSATION_ID) changes.push(change.record.kind);
    });
    assert.ok(!(await offered()).includes(STOP_WORK_TOOL), "a thread with no role is not offered stop_work");

    const comm = { agent: "ag_vent", dir: folder, role: "comm", room: "dm_vent", work: "w-1" } as const;
    await threads.docPut(thread.id, "agent.ref", comm);
    assert.deepEqual((({ tools, modelTools, instructions }) => ({ tools, modelTools, instructions }))(await state()), {
      tools: { remove: ["write", "edit", "bash", "subagent"] }, modelTools: { add: [STOP_WORK_TOOL] }, instructions: commInstructions(comm),
    });
    assert.deepEqual(changes.sort(), ["agent.role", "chat.doc", "pi.agent"], "the ref, the agent and pi-host's record change in one commit");
    const tools = await offered();
    for (const name of ["write", "edit", "bash", "subagent"]) assert.ok(!tools.includes(name), name);
    assert.ok(tools.includes(STOP_WORK_TOOL) && tools.includes("read"), tools.join(", "));
    assert.match(commInstructions(comm), /comm thread in room dm_vent[\s\S]*receiver_name="w-1"[\s\S]*stop_work[\s\S]*c117[\s\S]*tell_owner/);
    for (const room of ["so_1a2b3c4d", "ch_1a2b3c4d"]) {
      const group = commInstructions({ ...comm, room });
      assert.match(group, new RegExp(`comm thread in room ${room}, a group chat[\\s\\S]*header[\\s\\S]*concerns your agent[\\s\\S]*without a message[\\s\\S]*tell_owner[\\s\\S]*@<name>[\\s\\S]*why and about[\\s\\S]*receiver_name="w-1"[\\s\\S]*stop_work[\\s\\S]*c117`));
      assert.doesNotMatch(group, /You talk with the owner\./);
    }

    changes.length = 0;
    await threads.docPut(thread.id, "agent.ref", comm);
    assert.deepEqual(changes, [], "a repeated ref commits no change");

    const work = { agent: "ag_vent", dir: folder, role: "work", comm: "c-1" } as const;
    await threads.docPut(thread.id, "agent.ref", work);
    const asWork = await state();
    assert.deepEqual([asWork.tools, asWork.modelTools, asWork.instructions], [{ remove: ["tell_owner"] }, undefined, workInstructions(work)]);
    assert.match(workInstructions(work), /work thread[\s\S]*comm thread c-1[\s\S]*comm thread that handed it[\s\S]*sibling:<name>[\s\S]*receiver_name="c-1"/);

    await threads.docPut(thread.id, "agent.ref", { agent: "ag_vent", dir: folder, role: "work" });
    const plain = await state();
    assert.deepEqual([plain.tools, plain.modelTools, plain.instructions], [undefined, undefined, undefined], "a work ref with no comm clears what pi-host set");

    await open.root.configure({ instructions: "the owner's own words" }, context);
    await threads.docPut(thread.id, "agent.ref", comm);
    const kept = await state();
    assert.equal(kept.instructions, "the owner's own words", "an instruction pi-host did not write stays");
    assert.deepEqual(kept.tools, { remove: ["write", "edit", "bash", "subagent"] });
    await threads.docPut(thread.id, "agent.ref", { agent: "ag_vent", dir: folder, role: "job" });
    const job = await state();
    assert.deepEqual([job.tools, job.modelTools, job.instructions], [undefined, undefined, "the owner's own words"]);
    assert.deepEqual({ ...(await open.harness.snapshot(AgentRoleDoc, ROOT_CONVERSATION_ID, context)) }, { tools: null, modelTools: null, instructions: null });
  } finally {
    await threads.shutdown();
  }
});

test("a status turn of the comm thread reads the running work thread without changing its entries, and stop_work ends that turn", { timeout: 240_000 }, async () => {
  const threads = threadsIn("status");
  try {
    await pair(threads);
    const long = await threads.submit(ids.work, { text: "long task" });
    await until("the work thread's helper note", async () => (await threads.observe(ids.work, { open: true }))?.children.find(child => child.progressNote === "halfway"), 120_000);
    const before = await rootEntries(threads, ids.work);
    assert.equal((await threads.observe(ids.work))?.running, true);

    await ask(threads, ids.comm, "so what is status?");
    const afterStatus = await rootEntries(threads, ids.work);
    assert.equal(afterStatus.length, before.length, "the work conversation gained no entry");
    assert.deepEqual(inputs(afterStatus), inputs(before));

    const out = results(await rootEntries(threads, ids.comm)).find(result => result.name === "ipython");
    assert.ok(out && !out.isError, out?.text);
    const read = JSON.parse(out.text.trim().split("\n").at(-1)!) as { row: Record<string, unknown>; recent: number; listed: [string, number] };
    assert.equal(read.row.kind, "pi");
    assert.equal(read.row.status, "running");
    assert.equal(read.row.isStreaming, true);
    assert.equal(read.row.firstMessage, "long task");
    assert.ok((read.row.messageCount as number) >= 2, JSON.stringify(read.row));
    const [child, ...more] = read.row.children as { id: string }[];
    assert.deepEqual(more, []);
    assert.match(child!.id, new RegExp(`^${ids.work}:\\d+$`));
    assert.deepEqual({ ...child, id: "" }, { id: "", name: "helper", status: "running", progressNote: "halfway" });
    assert.ok(read.recent >= 2);
    assert.deepEqual(read.listed, ["running", read.row.messageCount], "the listing reads the open work thread too");

    await ask(threads, ids.comm, "stop it");
    const stopped = results(await rootEntries(threads, ids.comm)).find(result => result.name === STOP_WORK_TOOL);
    assert.equal(stopped?.text, `Stopped the work thread ${ids.work}.`);
    assert.equal((await threads.wait(ids.work, long.submission)).status, "unanswered");
    assert.equal((await threads.observe(ids.work))?.running, false);
    assert.equal((await notices(threads)).length, 0, "an input the owner sent the work thread sends no notice");
  } finally {
    await threads.shutdown();
  }
});

test("a handed task that settles with no reply sends the comm thread one work-done notice, and one the work thread reported on sends none", { timeout: 240_000 }, async () => {
  const threads = threadsIn("notice");
  try {
    await pair(threads);
    await ask(threads, ids.comm, "do the page");
    const [notice] = await until("the work-done notice", async () => {
      const found = await notices(threads);
      return found.length ? found : undefined;
    });
    assert.equal(notice!.text, "[work-done: no-reply agent:vent]\n\nLast assistant text: page built");
    assert.deepEqual(notice!.data, { from: ids.work, via: "work.done" });
    const handed = inputs(await rootEntries(threads, ids.work)).find(input => input.text.endsWith("build the page"));
    assert.deepEqual(handed?.data, { from: ids.comm, via: "agent_message" });
    await until("the hand-over to end", async () => (await handsLive(threads)) === 0);

    await ask(threads, ids.comm, "do the report");
    await until("the work thread's report", async () => inputs(await rootEntries(threads, ids.comm)).find(input => input.text.endsWith("report: written") && input.data?.from === ids.work));
    await until("the second hand-over to end", async () => (await handsLive(threads)) === 0);
    const settled = await threads.thread(ids.comm);
    await settled.harness.waitForIdle(context);
    assert.equal((await notices(threads)).length, 1, "the reported task sends no notice");
  } finally {
    await threads.shutdown();
  }
});

test("a hand-over that a pi-host restart cuts sends its notice once after the restart", { timeout: 240_000 }, async () => {
  let threads = threadsIn("restart");
  try {
    await pair(threads);
    await ask(threads, ids.comm, "do the slow page");
    await until("the work thread's slow cell", async () => (await rootEntries(threads, ids.work)).some(entry => (entry.model?.[0] as Message | undefined)?.role === "assistant"));
    assert.equal(await handsLive(threads), 1);
    await threads.shutdown();

    threads = threadsIn("restart");
    const reopened = await threads.start();
    assert.ok(reopened.includes(ids.comm), "the comm thread with a live hand-over reopens on start");
    const [notice] = await until("the notice after the restart", async () => {
      const found = await notices(threads);
      return found.length ? found : undefined;
    }, 120_000);
    assert.match(notice!.text, /^\[work-done: no-reply agent:vent\]\n\nLast assistant text: slow page built$/);
    await until("the hand-over to end", async () => (await handsLive(threads)) === 0);
    assert.equal((await notices(threads)).length, 1);
  } finally {
    await threads.shutdown();
  }
});

test("a Solo room's comm thread hands the same work thread tasks, gets its own notice, and counts a report sent by its header name", { timeout: 240_000 }, async () => {
  const threads = threadsIn("room");
  try {
    await pair(threads);
    ids.room = (await threads.create({ name: ROOM_COMM })).id;
    const roomRef = { agent: "ag_vent", dir: folder, role: "comm", room: "so_1a2b3c4d", work: ids.work } as const;
    await threads.docPut(ids.room, "agent.ref", roomRef);
    const open = await threads.thread(ids.room);
    assert.equal((await open.harness.snapshot(AgentDoc, ROOT_CONVERSATION_ID, context))?.instructions, commInstructions(roomRef));
    const roomNotices = async () => inputs(await rootEntries(threads, ids.room)).filter(input => /^\[work-(done|failed)/.test(input.text));
    const roomHands = async () => (await open.harness.inspect(context)).tasks.filter(task => task.record.kind === HAND_TASK).length;

    await ask(threads, ids.room, "do the room page");
    const [notice] = await until("the room's work-done notice", async () => {
      const found = await roomNotices();
      return found.length ? found : undefined;
    });
    assert.equal(notice!.text, "[work-done: no-reply agent:vent]\n\nLast assistant text: ok");
    const handed = inputs(await rootEntries(threads, ids.work)).find(input => input.text.endsWith("build the room page"));
    assert.equal(handed?.text, `[agent-message from sibling:${ROOM_COMM}]\n\nbuild the room page`);
    assert.deepEqual(handed?.data, { from: ids.room, via: "agent_message" });
    await until("the room hand-over to end", async () => (await roomHands()) === 0);

    await ask(threads, ids.room, "do the room report");
    await until("the work thread's room report", async () => inputs(await rootEntries(threads, ids.room)).find(input => input.text.endsWith("room report: written") && input.data?.from === ids.work));
    await until("the second room hand-over to end", async () => (await roomHands()) === 0);
    await open.harness.waitForIdle(context);
    assert.equal((await roomNotices()).length, 1, "the reported task sends no notice");
    assert.equal((await notices(threads)).length, 0, "the DM comm thread hears nothing of the room's tasks");
  } finally {
    await threads.shutdown();
  }
});
