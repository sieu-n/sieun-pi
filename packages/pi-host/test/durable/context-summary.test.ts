/**
 * The settle and submit checks of a root conversation read only the entries added since their last read (`context-summary.ts`). On 11-23 the
 * auto-refine check at each settle and the harness check at each submit read and parsed the whole context every time: 11,000 of the 15,000
 * entries 80 requests read on a copy rig (~/work/pi-host-stalls/m-request-cpu/report.md).
 */
import { strict as assert } from "node:assert";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { ROOT_CONVERSATION_ID, type EntryId, type Harness, type Storage } from "@earendil-works/pi-durable";
import { assistantsAfter, contextSummary, summarize } from "../../src/durable/context-summary.ts";
import type { HostCall } from "../../src/durable/host-modules.ts";
import { threadHarnessDir } from "../../src/durable/prime-harness.ts";
import { refineModule } from "../../src/durable/refine.ts";
import type { RlmThread } from "../../src/durable/rlm.ts";
import { DurableThreads } from "../../src/durable/threads.ts";
import { MODEL } from "./crash-scenario.ts";

const scratch = mkdtempSync(join(tmpdir(), "pi-host-context-summary-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";
process.env.HOME = join(scratch, "home");
mkdirSync(process.env.HOME);
const fixture = join(import.meta.dirname, "../fixtures/prime-harness");

type OpenFile = { harness: Harness; storage: Storage };
const openOf = (threads: DurableThreads, id: string) => (threads as unknown as { thread(id: string): Promise<OpenFile> }).thread(id);
const ctx = BACKGROUND_CONTEXT;
let clock = 1_700_000_000_000;

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const turn = (text: string, stopReason = "stop") => [
  { kind: "pi.user", model: [{ role: "user", content: text, timestamp: clock++ }] },
  { kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: `re: ${text}` }], api: "anthropic-messages", provider: "anthropic", model: "m", usage, stopReason, timestamp: clock++ }] },
];

/** Appends `drafts` to the root conversation in one commit and returns their ids. */
async function append(harness: Harness, drafts: readonly object[]): Promise<number[]> {
  return harness.commit(async tx => {
    const ids: number[] = [];
    for (const draft of drafts) ids.push((await tx.appendEntry(ROOT_CONVERSATION_ID, draft as never)).id as number);
    return ids;
  }, ctx);
}

/** Counts whole-context reads: a scan from the newest entry down with no cursor and no lower bound, as pi-durable's scanRange starts one. */
function countWholeReads(storage: Storage): { whole: number; entries: number } {
  const seen = { whole: 0, entries: 0 };
  const scan = storage.scanEntries.bind(storage);
  storage.scanEntries = async (query, limit, cursor, context) => {
    if (cursor === undefined && limit > 1 && query.minEntryId === undefined && query.maxEntryId !== undefined) seen.whole++;
    const page = await scan(query, limit, cursor, context);
    seen.entries += page.items.length;
    return page;
  };
  return seen;
}

const plainModels = () => createModels();

test("a summary extended by added entries equals the summary of a whole read, through edits, a stopped answer and a compaction", { timeout: 60_000 }, async () => {
  const threads = new DurableThreads({ dir: join(scratch, "exact"), defaultModel: MODEL, defaultThinkingLevel: "off", defaultCwd: scratch, primeRoots: null, models: plainModels });
  try {
    const thread = await threads.create({ name: "exact" });
    const { harness, storage } = await openOf(threads, thread.id);
    const whole = async () => summarize(await (await harness.conversation(ROOT_CONVERSATION_ID, ctx))!.context(ctx));
    const check = async (label: string) => {
      const kept = await contextSummary(harness, ROOT_CONVERSATION_ID, ctx);
      assert.deepEqual(kept, await whole(), label);
      return kept!;
    };
    const ids = await append(harness, Array.from({ length: 10 }, (_, i) => turn(`ask ${i}`)).flat());
    await check("the first read");
    const seen = countWholeReads(storage);
    await append(harness, [...turn("more"), ...turn("stopped", "aborted"), { kind: "note", data: { a: 1 } }]);
    const extended = await check("five added entries");
    assert.equal(seen.whole, 1, "only the check's own whole read in `whole`; the summary read the added entries");
    assert.deepEqual(extended.recent.slice(-3), ["more", "re: more", "stopped"], "a stopped answer adds no text");
    assert.equal(assistantsAfter(extended, ids.at(-1)!), 1, "the aborted answer is not a turn");
    await append(harness, [{ kind: "pi.edit", edits: [{ target: ids[3] as unknown as EntryId, action: "omit" }] }]);
    await check("an edit");
    await append(harness, turn("after the edit"));
    await check("entries after an edit");
    await append(harness, [{ kind: "pi.compaction", head: "self", model: [{ role: "user", content: "summary of the earlier turns", timestamp: clock++ }] }]);
    const compacted = await check("a compaction");
    assert.equal(compacted.head?.kind, "pi.compaction");
    await append(harness, turn("after the compaction"));
    await check("entries after the compaction");
  } finally {
    await threads.shutdown();
  }
});

test("an auto-refine check at a settle reads only the entries added since the last one", { timeout: 60_000 }, async () => {
  const threads = new DurableThreads({ dir: join(scratch, "refine"), defaultModel: MODEL, defaultThinkingLevel: "off", defaultCwd: scratch, primeRoots: null, models: plainModels });
  const module = refineModule({ agentDir: scratch, globalDir: join(scratch, "global"), log: () => {}, autoRefine: () => ({ enabled: true, turnInterval: 1_000, compact: true, cooldownMs: 0 }) });
  try {
    const thread = await threads.create({ name: "settles" });
    const { harness, storage } = await openOf(threads, thread.id);
    await append(harness, Array.from({ length: 200 }, (_, i) => turn(`ask ${i} ${"a long post. ".repeat(200)}`)).flat());
    const call = {
      thread: { id: thread.id } as unknown as RlmThread, conversation: ROOT_CONVERSATION_ID, session: thread.id, harnessDir: join(scratch, "local"), harness,
      releaseSlot: async () => {}, running: async () => false, workOut: async () => false, submit: async () => undefined, submitRoot: async () => undefined, log: () => {},
    } as unknown as HostCall;
    await module.settled!(call);
    await append(harness, turn("one more"));
    const seen = countWholeReads(storage);
    await module.settled!(call);
    assert.equal(seen.whole, 0, `the second settle read the whole context ${seen.whole} times`);
    assert.ok(seen.entries <= 10, `the second settle read ${seen.entries} entries for 2 added`);
  } finally {
    await module.shutdown?.();
    await threads.shutdown();
  }
});

test("a submit's harness check reads only the entries added since the last submit", { timeout: 120_000 }, async () => {
  const agentDir = join(scratch, "digest", "agent");
  cpSync(join(fixture, "global"), join(agentDir, "harness"), { recursive: true });
  const threads = new DurableThreads({
    dir: join(agentDir, "pi-host", "durable"),
    models: () => {
      const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 0 });
      faux.setResponses(Array.from({ length: 6 }, () => () => fauxAssistantMessage("ok")));
      const models = createModels();
      models.setProvider(faux.provider);
      return models;
    },
    defaultModel: MODEL, defaultThinkingLevel: "off", defaultCwd: scratch, primeRoots: null,
    prompt: { agentDir, bundledSkillsDir: join(scratch, "no-bundled-skills") },
  });
  try {
    const thread = await threads.create({ name: "digest chat" });
    cpSync(join(fixture, "local"), threadHarnessDir(threads.fileOf(thread.id), thread.id), { recursive: true });
    const ask = async (text: string) => {
      const { submission } = await threads.submit(thread.id, { text });
      assert.equal((await threads.wait(thread.id, submission)).status, "done");
    };
    await ask("first, which gets the digest");
    const open = await openOf(threads, thread.id);
    await append(open.harness, Array.from({ length: 20 }, (_, i) => turn(`an earlier post ${i}`)).flat());
    await ask("second");
    const seen = countWholeReads(open.storage);
    const { submission } = await threads.submit(thread.id, { text: "third" });
    assert.equal((await threads.wait(thread.id, submission)).status, "done");
    assert.equal(seen.whole, 0, `the third submit and its turn read the whole context ${seen.whole} times`);
  } finally {
    await threads.shutdown();
  }
});
