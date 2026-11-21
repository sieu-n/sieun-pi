/**
 * Prime's `refine` module in a durable thread (`refine.ts`), through real kernel cells on a faux model:
 * 1. `refine.run` in a cell schedules, `refine.status` shows it pending, and when the run settles the planner runs on the conversation's model,
 *    the edit lands in the thread's local store with its refinement event, and the `[self-refinement]` notice arrives as a refine input.
 * 2. `refine.run(global=True)` writes the global store and appends Prime's `refinements.jsonl`.
 * 3. In an agent's thread, Prime's auto-refine reviews after the turn interval and writes the agent's store, told it is the agent's memory.
 * 4. Outside a run it answers Prime's "no active turn", and a child conversation gets no refine, as Prime registers it only at depth 0, unless
 *    the thread belongs to an agent, whose store outlives the job.
 * 5. A walk's test agent (`agent.ref` `test: true`) gets no skill route, and its refine writes its own store even when asked for global.
 * 6. With the real pool/turns.py queue, an auto-refine's review and planner take a working slot as `<thread>` and give it back when the
 *    refine ends, so no finished refine holds a slot for the 1800 s lease.
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { poolProvider, TurnQueue } from "@sieun-pi/pi-pool/durable";
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
const reviewed: string[] = [];
const edit = (id: string, content: string) => JSON.stringify({
  summary: `Remember ${id}`, rationale: "The owner gave a rule.", expectedOutcome: "The rule shows in the digest.",
  edits: [{ action: "create", kind: "memory", id, title: id.replace(/_/g, " "), content, path: "test" }],
});
const REQUEST = (args: string) => `from rlm import host_request\nbefore = await host_request("refine.status")\nasked = await host_request("refine.run", ${args})\nafter = await host_request("refine.status")\nprint(before, asked, after)`;

function model(messages: Message[]): ReturnType<typeof say> {
  const at = messages.findLastIndex(m => m.role === "user");
  const text = at < 0 ? "" : textOf(messages[at]!.content as never);
  if (text.startsWith("<trigger>")) {
    reviewed.push(text);
    return fauxAssistantMessage([fauxText(JSON.stringify({ shouldRefine: true, rationale: "The owner gave a release rule." }))]);
  }
  if (text.startsWith("<current_harness_state>")) {
    planned.push(text);
    if (text.includes("agent seo's memory")) return fauxAssistantMessage([fauxText(JSON.stringify({
      summary: "Keep the keyword decision and route the JSON rule", rationale: "The owner gave a product decision and a general standard.", expectedOutcome: "Memory holds the decision and a skill gets the rule.",
      edits: [{ action: "create", kind: "memory", id: "keyword_list", title: "keyword list", content: "seo targets the 40 keywords in keywords.csv.", path: "test" }],
      skillRoutes: [{ target: "skills/sw-factory/SKILL.md", rule: "Never paste raw JSON in a post (p9).", evidence: "the owner's second message" }, { target: "", rule: "dropped" }],
    }))]);
    if (text.includes("agent blind's memory")) return fauxAssistantMessage([fauxText(JSON.stringify({
      summary: "Keep the file rule and route it", rationale: "The test task taught a rule.", expectedOutcome: "The rule reaches every agent.",
      edits: [{ action: "create", kind: "memory", id: "file_rule", title: "file rule", content: "Write a large file with the write tool.", path: "test" }],
      skillRoutes: [{ target: "config/AGENTS.md", rule: "Write a large file with the write tool.", evidence: "the made-up task" }],
    }))]);
    if (text.includes("agent vent's memory")) return fauxAssistantMessage([fauxText(edit("release_rule", "Release apps/chat with scripts/release-apps-chat.mjs."))]);
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

test("in an agent's thread, auto-refine reviews after the turn interval and writes the agent's store with the agent's scope", { timeout: 180_000 }, async () => {
  const settings = join(dir, "agent", "settings.json");
  const kept = existsSync(settings) ? readFileSync(settings, "utf8") : undefined;
  writeFileSync(settings, JSON.stringify({ ...(kept ? JSON.parse(kept) : {}), autoRefine: { turnInterval: 2, cooldownMs: 0 } }));
  const folder = join(dir, "agents", "vent");
  const threads = new DurableThreads({
    dir: join(dir, "threads-auto"),
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
    const { id } = await threads.create({ name: "vent" });
    await threads.docPut(id, "agent.ref", { agent: "ag_vent", dir: folder, role: "work" });
    for (const text of ["hello", "release with the script"]) {
      const sent = await threads.submit(id, { text });
      assert.equal((await threads.wait(id, sent.submission)).status, "done");
    }
    const store = join(folder, "harness", "harness_state.json");
    const saved = await until("the agent's store", async () => (existsSync(store) ? JSON.parse(readFileSync(store, "utf8")) : undefined), 30_000);
    assert.equal(saved.entries.memory.release_rule.content, "Release apps/chat with scripts/release-apps-chat.mjs.");
    assert.match(reviewed[0]!, /a fact agent vent will need again in a later thread/);
    assert.match(planned.at(-1)!, /Requested refinement scope: agent vent's memory/);
    assert.match(planned.at(-1)!, /Automatic refine review triggered by turn_interval\. Only create\/update\/delete entries of agent vent's memory/);
    assert.equal(reviewed.length, 1, "the next settle counts turns after the review");
  } finally {
    await threads.shutdown();
    if (kept === undefined) rmSync(settings, { force: true });
    else writeFileSync(settings, kept);
  }
});

test("in an agent's thread, a general standard goes to a skill route that starts a turn of the root, and the product decision stays in memory", { timeout: 180_000 }, async () => {
  const settings = join(dir, "agent", "settings.json");
  const kept = existsSync(settings) ? readFileSync(settings, "utf8") : undefined;
  writeFileSync(settings, JSON.stringify({ ...(kept ? JSON.parse(kept) : {}), autoRefine: { turnInterval: 2, cooldownMs: 0 } }));
  const folder = join(dir, "agents", "seo");
  const threads = new DurableThreads({
    dir: join(dir, "threads-route"),
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
    const { id } = await threads.create({ name: "seo" });
    await threads.docPut(id, "agent.ref", { agent: "ag_seo", dir: folder, role: "work" });
    for (const text of ["target the 40 keywords in keywords.csv", "never paste raw JSON in a post"]) {
      const sent = await threads.submit(id, { text });
      assert.equal((await threads.wait(id, sent.submission)).status, "done");
    }
    const entries = async () => (await threads.entries(id, { after: 0, limit: 500 })).entries;
    const [route] = await until("the skill route", async () => { const r = inputs(await entries()).filter(i => i.data?.via === "skill-route"); return r.length ? r : undefined; }, 30_000);
    assert.match(route!.text, /^\[skill-route\]\n\nRefine found a general standard that belongs in a skill/);
    assert.match(route!.text, /refine-harness skill/);
    assert.match(route!.text, /\n- skills\/sw-factory\/SKILL\.md: Never paste raw JSON in a post \(p9\)\. \(the owner's second message\)$/);
    assert.equal(route!.text.split("\n- ").length, 2, "a route with no target is dropped");
    const store = JSON.parse(readFileSync(join(folder, "harness", "harness_state.json"), "utf8"));
    assert.equal(store.entries.memory.keyword_list.content, "seo targets the 40 keywords in keywords.csv.");
    assert.deepEqual(store.refinements.at(-1).changes, ["create memory:keyword_list", "route skills/sw-factory/SKILL.md"]);
    const plan = planned.findLast(p => p.includes("agent seo's memory"))!;
    assert.match(plan, /Route a general standard to a skill, never to a memory or a prompt note/);
    assert.match(plan, /return a general standard as a skillRoutes item instead of an entry/);
    assert.match(reviewed.at(-1)!, /a general standard the owner gave/);
  } finally {
    await threads.shutdown();
    if (kept === undefined) rmSync(settings, { force: true });
    else writeFileSync(settings, kept);
  }
});

test("a test agent's refine sends no skill route and writes only its own store, also when asked for global", { timeout: 180_000 }, async () => {
  const folder = join(dir, "agents", "blind");
  const threads = new DurableThreads({
    dir: join(dir, "threads-test-agent"),
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
    const { id } = await threads.create({ name: "blind" });
    await threads.docPut(id, "agent.ref", { agent: "ag_blind", dir: folder, role: "work", test: true });
    const sent = await threads.submit(id, { text: "remember it for every session" });
    assert.equal((await threads.wait(id, sent.submission)).status, "done");
    const entries = async () => (await threads.entries(id, { after: 0, limit: 500 })).entries;
    const [notice] = await until("the refine notice", async () => { const n = inputs(await entries()).filter(i => i.data?.from === "refine"); return n.length ? n : undefined; }, 30_000);
    assert.equal(notice!.data?.via, "refine-notice", "the only refine input is the notice");
    const plan = planned.findLast(p => p.includes("agent blind's memory"))!;
    assert.doesNotMatch(plan, /skillRoutes/, "the planner is not offered routes");
    const store = JSON.parse(readFileSync(join(folder, "harness", "harness_state.json"), "utf8"));
    assert.equal(store.entries.memory.file_rule.scope, "local");
    const global = join(dir, "agent", "harness", "harness_state.json");
    assert.equal(existsSync(global) && JSON.parse(readFileSync(global, "utf8")).entries.memory.file_rule, undefined);
    assert.equal(inputs(await entries()).filter(i => i.data?.via === "skill-route").length, 0);
  } finally {
    await threads.shutdown();
  }
});

test("an auto-refine gives its pi-pool working slot back when it ends", { timeout: 180_000 }, async () => {
  const poolDir = join(dir, "pool");
  mkdirSync(poolDir, { recursive: true });
  const poolCli = join(import.meta.dirname, "..", "..", "..", "pi-pool", "bin", "pi-pool");
  const env = { ...process.env, PI_POOL_DIR: poolDir };
  const poolRun = (...args: string[]) => execFileSync("/usr/bin/python3", ["-B", poolCli, ...args], { env, encoding: "utf8" });
  poolRun("set", "agent_queue_on", "1");
  poolRun("set", "working_max", "4");
  const bin = join(dir, "pool-hook");
  writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "--cli" ]; then shift; exec /usr/bin/python3 -B '${poolCli}' "$@"; fi\nprintf 'sk-ant-oat01-faux'\n`);
  chmodSync(bin, 0o755);
  const settings = join(dir, "agent", "settings.json");
  const kept = existsSync(settings) ? readFileSync(settings, "utf8") : undefined;
  writeFileSync(settings, JSON.stringify({ ...(kept ? JSON.parse(kept) : {}), autoRefine: { turnInterval: 2, cooldownMs: 0 } }));
  const keptPoolDir = process.env.PI_POOL_DIR;
  process.env.PI_POOL_DIR = poolDir;
  const turns = new TurnQueue({ bin });
  const tree = (id: string) => `pi-durable:${id}`;
  const folder = join(dir, "agents", "vent-pool");
  const threads = new DurableThreads({
    dir: join(dir, "threads-pool"),
    models: id => {
      const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 0 });
      faux.setResponses(Array.from({ length: 50 }, () => ({ messages }: { messages: Message[] }) => model(messages)));
      const models = createModels();
      models.setProvider(poolProvider({ treeKey: tree(id), bin, inner: faux.provider, turns }));
      return models;
    },
    inputSettled: (id, session, runContinues) => turns.release({ root: tree(id), session }, runContinues),
    turns: {
      ownerTurn: (id, session) => turns.ownerTurn({ root: tree(id), session }),
      ticket: (id, session) => turns.ticket({ root: tree(id), session }),
      release: (id, session) => turns.release({ root: tree(id), session }),
    },
    defaultModel: MODEL, defaultThinkingLevel: "off", defaultCwd: dir, rlm, primeRoots: null,
  });
  try {
    const { id } = await threads.create({ name: "vent" });
    await threads.docPut(id, "agent.ref", { agent: "ag_vent", dir: folder, role: "work" });
    for (const text of ["hello", "release with the script"]) {
      const sent = await threads.submit(id, { text });
      assert.equal((await threads.wait(id, sent.submission)).status, "done");
    }
    const store = join(folder, "harness", "harness_state.json");
    await until("the agent's store", async () => (existsSync(store) ? true : undefined), 30_000);
    const events = () => readFileSync(join(poolDir, "pi-pool.log"), "utf8").trim().split("\n").map(line => JSON.parse(line) as { event?: string; session?: string });
    assert.ok(events().some(e => e.event === "turn_admitted" && e.session === id), "the refine asked the queue as the thread's harness session");
    const working = () => Object.keys((JSON.parse(readFileSync(join(poolDir, "turns.json"), "utf8")) as { working?: Record<string, unknown> }).working ?? {});
    await until("the refine's slot back", async () => (working().includes(id) ? undefined : true), 10_000)
      .catch(() => assert.fail(`the finished refine still holds its working slot: working ${JSON.stringify(working())}`));
    assert.deepEqual(working(), [], "no run of the thread holds a slot once it is idle");
    assert.ok(events().some(e => e.event === "turn_released" && e.session === id));
    assert.equal(turns.holds(id), false, "the queue forgets the session, so the next refine asks instead of renewing a lapsed slot");
  } finally {
    await threads.shutdown();
    if (keptPoolDir === undefined) delete process.env.PI_POOL_DIR;
    else process.env.PI_POOL_DIR = keptPoolDir;
    if (kept === undefined) rmSync(settings, { force: true });
    else writeFileSync(settings, kept);
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
  const job = { ...call(2, true), agent: "vent" } as HostCall;
  await assert.rejects(async () => module.request(job, "refine.run", { global: "yes" }), /global must be a boolean/, "a job of an agent's thread gets refine");
  assert.equal(existsSync(join(dir, "nowhere")), false);
});
