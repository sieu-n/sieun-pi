/**
 * Prime's `refine` module in a durable thread (`refine.ts`), through real kernel cells on a faux model:
 * 1. `refine.run` in a cell schedules, `refine.status` shows it pending, and when the run settles the planner runs on the conversation's model,
 *    the edit lands in the thread's local store with its refinement event, and the `[self-refinement]` notice arrives as a refine input.
 * 2. `refine.run(global=True)` writes the global store and appends Prime's `refinements.jsonl`.
 * 3. Outside a run it answers Prime's "no active turn", and a child conversation gets no refine, as Prime registers it only at depth 0.
 */
import { strict as assert } from "node:assert";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { testPython } from "@sieun-pi/pi-rlm/test-helpers";
import type { HostCall } from "../../src/durable/host-modules.ts";
import { threadHarnessDir } from "../../src/durable/prime-harness.ts";
import { NO_ACTIVE_TURN, refineModule } from "../../src/durable/refine.ts";
import { DurableRlm } from "../../src/durable/rlm.ts";
import { DurableThreads } from "../../src/durable/threads.ts";
import { MODEL } from "./crash-scenario.ts";
import { cell, inputs, results, rlmOptions, say, textOf, until } from "./rlm-rig.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-host-refine-"));
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

const planned: string[] = [];
const edit = (id: string, content: string) => JSON.stringify({
  summary: `Remember ${id}`, rationale: "The owner gave a rule.", expectedOutcome: "The rule shows in the digest.",
  edits: [{ action: "create", kind: "memory", id, title: id.replace(/_/g, " "), content, path: "test" }],
});
const REQUEST = (args: string) => `from rlm import host_request\nbefore = await host_request("refine.status")\nasked = await host_request("refine.run", ${args})\nafter = await host_request("refine.status")\nprint(before, asked, after)`;

function model(messages: Message[]): ReturnType<typeof say> {
  const at = messages.findLastIndex(m => m.role === "user");
  const text = at < 0 ? "" : textOf(messages[at]!.content as never);
  if (text.startsWith("<current_harness_state>")) {
    planned.push(text);
    return fauxAssistantMessage([fauxText(text.includes("scope: global") ? edit("global_deploy_rule", "Deploys ship on green CI.") : edit("deploy_rule", "Staging deploys need no ok."))]);
  }
  const answered = messages.slice(at + 1).some(m => m.role === "toolResult");
  if (text === "remember the deploy rule") return answered ? say("refine asked") : cell(REQUEST('{"instructions": "save the deploy rule"}'));
  if (text === "remember it for every session") return answered ? say("global refine asked") : cell(REQUEST('{"global": True}'));
  if (text.startsWith("[self-refinement]")) return say("refinement seen");
  return say("ok");
}

test("refine.run schedules, the settle plans and applies, and the notice arrives as an input; global writes the global store", { timeout: 180_000 }, async () => {
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
    const { id } = await threads.create({ name: "refine" });
    const entries = async () => (await threads.entries(id, { after: 0, limit: 500 })).entries;
    const notices = async () => inputs(await entries()).filter(i => i.data?.from === "refine");

    const first = await threads.submit(id, { text: "remember the deploy rule" });
    assert.equal((await threads.wait(id, first.submission)).status, "done");
    const asked = results(await entries()).find(r => r.name === "ipython")!;
    assert.ok(!asked.isError, asked.text);
    assert.match(asked.text, /^\{'pending': False, 'in_flight': False\} \{'scheduled': True, 'note': 'Refinement runs when the current turn ends/);
    assert.match(asked.text, /\{'pending': True, 'in_flight': False\}$/m);

    const [notice] = await until("the refine notice", async () => { const n = await notices(); return n.length ? n : undefined; }, 30_000);
    assert.equal(notice!.data?.via, "refine-notice");
    assert.match(notice!.text, /^\[self-refinement\]\n\nRemember deploy_rule\n- create memory \[local:deploy_rule\] deploy rule: Staging deploys need no ok\./);
    assert.match(planned[0]!, /<user_refine_instructions>\nsave the deploy rule\n<\/user_refine_instructions>/);
    assert.match(planned[0]!, /\[User\]: remember the deploy rule/);
    assert.match(planned[0]!, /Requested refinement scope: local/);

    const stores = (readdirSync(dir, { recursive: true }) as string[]).filter(p => p.endsWith("harness_state.json") && !p.startsWith("agent"));
    assert.deepEqual(stores, [join(relative(dir, threadHarnessDir(join(dir, "threads", id, `${id}.sqlite`), id)), "harness_state.json")]);
    const local = JSON.parse(readFileSync(join(dir, stores[0]!), "utf8"));
    assert.equal(local.entries.memory.deploy_rule.content, "Staging deploys need no ok.");
    assert.equal(local.entries.memory.deploy_rule.scope, "local");
    assert.deepEqual(local.refinements.at(-1).changes, ["create memory:deploy_rule"]);
    await until("the notice's answer", async () => (await entries()).some(e => { const m = e.model?.[0] as Message | undefined; return m?.role === "assistant" && textOf(m.content as never) === "refinement seen"; }), 30_000);

    const second = await threads.submit(id, { text: "remember it for every session" });
    assert.equal((await threads.wait(id, second.submission)).status, "done");
    await until("the global refine notice", async () => ((await notices()).length === 2 ? true : undefined), 30_000);
    assert.match(planned[1]!, /Requested refinement scope: global/);
    const globalDir = join(dir, "agent", "harness");
    const global = JSON.parse(readFileSync(join(globalDir, "harness_state.json"), "utf8"));
    assert.equal(global.entries.memory.global_deploy_rule.scope, "global");
    const log = readFileSync(join(globalDir, "refinements.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(log.at(-1).appliedEdits[0].id, "global_deploy_rule");
    assert.equal(log.at(-1).scope, "global");
    assert.equal(planned.length, 2);
  } finally {
    await threads.shutdown();
  }
});

test("refine.run outside a run answers no active turn, and a child conversation has no refine", async () => {
  const module = refineModule({ agentDir: join(dir, "agent"), log: () => {} });
  const call = (conversation: number, running: boolean) => ({
    thread: { id: "t" }, conversation, session: "t", harnessDir: join(dir, "nowhere"), running: async () => running,
  }) as unknown as HostCall;
  assert.deepEqual(await module.request(call(1, false), "refine.run", {}), { scheduled: false, reason: NO_ACTIVE_TURN });
  await assert.rejects(async () => module.request(call(1, true), "refine.run", { global: "yes" }), /global must be a boolean/);
  await assert.rejects(async () => module.request(call(2, true), "refine.run", {}), /only in a thread's root conversation/);
  assert.equal(existsSync(join(dir, "nowhere")), false);
});
