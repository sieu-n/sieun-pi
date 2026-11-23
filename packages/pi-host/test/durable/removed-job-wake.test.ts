/**
 * A removed job takes no scheduled input, and a job run that ends tells readers of the thread row:
 * 1. `rlm.delete_subagent` cancels the job's heartbeats in pi-host's scheduler and its board.wakes in apps/chat.
 * 2. A wake that still reaches a removed or missing job conversation is dropped with one log line, and no run starts.
 * 3. A job run that ends moves the thread row's `updatedAt`, so apps/chat reads its kept tree again.
 * 4. A job that finished, and was not removed, still wakes on a wake it set.
 * On 11-20 a board.wake reached the removed job 28350de8:73, which ran 10 min with no parent to report to, and when that run ended the row
 * kept its `updatedAt`, so apps/chat showed the job working for 89 h.
 */
import { strict as assert } from "node:assert";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxProvider, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { testPython } from "@sieun-pi/pi-rlm/test-helpers";
import { DurableRlm } from "../../src/durable/rlm.ts";
import { DurableThreads } from "../../src/durable/threads.ts";
import { MODEL } from "./crash-scenario.ts";
import { cell, firstUser, inputs, lastText, rlmOptions, say, until } from "./rlm-rig.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-host-removed-job-wake-"));
process.env.HOME = join(dir, "home");
mkdirSync(process.env.HOME);
cpSync(join(import.meta.dirname, "../fixtures/prime-agent"), join(dir, "agent"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
process.env.PRIME_AGENT_CODING_AGENT_DIR = join(dir, "agent");
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";
process.env.PI_HOST_WAKE_POLL_MS = "100";

/** The wakes the fake chat keeps, as apps/chat's wake files, until the test sends one or pi-host drops them. */
const wakes: { thread: string; conversation: number; note: string }[] = [];
/** Every wake a child set. */
const armed: typeof wakes = [];
/** The conversations whose wakes the fake chat lists as pending; any other child ends once its run ends. */
const held = new Set<string>();
/** Each `DELETE /api/threads/:id/wakes` pi-host sent, as `<thread>:<conversation>`. */
const dropped: string[] = [];
/** The sessions whose heartbeats pi-host cancelled, and the sessions that hold a live heartbeat. */
const cancelled: string[] = [];
const heartbeats = new Set<string>();
const logs: string[] = [];
let chat: Server;
let rlm: DurableRlm;
before(async () => {
  await testPython();
  chat = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://chat");
    const thread = decodeURIComponent(url.pathname.split("/")[3] ?? "");
    let body = "";
    request.on("data", chunk => (body += chunk));
    request.on("end", () => {
      const conversation = Number(url.searchParams.get("conversation"));
      if (request.method === "POST") {
        const input = JSON.parse(body) as { conversation: number; note: string };
        const wake = { thread, conversation: input.conversation, note: input.note };
        wakes.push(wake);
        armed.push(wake);
        response.end(JSON.stringify({ path: "wakes/x.json" }));
      } else if (request.method === "DELETE") {
        dropped.push(`${thread}:${conversation}`);
        const mine = wakes.filter(w => w.thread === thread && w.conversation === conversation);
        for (const wake of mine) wakes.splice(wakes.indexOf(wake), 1);
        response.end(JSON.stringify({ dropped: mine.length }));
      } else {
        const pending = held.has(`${thread}:${conversation}`) ? wakes.filter(w => w.thread === thread && w.conversation === conversation) : [];
        response.end(JSON.stringify({ wakes: pending }));
      }
    });
  });
  await new Promise<void>(resolve => chat.listen(0, "127.0.0.1", resolve));
  rlm = await DurableRlm.load({
    ...rlmOptions(dir), chatUrl: `http://127.0.0.1:${(chat.address() as AddressInfo).port}`, log: line => logs.push(line),
    scheduler: () => ({ cancelSession: (session: string) => (cancelled.push(session), heartbeats.delete(session) ? [{} as never] : []) }),
  });
});
after(async () => {
  await rlm?.shutdown();
  chat?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The child's cell that arms a wake the way board.wake does in a pi thread. */
const ARM = `import os, json, urllib.request
body = json.dumps({"conversation": int(os.environ["PI_HOST_CONVERSATION"]), "on": {"kind": "time", "at": 0}, "note": "look again"}).encode()
urllib.request.urlopen(urllib.request.Request(os.environ["PI_HOST_CHAT_URL"] + "/api/threads/" + os.environ["PI_HOST_THREAD"] + "/wakes", data=body, headers={"Content-Type": "application/json"}))
print("Wake set")`;

function model(messages: Message[]): ReturnType<typeof say> {
  const first = firstUser(messages);
  const last = lastText(messages);
  if (first.startsWith("[task from parent]")) {
    if (last.startsWith("[task from parent]")) return cell(ARM);
    if (last.includes("Wake set")) return say("waiting for the wake");
    if (last.startsWith("[wake]")) return say("woke");
    return say(`child unexpected: ${last.slice(0, 120)}`);
  }
  if (last === "spawn doomed") return cell(`a = await rlm.spawn("arm a wake and wait", name="doomed")\nprint("spawned", a.name)`);
  if (last === "spawn finisher") return cell(`b = await rlm.spawn("arm a wake and end", name="finisher")\nprint("spawned", b.name)`);
  if (last.includes("spawned ")) return say("spawned");
  if (last === "delete doomed") return cell(`await rlm.delete_subagent("doomed")\nprint("deleted it")`);
  if (last.includes("deleted it")) return say("deleted");
  if (last.startsWith("[child-exited")) return say("exit seen");
  return say(`unexpected: ${last.slice(0, 120)}`);
}

const wakeInput = (conversation: number) => ({
  conversation, text: "[wake] It is now. Your note: look again", whenBusy: "followUp" as const, requestId: `wake:test:${conversation}:${Date.now()}`,
  entry: { kind: "agent.message" as const, data: { from: "board", via: "wake" } },
});

/** Runs `body` on a new thread on the faux model, with the helpers each test uses, and shuts the thread list down after it. */
async function withThread(name: string, body: (t: {
  threads: DurableThreads; id: string; entriesOf: (conversation: number) => Promise<readonly EntryRecord[]>; ask: (text: string) => Promise<void>;
}) => Promise<void>): Promise<void> {
  const threads = new DurableThreads({
    dir: join(dir, name),
    models: () => {
      const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 0 });
      faux.setResponses(Array.from({ length: 200 }, () => ({ messages }: { messages: Message[] }) => model(messages)));
      const models = createModels();
      models.setProvider(faux.provider);
      return models;
    },
    defaultModel: MODEL, defaultThinkingLevel: "off", defaultCwd: dir, rlm, primeRoots: null, log: line => logs.push(line),
  });
  try {
    const { id } = await threads.create({ name });
    const entriesOf = async (conversation: number) => (await threads.entries(id, { conversation, after: 0, limit: 500 })).entries;
    const ask = async (text: string) => assert.equal((await threads.wait(id, (await threads.submit(id, { text })).submission)).status, "done");
    await body({ threads, id, entriesOf, ask });
  } finally {
    await threads.shutdown();
  }
}

/** Spawns the job "doomed", which sets a wake the chat lists as pending, gives it a heartbeat, and removes it; returns its conversation. */
async function removeDoomed(id: string, ask: (text: string) => Promise<void>): Promise<number> {
  await ask("spawn doomed");
  const doomed = (await until("doomed's wake", async () => armed.find(w => w.thread === id))).conversation;
  held.add(`${id}:${doomed}`);
  heartbeats.add(`${id}-${doomed}`);
  await ask("delete doomed");
  return doomed;
}

test("removing a job cancels its heartbeats and the wakes the chat keeps for it", { timeout: 120_000 }, async () => {
  await withThread("remove", async ({ id, ask }) => {
    const doomed = await removeDoomed(id, ask);
    await until("doomed's wakes dropped at the chat", async () => dropped.includes(`${id}:${doomed}`), 10_000);
    assert.ok(cancelled.includes(`${id}-${doomed}`) && !heartbeats.has(`${id}-${doomed}`), `heartbeats cancelled: ${JSON.stringify(cancelled)}`);
    assert.deepEqual(wakes.filter(w => w.thread === id), []);
    assert.ok(logs.includes(`rlm: ${id}:${doomed} removed: cancelled 1 heartbeats and 1 wakes`), logs.join("\n"));
  });
});

test("a wake that reaches a removed or missing job is dropped with one log line and starts no run", { timeout: 120_000 }, async () => {
  await withThread("late wake", async ({ threads, id, entriesOf, ask }) => {
    const doomed = await removeDoomed(id, ask);
    await new Promise(resolve => setTimeout(resolve, 500));
    const before = (await entriesOf(doomed)).length;
    const lines = logs.length;
    await assert.rejects(threads.submit(id, wakeInput(doomed)), { name: "InputDropped", message: `${id}:${doomed} was removed` });
    await assert.rejects(threads.submit(id, wakeInput(999)), { name: "InputDropped", message: `${id}:999 does not exist` });
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal((await entriesOf(doomed)).length, before, "the removed job ran no turn");
    assert.equal((await threads.tree(id)).find(node => node.id === doomed)?.status, "idle");
    assert.deepEqual(logs.slice(lines).filter(line => line.includes(id)).map(line => line.replace(/ wake:test:[^,]+/, "")), [
      `durable: ${id}:${doomed} was removed: dropped its wake, no run`,
      `durable: ${id}:999 does not exist: dropped its wake, no run`,
    ]);
  });
});

test("a job that finished, and was not removed, wakes on its wake, and the end of that run moves the thread row", { timeout: 120_000 }, async () => {
  await withThread("finished", async ({ threads, id, entriesOf, ask }) => {
    await ask("spawn finisher");
    const finisher = (await until("finisher's wake", async () => armed.find(w => w.thread === id))).conversation;
    await until("the finisher's exit notice", async () => inputs(await entriesOf(1)).some(i => i.text.startsWith("[child-exited: no-reply child:finisher]")));
    await until("the thread at rest", async () => threads.info(id).status !== "running" && (await threads.tree(id)).every(node => node.status === "idle"));
    await threads.submit(id, wakeInput(finisher));
    const started = threads.info(id).updatedAt;
    await until("the finisher's wake run", async () => (await entriesOf(finisher)).some(entry => JSON.stringify(entry).includes('"woke"')));
    await until("the thread at rest after the wake", async () => threads.info(id).status !== "running");
    assert.equal((await threads.tree(id)).find(node => node.id === finisher)?.status, "idle");
    assert.ok(threads.info(id).updatedAt > started, `the row moved when the job's run ended: ${threads.info(id).updatedAt} > ${started}`);
  });
});
