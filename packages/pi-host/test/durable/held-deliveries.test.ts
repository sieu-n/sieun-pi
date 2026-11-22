/**
 * Several deliveries to one child that is held for a pending `board.wake` read the chat's wakes once per interval between them, not once each
 * (children.ts `hold`): the newer deliveries wait for the oldest one to end. On 11-22, 160 held deliveries on us-metal02 were for 14 children,
 * one child had 36, and the 123 that slept read :5184's wakes every 30 s each, about 4 reads a second, each a run of the task on pi-host's loop.
 * Every delivery still sends its own notice once the wake's run is over.
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
import { MODEL, textOf } from "./crash-scenario.ts";
import { cell, firstUser, inputs, lastText, rlmOptions, say, until } from "./rlm-rig.ts";

const POLL_MS = 100;
const dir = mkdtempSync(join(tmpdir(), "pi-host-held-deliveries-"));
process.env.HOME = join(dir, "home");
mkdirSync(process.env.HOME);
cpSync(join(import.meta.dirname, "../fixtures/prime-agent"), join(dir, "agent"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
process.env.PRIME_AGENT_CODING_AGENT_DIR = join(dir, "agent");
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";
process.env.PI_HOST_WAKE_POLL_MS = String(POLL_MS);

/** The wakes the fake chat holds, until the test sends them, and every wake it was asked to set. */
const wakes: { thread: string; conversation: number; note: string }[] = [];
const armed: typeof wakes = [];
/** The wake reads the fake chat answered, by conversation. */
const reads = new Map<number, number>();
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
        const arm = JSON.parse(body) as { conversation: number; note: string };
        const wake = { thread, conversation: arm.conversation, note: arm.note };
        wakes.push(wake);
        armed.push(wake);
        response.end(JSON.stringify({ path: "wakes/x.json" }));
        return;
      }
      const conversation = Number(url.searchParams.get("conversation"));
      reads.set(conversation, (reads.get(conversation) ?? 0) + 1);
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
    if (last.startsWith("[wake]")) return say("woke quietly");
    if (last.includes("poke")) return say("noted");
    return say(`child unexpected: ${last.slice(0, 120)}`);
  }
  if (last === "spawn") return cell(`a = await rlm.spawn("wake later and stay silent", name="held")\nprint("spawned", a.name)`);
  if (last.includes("spawned held")) return say("spawned the held one");
  if (last === "poke") return cell(`r = await agent_message.send("poke", receiver_role="child", receiver_name="held")\nprint("poked")`);
  if (last.includes("poked")) return say("poked the held one");
  if (last.startsWith("[child-exited")) return say("exit seen");
  return say(`unexpected: ${last.slice(0, 120)}`);
}

test("four deliveries to one child held for a wake read its wakes once per interval, and each still ends with its notice", { timeout: 180_000 }, async () => {
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
    const { id } = await threads.create({ name: "held deliveries" });
    const rootInputs = async () => inputs((await threads.entries(id, { after: 0, limit: 500 })).entries).map(i => i.text);
    const spawned = await threads.submit(id, { text: "spawn" });
    assert.equal((await threads.wait(id, spawned.submission)).status, "done");
    const wake = await until("the held child's wake", async () => armed.find(w => w.thread === id));
    for (let i = 0; i < 3; i++) {
      const poked = await threads.submit(id, { text: "poke" });
      assert.equal((await threads.wait(id, poked.submission)).status, "done");
    }
    const noted = async () => (await threads.entries(id, { conversation: wake.conversation, after: 0, limit: 500 })).entries
      .filter(entry => (entry.model?.[0] as Message | undefined)?.role === "assistant" && textOf((entry.model![0] as Message).content as never) === "noted").length;
    await until("the child's answer to each of the three pokes", async () => (await noted()) === 3);
    await new Promise(resolve => setTimeout(resolve, 3 * POLL_MS));

    const windowMs = 2_000;
    reads.set(wake.conversation, 0);
    await new Promise(resolve => setTimeout(resolve, windowMs));
    const read = reads.get(wake.conversation) ?? 0;
    assert.ok(read > 0, "the child is still held, so its wakes are read");
    assert.ok(read <= (windowMs / POLL_MS) * 1.5, `four held deliveries read the wakes ${read} times in ${windowMs} ms at one read per ${POLL_MS} ms`);
    assert.deepEqual((await rootInputs()).filter(t => t.startsWith("[child-exited")), [], "the parent hears nothing while the wake is pending");

    wakes.splice(wakes.indexOf(wake), 1);
    await threads.submit(id, { conversation: wake.conversation, text: `[wake] It is now. Your note: ${wake.note}`, whenBusy: "followUp", entry: { kind: "agent.message", data: { from: "board", via: "wake" } } });
    const exits = async () => (await rootInputs()).filter(t => t.startsWith("[child-exited: no-reply child:held]"));
    await until("a no-reply notice from each of the four deliveries", async () => (await exits()).length === 4, 60_000)
      .catch(async error => { process.stdout.write(`# root inputs: ${JSON.stringify(await rootInputs())}\n`); throw error; });
    for (const text of await exits()) assert.equal(text, "[child-exited: no-reply child:held]\n\nLast assistant text: woke quietly");
  } finally {
    await threads.shutdown();
  }
});
