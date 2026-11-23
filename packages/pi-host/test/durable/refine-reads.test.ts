/**
 * Auto-refine reviews that overlap read each harness store and the refinement log once, and a store a review wrote, or anyone wrote, is read
 * again (refine.ts `stateOf`, `logOf`). On 11-23 the reviews that settled together after a pi-host restart each parsed the 1.5 MB agent
 * store, the 1.6 MB global store and the 1.6 MB log in one loop turn (~/work/pi-host-stalls/h-restart-resume/report.md).
 * The bytes the process reads come from Linux's /proc/self/io, so the test runs only where that file exists.
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxProvider, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { HostCall } from "../../src/durable/host-modules.ts";
import { refineModule, type PlannerCall } from "../../src/durable/refine.ts";
import type { RlmThread } from "../../src/durable/rlm.ts";
import { DurableThreads } from "../../src/durable/threads.ts";
import { MODEL } from "./crash-scenario.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-host-refine-reads-"));
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";
after(() => rmSync(dir, { recursive: true, force: true }));

const globalDir = join(dir, "global");
const localDir = join(dir, "agent-store");

/** A store of `count` memories of about 500 characters, about 2 MB for 3,000. */
function writeStore(folder: string, prefix: string, count: number, extra?: string): void {
  mkdirSync(folder, { recursive: true });
  const memory: Record<string, unknown> = {};
  for (let i = 0; i < count; i++) {
    const id = `${prefix}_${i}`;
    memory[id] = { id, kind: "memory", title: `${prefix} note ${i}`, content: `${prefix} fact ${i}: ${"the deploy runs on green CI and the board keeps the step. ".repeat(9)}`, path: "general", scope: prefix === "global" ? "global" : "local", version: 1, created_at: "2026-11-23T00:00:00+00:00", updated_at: "2026-11-23T00:00:00+00:00" };
  }
  if (extra) memory[extra] = { id: extra, kind: "memory", title: extra, content: `${extra} is new.`, path: "general", scope: "local", version: 1, created_at: "2026-11-23T00:00:00+00:00", updated_at: "2026-11-23T00:00:00+00:00" };
  writeFileSync(join(folder, "harness_state.json"), JSON.stringify({ schema: 1, entries: { prompt: {}, memory, skill: {}, subagent: {} }, refinements: [] }));
}

/** The bytes this process has read so far (`rchar`). */
const bytesRead = (): number => Number(/rchar:\s*(\d+)/.exec(readFileSync("/proc/self/io", "utf8"))?.[1]);

test("six overlapping reviews read each store and the log once, and a store written meanwhile is read again", { skip: !existsSync("/proc/self/io"), timeout: 120_000 }, async () => {
  writeStore(globalDir, "global", 3000);
  writeStore(localDir, "agent", 3000);
  const log = Array.from({ length: 2000 }, (_, i) => JSON.stringify({ id: `refine_${i}`, summary: `Refine ${i} ${"kept a release rule. ".repeat(30)}`, rationale: "r", expectedOutcome: "e", appliedEdits: [{ action: "create", kind: "memory", id: `m${i}`, applied: true }], harnessStatePath: "x" })).join("\n");
  writeFileSync(join(globalDir, "refinements.jsonl"), `${log}\n`);
  const sizes = [join(globalDir, "harness_state.json"), join(localDir, "harness_state.json"), join(globalDir, "refinements.jsonl")].reduce((sum, file) => sum + statSync(file).size, 0);

  const threads = new DurableThreads({
    dir: join(dir, "durable"),
    models: () => {
      const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 0 });
      faux.setResponses(Array.from({ length: 20 }, () => () => fauxAssistantMessage("ok")));
      const models = createModels();
      models.setProvider(faux.provider);
      return models;
    },
    defaultModel: MODEL, defaultThinkingLevel: "off", defaultCwd: dir, primeRoots: null,
  });
  /** Each review's prompt, and the release of the reviews held at the planner as a model call holds them. */
  const prompts: string[] = [];
  let release!: () => void;
  let released = new Promise<void>(resolve => (release = resolve));
  const planner: PlannerCall = async (_call, _system, conversation, build) => {
    prompts.push(build(conversation));
    await released;
    return JSON.stringify({ shouldRefine: false, rationale: "nothing new" });
  };
  const logged: string[] = [];
  const module = refineModule({ agentDir: dir, globalDir, planner, log: () => {}, autoRefine: () => ({ enabled: true, turnInterval: 1, compact: true, cooldownMs: 0 }) });
  const until = async (what: string, check: () => boolean) => {
    for (const deadline = Date.now() + 30_000; !check();) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  try {
    const calls: HostCall[] = [];
    for (let i = 0; i < 8; i++) {
      const { id } = await threads.create({ name: `job ${i}` });
      const { submission } = await threads.submit(id, { text: "go" });
      assert.equal((await threads.wait(id, submission)).status, "done");
      const view = await threads.observe(id, { open: true });
      assert.ok(view);
      calls.push({
        // refine reads only the thread's id from it.
        thread: { id } as unknown as RlmThread,
        conversation: ROOT_CONVERSATION_ID, session: id, harnessDir: localDir, agent: "vent", harness: view.harness,
        releaseSlot: async () => {}, running: async () => false, workOut: async () => false,
        submit: async () => undefined, submitRoot: async () => undefined, log: line => logged.push(line),
      });
    }

    const before = bytesRead();
    await Promise.all(calls.slice(0, 6).map(call => module.settled!(call)));
    await until("six reviews at the planner", () => prompts.length === 6);
    const read = bytesRead() - before;
    assert.ok(read < 2 * sizes, `six overlapping reviews read ${read} bytes for ${sizes} bytes of stores and log`);
    for (const prompt of prompts) assert.match(prompt, /agent note 0/);

    // One review stays at the planner while the agent's store changes; the next review reads the new store.
    await module.settled!(calls[6]!);
    await until("the seventh review", () => prompts.length === 7);
    writeStore(localDir, "agent", 3000, "fresh_rule");
    await module.settled!(calls[7]!);
    await until("the eighth review", () => prompts.length === 8);
    // The review shows the 40 local entries nearest the conversation, so the new store shows in its count.
    assert.match(prompts[6]!, /- 40 of 3000 local memory entries/);
    assert.match(prompts[7]!, /- 40 of 3001 local memory entries/);
    release();
    released = Promise.resolve();
    await until("every review's log line", () => logged.filter(line => line.startsWith("auto-refine review")).length === 8);
  } finally {
    release();
    await module.shutdown?.();
    await threads.shutdown();
  }
});
