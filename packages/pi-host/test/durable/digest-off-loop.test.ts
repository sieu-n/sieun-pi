/**
 * The harness digest ranks every entry of the global and local stores against the turn's words. With agent factory's 1,583 entries on 11-23
 * that held pi-host's loop 134 ms to load the stores and 675 ms to rank them in a fresh process, and 140 to 210 ms warm, in one turn, at each
 * root input after a store change and at each job's first request (~/work/pi-host-stalls/g-live-lines/report.md). The ranking runs on a
 * worker thread (`digest-worker.ts`), so a 10 ms timer never runs 100 ms late while it goes, and the text is the one the loop would make.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxProvider, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type Harness } from "@earendil-works/pi-durable";
import { digestFlags, digestQueryTerms, formatDigest, HarnessDigestDoc, mergedHarnessState, nextDelivery, threadHarnessDir, type DigestDelivery } from "../../src/durable/prime-harness.ts";
import { primeModules, primePromptParts } from "../../src/durable/prime-prompt.ts";
import { DurableThreads } from "../../src/durable/threads.ts";
import { HARNESS_DIGEST_PREFIX, HARNESS_DIGEST_SUFFIX } from "../../src/durable/vendor/prime-harness.ts";
import { MODEL, textOf } from "./crash-scenario.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-host-digest-off-loop-"));
after(() => rmSync(dir, { recursive: true, force: true }));
process.env.HOME = join(dir, "home");
mkdirSync(process.env.HOME);
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";

/** The bound the stall goal sets for a cheap command is 300 ms; a 10 ms timer here may run at most 100 ms late. */
const LATE_MS = 100;
const PRIME_TOOLS = ["ipython", "search_history", "chat_board", "tell_owner", "correction_add", "poteto_mode"];
const JOB_TOOLS = ["ipython", "job_reply", "poteto_mode"];

/** A fixed word list from a seeded generator, so every run ranks the same stores. */
let seed = 7;
const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
const VOCABULARY = Array.from({ length: 6_000 }, () => Array.from({ length: 5 + Math.floor(random() * 6) }, () => String.fromCharCode(97 + Math.floor(random() * 26))).join(""));
const words = (n: number) => Array.from({ length: n }, () => VOCABULARY[Math.floor(random() * VOCABULARY.length)]).join(" ");

/** A store of `count` memories of about 80 words each, as large as the global and agent stores on 11-23. */
function writeStore(folder: string, scope: "global" | "local", count: number): void {
  const memory: Record<string, unknown> = {};
  for (let i = 0; i < count; i++) {
    const id = `${scope}_${i}`;
    memory[id] = {
      id, kind: "memory", title: words(8), content: words(80), path: `${scope}/${i}`, scope, reference: {}, arguments: {}, metadata: {},
      source: "test", created_at: "2026-11-20T00:00:00.000Z", updated_at: `2026-11-2${i % 3}T00:00:00.000Z`, version: 1,
    };
  }
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "harness_state.json"), JSON.stringify({ schema: 1, entries: { prompt: {}, memory, skill: {}, subagent: {} }, refinements: [] }));
}

/** Runs `work` with how late a 10 ms timer ran while it went. */
async function timed<T>(work: () => Promise<T>): Promise<{ value: T; lateMs: number }> {
  let lateMs = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    lateMs = Math.max(lateMs, now - last - 10);
    last = now;
  }, 10);
  try {
    const value = await work();
    lateMs = Math.max(lateMs, performance.now() - last - 10);
    return { value, lateMs };
  } finally {
    clearInterval(timer);
  }
}

test("a root input's digest of 2,300 entries never holds the loop 100 ms and is the text the loop would rank", { timeout: 300_000 }, async () => {
  const agentDir = join(dir, "root", "agent");
  writeStore(join(agentDir, "harness"), "global", 1_600);
  const requests: Message[][] = [];
  const threads = new DurableThreads({
    dir: join(agentDir, "pi-host", "durable"),
    models: () => {
      const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 0 });
      faux.setResponses(Array.from({ length: 4 }, () => ({ messages }: { messages: Message[] }) => {
        requests.push(messages.filter(m => m.role !== "system"));
        return fauxAssistantMessage("ok");
      }));
      const models = createModels();
      models.setProvider(faux.provider);
      return models;
    },
    defaultModel: MODEL, defaultThinkingLevel: "off", defaultCwd: dir, primeRoots: null,
    prompt: { agentDir, bundledSkillsDir: join(dir, "no-bundled-skills") },
  });
  try {
    // A first turn with an empty local store loads Prime's modules and the thread's files, which a live pi-host has done long before.
    await primeModules();
    const thread = await threads.create({ name: "digest" });
    const first = await threads.submit(thread.id, { text: "warm up" });
    assert.equal((await threads.wait(thread.id, first.submission)).status, "done");

    const local = threadHarnessDir(threads.fileOf(thread.id), thread.id);
    writeStore(local, "local", 700);
    const text = `the owner asks about ${words(300)}`;
    const { value: submitted, lateMs } = await timed(() => threads.submit(thread.id, { text }));
    console.log(`root digest: the timer ran at most ${Math.round(lateMs)} ms late`);
    assert.equal((await threads.wait(thread.id, submitted.submission)).status, "done");

    const sent = requests[1]!.map(message => textOf(message.content));
    const update = sent[sent.indexOf(text) - 1];
    assert.match(update ?? "", /^\[harness-digest/, "the second turn gets a digest for the changed store before its input");
    const open = await (threads as unknown as { thread(id: string): Promise<{ harness: Harness }> }).thread(thread.id);
    const deliveries = (await open.harness.snapshot(HarnessDigestDoc, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT))?.deliveries ?? [];
    assert.equal(deliveries.length, 2);
    const [before, made] = deliveries as [DigestDelivery, DigestDelivery];
    const expected = nextDelivery({
      state: mergedHarnessState(agentDir, local), flags: digestFlags(PRIME_TOOLS, []), input: [text], recent: ["warm up", "ok"], delivered: [before], after: made.after, now: made.at,
    });
    assert.deepEqual(made, expected, "the worker's update is the one the loop would make");
    assert.equal(update, made.text);
    assert.match(update, /local_\d+/, "the update names the new local entries");
    assert.ok(lateMs < LATE_MS, `a 10 ms timer ran ${Math.round(lateMs)} ms late while a root input's digest ranked 2,300 entries`);
  } finally {
    await threads.shutdown();
  }
});

test("a job prompt's harness section of 2,300 entries never holds the loop 100 ms and is the text the loop would rank", { timeout: 300_000 }, async () => {
  const agentDir = join(dir, "job", "agent");
  writeStore(join(agentDir, "harness"), "global", 1_600);
  const harnessDir = join(dir, "job", "local");
  writeStore(harnessDir, "local", 700);
  const cwd = join(dir, "job", "repo");
  mkdirSync(cwd, { recursive: true });
  const input = { agentDir, cwd, harnessDir, depth: 1, tools: "prime" as const, bundledSkillsDir: join(dir, "no-bundled-skills"), skip: new Set(["harness" as const]) };
  // Prime's modules, its loader and claude-rules load at the first prompt; a live pi-host has built many by now.
  await primePromptParts(input);
  const query = `[task from parent] ${words(300)}`;
  const { value: parts, lateMs } = await timed(() => primePromptParts({ ...input, query, skip: new Set() }));
  console.log(`job harness section: the timer ran at most ${Math.round(lateMs)} ms late`);
  const section = parts.find(part => part.key === "harness")?.text;
  const expected = formatDigest(mergedHarnessState(agentDir, harnessDir), { ...digestFlags(JOB_TOOLS, []), queryTerms: digestQueryTerms([query], []) });
  assert.equal(section, HARNESS_DIGEST_PREFIX + expected + HARNESS_DIGEST_SUFFIX, "the worker's section is the loop's");
  assert.ok(lateMs < LATE_MS, `a 10 ms timer ran ${Math.round(lateMs)} ms late while a job's harness section ranked 2,300 entries`);
});
