/**
 * A child that spawns a subagent of its own and ends its turn is not done: the grandchild's reply reaches it as an agent message and starts
 * its next run, as Prime keeps such a session running. pi-host's `rlm.deliver` task holds the child while a delivery to one of its own
 * children is still going:
 * 1. A child that replies once its grandchild answered reaches the parent with its reply and no `[child-exited ...]`.
 * 2. A child that stays silent is reported once, after the run the grandchild's reply started, with that run's last text.
 * On 11-20 the job 'skills health' started seven auditors, ended its turn to wait for them and reached its parent as
 * `[child-exited: no-reply child:skills health]`.
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

const dir = mkdtempSync(join(tmpdir(), "pi-host-child-subagents-"));
process.env.HOME = join(dir, "home");
mkdirSync(process.env.HOME);
cpSync(join(import.meta.dirname, "../fixtures/prime-agent"), join(dir, "agent"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
process.env.PRIME_AGENT_CODING_AGENT_DIR = join(dir, "agent");
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";

let chat: Server;
let rlm: DurableRlm;
before(async () => {
  await testPython();
  // A chat with no wakes, so the hold never asks the live chat.
  chat = createServer((_request, response) => response.end(JSON.stringify({ wakes: [] })));
  await new Promise<void>(resolve => chat.listen(0, "127.0.0.1", resolve));
  rlm = await DurableRlm.load({ ...rlmOptions(dir), chatUrl: `http://127.0.0.1:${(chat.address() as AddressInfo).port}` });
});
after(async () => {
  await rlm?.shutdown();
  chat?.close();
  rmSync(dir, { recursive: true, force: true });
});

const SPAWN_GRAND = `g = await rlm.spawn("say hi a little later", name="grand")\nprint("spawned", g.name)`;
const LATE_HI = `import asyncio\nawait asyncio.sleep(2)\nr = await agent_message.send("hi", receiver_role="parent")\nprint("sent", r["deliveryStatus"])`;

function model(messages: Message[]): ReturnType<typeof say> {
  const first = firstUser(messages);
  const last = lastText(messages);
  if (first.startsWith("[task from parent]\n\nsay hi")) {
    if (last.startsWith("[task from parent]")) return cell(LATE_HI);
    if (last.startsWith("sent ")) return say("said hi");
    return say(`grandchild unexpected: ${last.slice(0, 120)}`);
  }
  if (first.startsWith("[task from parent]")) {
    if (last.startsWith("[task from parent]")) return cell(SPAWN_GRAND);
    if (last.includes("spawned grand")) return say("waiting for the grandchild");
    if (last.startsWith("[agent-message from child:grand]")) {
      if (first.includes("and stay silent")) return say("heard hi");
      return cell(`r = await agent_message.send("got hi", receiver_role="parent")\nprint("sent", r["deliveryStatus"])`);
    }
    if (last.startsWith("sent ")) return say("replied");
    return say(`child unexpected: ${last.slice(0, 120)}`);
  }
  if (last === "spawn") return cell(`a = await rlm.spawn("spawn a grandchild and reply", name="replier")\nprint("spawned", a.name)`);
  if (last.includes("spawned replier")) return say("spawned the replier");
  if (last.startsWith("[agent-message from child:replier]")) return cell(`b = await rlm.spawn("spawn a grandchild and stay silent", name="silent")\nprint("spawned", b.name)`);
  if (last.includes("spawned silent")) return say("spawned the silent one");
  if (last.startsWith("[child-exited")) return say("exit seen");
  return say(`unexpected: ${last.slice(0, 120)}`);
}

test("a child whose own subagent still runs stays running until that subagent's reply and the run it starts are over", { timeout: 180_000 }, async () => {
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
    const { id } = await threads.create({ name: "child subagents" });
    const rootInputs = async () => inputs((await threads.entries(id, { after: 0, limit: 500 })).entries).map(i => i.text);
    const first = await threads.submit(id, { text: "spawn" });
    assert.equal((await threads.wait(id, first.submission)).status, "done");
    await until("the replier's reply", async () => (await rootInputs()).some(t => t.startsWith("[agent-message from child:replier]")), 60_000)
      .catch(async error => { process.stdout.write(`# root inputs: ${JSON.stringify(await rootInputs())}\n`); throw error; });
    await until("the silent child's exit notice", async () => (await rootInputs()).some(t => t.startsWith("[child-exited: no-reply child:silent]")), 60_000)
      .catch(async error => { process.stdout.write(`# root inputs: ${JSON.stringify(await rootInputs())}\n`); throw error; });
    await new Promise(resolve => setTimeout(resolve, 1000));
    const heard = (await rootInputs()).filter(t => t.startsWith("[child-exited") || t.startsWith("[agent-message"));
    assert.deepEqual(heard, [
      "[agent-message from child:replier]\n\ngot hi",
      "[child-exited: no-reply child:silent]\n\nLast assistant text: heard hi",
    ]);
  } finally {
    await threads.shutdown();
  }
});
