/**
 * Context reads of a long conversation and pi-host's loop. On 11-23 comm thread 5d50e997's root held 707 entries and 19.7 MB with no
 * compaction; each request read and parsed all of them again in the digest hook, and node:sqlite read each 256-entry page in one loop turn,
 * 45 to 120 ms per page on a copy rig (~/work/pi-host-stalls/l-untracked/report.md).
 *
 * A context read must give the loop a turn between small reads and return the same pages, and the digest hook must read a request's
 * context from the range the generation task keeps, so a turn of three requests reads the whole context twice (the digest check at the
 * submit and the task's first read), not once more per request.
 */
import { strict as assert } from "node:assert";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { ROOT_CONVERSATION_ID, type Cursor, type EntryQuery, type Harness, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { threadHarnessDir } from "../../src/durable/prime-harness.ts";
import { DurableThreads } from "../../src/durable/threads.ts";
import { MODEL } from "./crash-scenario.ts";

const scratch = mkdtempSync(join(tmpdir(), "pi-host-context-reads-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";
process.env.HOME = join(scratch, "home");
mkdirSync(process.env.HOME);

/** The stall goal's bound for a cheap command is 300 ms; a 10 ms timer here may run at most 100 ms late. */
const LATE_MS = 100;
const ENTRIES = 300;
/** 300 entries of 240 KB: 72 MB, as 5d50e997's root holds entries up to 11.6 MB, and three pages of pi-durable's context scan. */
const TEXT = "The owner's post quotes a long log line again. ".repeat(5_100);
const fixture = join(import.meta.dirname, "../fixtures/prime-harness");

type OpenFile = { harness: Harness; storage: Storage };
const openOf = (threads: DurableThreads, id: string) => (threads as unknown as { thread(id: string): Promise<OpenFile> }).thread(id);

async function addEntries(harness: Harness, count: number, text: string): Promise<void> {
  await harness.commit(async tx => {
    for (let i = 0; i < count; i++) {
      await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "pi.user", model: [{ role: "user", content: `${i}: ${text}`, timestamp: 1_700_000_000_000 + i }] } as never);
    }
  }, BACKGROUND_CONTEXT);
}

test("a context read of 72 MB gives the loop a turn between small reads, and every page is the page one read gives", { timeout: 120_000 }, async () => {
  const threads = new DurableThreads({
    dir: join(scratch, "long"), defaultModel: MODEL, defaultThinkingLevel: "off", defaultCwd: scratch, primeRoots: null,
    models: () => createModels(),
  });
  try {
    const thread = await threads.create({ name: "long" });
    const { harness } = await openOf(threads, thread.id);
    await addEntries(harness, ENTRIES, TEXT);
    const conversation = (await harness.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT))!;

    let lateMs = 0;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      lateMs = Math.max(lateMs, now - last - 10);
      last = now;
    }, 10);
    const start = performance.now();
    let view;
    try {
      view = await conversation.context(BACKGROUND_CONTEXT);
      lateMs = Math.max(lateMs, performance.now() - last - 10);
    } finally {
      clearInterval(timer);
    }
    console.log(`a context read of ${view.entries.length} entries took ${Math.round(performance.now() - start)} ms; a 10 ms timer ran at most ${Math.round(lateMs)} ms late`);
    assert.equal(view.entries.length, ENTRIES);
    assert.deepEqual(view.entries.map(entry => entry.id), [...view.entries.map(entry => entry.id)].sort((a, b) => a - b));
    assert.ok(lateMs < LATE_MS, `a 10 ms timer ran ${Math.round(lateMs)} ms late while one context read parsed ${ENTRIES} entries`);

    // The same scans through a storage of the same file that reads each page in one call.
    const { storage: chunked } = await openOf(threads, thread.id);
    const raw = await openNodeSqliteStorage(threads.fileOf(thread.id));
    try {
      for (const order of ["descending", "ascending"] as const) {
        for (const limit of [31, 32, 33, 100, 256, 1000]) {
          const query: EntryQuery = { conversationId: ROOT_CONVERSATION_ID, order };
          let a: Cursor | undefined;
          let b: Cursor | undefined;
          for (let pages = 0; ; pages++) {
            const one = await raw.scanEntries(query, limit, a, BACKGROUND_CONTEXT);
            const two = await chunked.scanEntries(query, limit, b, BACKGROUND_CONTEXT);
            assert.deepEqual(two.items.map(entry => entry.id), one.items.map(entry => entry.id), `${order} page ${pages} of ${limit}`);
            assert.deepEqual(two.next, one.next, `${order} cursor after page ${pages} of ${limit}`);
            if (one.next === undefined) break;
            a = one.next;
            b = two.next;
          }
        }
      }
    } finally {
      await raw.close();
    }
  } finally {
    await threads.shutdown();
  }
});

test("a turn of three requests reads the whole context twice, however many requests its digest hook sees", { timeout: 120_000 }, async () => {
  const agentDir = join(scratch, "digest", "agent");
  cpSync(join(fixture, "global"), join(agentDir, "harness"), { recursive: true });
  const threads = new DurableThreads({
    dir: join(agentDir, "pi-host", "durable"),
    models: () => {
      const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 0 });
      faux.setResponses([
        () => fauxAssistantMessage("ok"),
        () => fauxAssistantMessage([fauxToolCall("no_such_tool", { n: 1 })], { stopReason: "toolUse" }),
        () => fauxAssistantMessage([fauxToolCall("no_such_tool", { n: 2 })], { stopReason: "toolUse" }),
        () => fauxAssistantMessage("done"),
      ]);
      const models = createModels();
      models.setProvider(faux.provider);
      return models;
    },
    defaultModel: MODEL,
    defaultThinkingLevel: "off",
    defaultCwd: scratch,
    primeRoots: null,
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
    await addEntries(open.harness, 40, "An earlier post.");

    // A whole-context read starts with a page from the newest entry down, with no head marker and no cursor (pi-durable's scanRange).
    let whole = 0;
    const scan = open.storage.scanEntries.bind(open.storage);
    open.storage.scanEntries = (query, limit, cursor, context) => {
      if (cursor === undefined && limit > 1 && query.minEntryId === undefined && query.maxEntryId !== undefined) whole++;
      return scan(query, limit, cursor, context);
    };
    await ask("second, a turn of three requests");
    console.log(`a turn of three requests read the whole context ${whole} times`);
    assert.ok(whole <= 2, `the turn read the whole context ${whole} times`);
  } finally {
    await threads.shutdown();
  }
});
