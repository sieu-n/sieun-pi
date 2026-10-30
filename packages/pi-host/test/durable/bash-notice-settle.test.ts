/**
 * A `bash()` job that ends while a cell runs leaves a notice for the run's settle (`rlm.ts` `settled`). The settle runs inside the
 * conversation's slot release (`threads.ts` `settle`), and `submit` waits for that release, so the notice must not be awaited there:
 * 1. The notice arrives as its own `[bash-done ...]` input once the turn ends.
 * 2. A later submit to the same conversation, such as a sibling's agent_message, is admitted and answered.
 * On 10-30 two phase 6 jobs of agent factory hung 5 h in agent_message.send to siblings whose settle waited on its own release.
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
import { cell, inputs, rlmOptions, say, textOf, until } from "./rlm-rig.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-host-bash-settle-"));
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
  const at = messages.findLastIndex(m => m.role === "user");
  const text = at < 0 ? "" : textOf(messages[at]!.content as never);
  const answered = messages.slice(at + 1).some(m => m.role === "toolResult");
  if (text === "start a job") return answered ? say("job started") : cell("h = bash('sleep 0.3; echo hi')\nimport asyncio\nawait asyncio.sleep(2)");
  if (text.startsWith("[bash-done")) return say("job noted");
  if (text === "next task") return say("next done");
  return say("ok");
}

test("a bash notice left for the settle arrives as an input, and the next submit to that conversation is answered", { timeout: 120_000 }, async () => {
  const threads = new DurableThreads({
    dir: join(dir, "threads"),
    models: () => {
      const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 0 });
      faux.setResponses(Array.from({ length: 50 }, () => ({ messages }: { messages: Message[] }) => model(messages)));
      const models = createModels();
      models.setProvider(faux.provider);
      return models;
    },
    defaultModel: MODEL, defaultThinkingLevel: "off", defaultCwd: dir, rlm, primeRoots: null,
  });
  try {
    const { id } = await threads.create({ name: "bash settle" });
    const entries = async () => (await threads.entries(id, { after: 0, limit: 500 })).entries;
    const first = await threads.submit(id, { text: "start a job" });
    assert.equal((await threads.wait(id, first.submission)).status, "done");
    await until("the bash-done input", async () => inputs(await entries()).some(i => i.text.startsWith("[bash-done")), 20_000);
    const next = await Promise.race([
      threads.submit(id, { text: "next task" }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the submit after the settle never returned")), 20_000)),
    ]);
    assert.equal((await threads.wait(id, next.submission)).status, "done");
    const seen = inputs(await entries()).map(i => i.text.split("\n")[0]);
    assert.deepEqual(seen.filter(t => !t.startsWith("[bash-done")), ["start a job", "next task"]);
    assert.equal(seen.filter(t => t.startsWith("[bash-done")).length, 1, seen.join(" | "));
  } finally {
    await threads.shutdown();
  }
});
