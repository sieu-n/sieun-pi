/**
 * A child that sets a `board.wake` and ends its turn is not done: Prime's chat wakes it later with a `[wake]` agent message, and its parent
 * hears from it after that run. pi-host's `rlm.deliver` task holds such a child while apps/chat still lists its wake:
 * 1. A child that replies from its wake run reaches the parent with its reply and no `[child-exited ...]`.
 * 2. A child that stays silent is reported once, after its wake run, with that run's last text.
 * On 11-19 two jobs of a d2 duty session set wakes, ended their turns and sat until the duty session messaged them.
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
import { testPython } from "@sieun-pi/pi-rlm/test-helpers";
import { DurableRlm } from "../../src/durable/rlm.ts";
import { DurableThreads } from "../../src/durable/threads.ts";
import { MODEL } from "./crash-scenario.ts";
import { cell, firstUser, inputs, lastText, rlmOptions, say, until } from "./rlm-rig.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-host-child-wake-"));
process.env.HOME = join(dir, "home");
mkdirSync(process.env.HOME);
cpSync(join(import.meta.dirname, "../fixtures/prime-agent"), join(dir, "agent"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
process.env.PRIME_AGENT_CODING_AGENT_DIR = join(dir, "agent");
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";
process.env.PI_HOST_WAKE_POLL_MS = "100";

/** The wakes the fake chat holds, as apps/chat's wake files: one per armed request, until the test sends it. */
const wakes: { thread: string; conversation: number; note: string }[] = [];
/** Every wake the fake chat was asked to set, sent or not. */
const armed: typeof wakes = [];
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
      if (request.method === "POST") {
        const request = JSON.parse(body) as { conversation: number; note: string };
        const wake = { thread, conversation: request.conversation, note: request.note };
        wakes.push(wake);
        armed.push(wake);
        response.end(JSON.stringify({ path: "wakes/x.json" }));
        return;
      }
      const conversation = Number(url.searchParams.get("conversation"));
      response.end(JSON.stringify({ wakes: wakes.filter(w => w.thread === thread && w.conversation === conversation) }));
    });
  });
  await new Promise<void>(resolve => chat.listen(0, "127.0.0.1", resolve));
  rlm = await DurableRlm.load({ ...rlmOptions(dir), chatUrl: `http://127.0.0.1:${(chat.address() as AddressInfo).port}` });
});
after(async () => {
  await rlm?.shutdown();
  chat?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The child's cell that arms a wake the way board.wake does in a pi thread: a POST to its chat's wakes route for its own conversation. */
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
    if (last.startsWith("[wake]")) {
      if (first.includes("and stay silent")) return say("woke quietly");
      return cell(`r = await agent_message.send("woke", receiver_role="parent")\nprint("sent", r["deliveryStatus"])`);
    }
    if (last.startsWith("sent ")) return say("replied");
    return say(`child unexpected: ${last.slice(0, 120)}`);
  }
  if (last === "spawn") return cell(`a = await rlm.spawn("wake later and reply", name="replier")\nprint("spawned", a.name)`);
  if (last.includes("spawned replier")) return say("spawned the replier");
  if (last.startsWith("[agent-message from child:replier]")) return cell(`b = await rlm.spawn("wake later and stay silent", name="silent")\nprint("spawned", b.name)`);
  if (last.includes("spawned silent")) return say("spawned the silent one");
  if (last.startsWith("[child-exited")) return say("exit seen");
  return say(`unexpected: ${last.slice(0, 120)}`);
}

test("a child that set a board.wake stays running until the wake's run, then its reply or its exit reaches the parent", { timeout: 180_000 }, async () => {
  const threads = new DurableThreads({
    dir: join(dir, "threads"),
    models: () => {
      const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 0 });
      faux.setResponses(Array.from({ length: 200 }, () => ({ messages }: { messages: Message[] }) => model(messages)));
      const models = createModels();
      models.setProvider(faux.provider);
      return models;
    },
    defaultModel: MODEL, defaultThinkingLevel: "off", defaultCwd: dir, rlm, primeRoots: null,
  });
  try {
    const { id } = await threads.create({ name: "child wake" });
    const rootInputs = async () => inputs((await threads.entries(id, { after: 0, limit: 500 })).entries).map(i => i.text);
    /** Waits until a child armed its wake and its run went idle a while, checks the parent heard nothing, and sends the wake as apps/chat does. */
    const wakeChild = async (count: number) => {
      const wake = await until(`wake ${count}`, async () => armed[count - 1]);
      await new Promise(resolve => setTimeout(resolve, 1500));
      const heard = (await rootInputs()).filter(t => t.startsWith("[child-exited") || t.startsWith("[agent-message"));
      assert.equal(heard.length, count - 1, `the parent hears nothing from a child whose wake has not gone out: ${JSON.stringify(heard)}`);
      wakes.splice(wakes.indexOf(wake), 1);
      await threads.submit(id, { conversation: wake.conversation, text: `[wake] It is now. Your note: ${wake.note}`, whenBusy: "followUp", entry: { kind: "agent.message", data: { from: "board", via: "wake" } } });
    };
    const first = await threads.submit(id, { text: "spawn" });
    assert.equal((await threads.wait(id, first.submission)).status, "done");
    await wakeChild(1);
    await until("the replier's reply", async () => (await rootInputs()).some(t => t.startsWith("[agent-message from child:replier]")), 60_000);
    await wakeChild(2);
    await until("the silent child's exit notice", async () => (await rootInputs()).some(t => t.startsWith("[child-exited: no-reply child:silent]")), 60_000)
      .catch(async error => { process.stdout.write(`# root inputs: ${JSON.stringify(await rootInputs())}\n`); throw error; });
    const seen = await rootInputs();
    assert.ok(seen.includes("[agent-message from child:replier]\n\nwoke"), seen.join(" | "));
    assert.deepEqual(seen.filter(t => t.startsWith("[child-exited")), ["[child-exited: no-reply child:silent]\n\nLast assistant text: woke quietly"]);
  } finally {
    await threads.shutdown();
  }
});
