/**
 * A `bash()` handle a child started may outlive the child's run. Prime keeps such a child running and wakes it with `[bash-done ...]`
 * (its `waitForRlmQuiescence`), so pi-host's `rlm.deliver` task waits for the handle and for the run its notice starts:
 * 1. A child that ends its turn while its handle runs is not reported as exited. The notice starts its next run, and its reply from that
 *    run reaches the parent with no `[child-exited ...]`.
 * 2. A child that does not reply is reported once, after the notice's run, with that run's last text.
 * On 11-10 two agent factory jobs ended their turn while the pi-host suite ran, and their parent got `[child-exited: no-reply ...]` at once.
 */
import { strict as assert } from "node:assert";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

const dir = mkdtempSync(join(tmpdir(), "pi-host-child-bash-"));
process.env.HOME = join(dir, "home");
mkdirSync(process.env.HOME);
cpSync(join(import.meta.dirname, "../fixtures/prime-agent"), join(dir, "agent"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
process.env.PRIME_AGENT_CODING_AGENT_DIR = join(dir, "agent");
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";

let rlm: DurableRlm;
before(async () => {
  await testPython();
  rlm = await DurableRlm.load(rlmOptions(dir));
});
after(async () => {
  await rlm?.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

function model(messages: Message[]): ReturnType<typeof say> {
  const first = firstUser(messages);
  const last = lastText(messages);
  if (first.startsWith("[task from parent]")) {
    if (last.startsWith("[task from parent]")) return cell("h = bash('sleep 3; echo done')\nprint('started')");
    if (last.includes("started")) return say("waiting for the job");
    if (last.startsWith("[bash-done")) {
      if (first.includes("and stay silent")) return say("the job printed done");
      return cell(`r = await agent_message.send(h.poll().output.strip(), receiver_role="parent")\nprint("sent", r["deliveryStatus"])`);
    }
    if (last.startsWith("sent ")) return say("replied");
    return say(`child unexpected: ${last.slice(0, 120)}`);
  }
  if (last === "spawn") return cell(`a = await rlm.spawn("run the job and reply", name="replier")\nprint("spawned", a.name)`);
  if (last.includes("spawned replier")) return say("spawned the replier");
  if (last.startsWith("[agent-message from child:replier]")) return cell(`b = await rlm.spawn("run the job and stay silent", name="silent")\nprint("spawned", b.name)`);
  if (last.includes("spawned silent")) return say("spawned the silent one");
  if (last.startsWith("[child-exited")) return say("exit seen");
  return say(`unexpected: ${last.slice(0, 120)}`);
}

test("a child whose bash() handle outlives its turn stays running, gets the [bash-done] input and is reported after that run", { timeout: 180_000 }, async () => {
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
    const { id } = await threads.create({ name: "child bash" });
    const rootInputs = async () => inputs((await threads.entries(id, { after: 0, limit: 500 })).entries).map(i => i.text);
    const first = await threads.submit(id, { text: "spawn" });
    assert.equal((await threads.wait(id, first.submission)).status, "done");
    await until("the silent child's exit notice", async () => (await rootInputs()).some(t => t.startsWith("[child-exited: no-reply child:silent]")), 90_000)
      .catch(async error => { process.stdout.write(`# root inputs: ${JSON.stringify(await rootInputs())}\n`); throw error; });
    const seen = await rootInputs();
    assert.ok(seen.includes("[agent-message from child:replier]\n\ndone"), seen.join(" | "));
    assert.deepEqual(seen.filter(t => t.startsWith("[child-exited")), ["[child-exited: no-reply child:silent]\n\nLast assistant text: the job printed done"]);
  } finally {
    await threads.shutdown();
  }
});
