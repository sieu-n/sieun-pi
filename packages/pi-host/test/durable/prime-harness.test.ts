/**
 * A durable thread's harness digest is Prime's: the same bytes for the same entries, from the global store and the thread's local one, sent
 * where Prime sends it, as its own message before the input of the turn it goes with, and later as `[harness-digest update]` messages that
 * leave the earlier ones and the cached prefix in place.
 *
 * `test/fixtures/prime-harness/expected.json` is what Prime's own, unchanged refinement.ts gives for the fixture's stores, from the commit of
 * the release the daemon ran (`scripts/vendor-prime-harness.mjs`). The first test fails when pi-host's digest drifts from it, and the second
 * when the running Prime release's code is no longer the copy in `vendor/prime-harness.ts`.
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxProvider, getCurrentSystemPrompt, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import type { ContextView, EntryRecord } from "@earendil-works/pi-durable";
import { messageIdNote } from "../../../../legacy/prime/user-history/src/shared/chat-feed.ts";
import { digestFlags, mergedHarnessState, nextDelivery, placeDeliveries, threadHarnessDir, withDigests, type DigestDelivery } from "../../src/durable/prime-harness.ts";
import { withTurnWrappers } from "../../src/durable/prime-chat.ts";
import { DurableThreads } from "../../src/durable/threads.ts";
import { HARNESS_DIGEST_DELTA_PREFIX, HARNESS_DIGEST_DELTA_SUFFIX, HARNESS_DIGEST_PREFIX, HARNESS_DIGEST_SUFFIX } from "../../src/durable/vendor/prime-harness.ts";
import { MODEL, textOf } from "./crash-scenario.ts";

const fixture = join(import.meta.dirname, "../fixtures/prime-harness");
const expected = JSON.parse(readFileSync(join(fixture, "expected.json"), "utf8"));
const testCase = JSON.parse(readFileSync(join(fixture, "case.json"), "utf8")) as { input: string[]; recent: string[]; since: string };
// The box's home, for the Prime source checkout and release; the tests themselves run with an empty home.
const boxHome = homedir();
const primeRepo = join(boxHome, "work/prime-agent-fix-p8/repo");
const dir = mkdtempSync(join(tmpdir(), "pi-host-prime-harness-"));
after(() => rmSync(dir, { recursive: true, force: true }));
process.env.HOME = join(dir, "home");
mkdirSync(process.env.HOME);

const PRIME_TOOLS = ["ipython", "search_history", "chat_board", "tell_owner", "correction_add", "poteto_mode"];
const PI_TOOLS = ["read", "bash", "edit", "write"];

/** An agent dir with the fixture's global store, and the fixture's local store as thread `t`'s, whose file is `<agentDir>/pi-host/durable/threads/t.sqlite`. */
function stores(name: string, from = fixture) {
  const agentDir = join(dir, name, "agent");
  const file = join(agentDir, "pi-host", "durable", "threads", "t.sqlite");
  const local = threadHarnessDir(file, "t");
  const put = (source: string) => {
    cpSync(join(source, "global"), join(agentDir, "harness"), { recursive: true });
    cpSync(join(source, "local"), local, { recursive: true });
  };
  put(from);
  return { agentDir, file, local, put };
}

test("the digest and its update are Prime's own bytes for the same global and local entries", () => {
  const s = stores("bytes");
  assert.equal(s.local, join(s.agentDir, "pi-host", "durable", "session-artifacts", "t", "harness"));
  const flags = digestFlags(PRIME_TOOLS, [{ name: "refine" }]);
  const first = nextDelivery({ state: mergedHarnessState(s.agentDir, s.local), flags, input: testCase.input, recent: testCase.recent, delivered: [], after: 0, now: Date.parse(testCase.since) });
  assert.ok(first);
  assert.equal(first.text, HARNESS_DIGEST_PREFIX + expected.prime.digest + HARNESS_DIGEST_SUFFIX);
  assert.equal(first.stateFingerprint, expected.prime.stateFingerprint);
  assert.match(first.text, /\nmemory: 10\n/, "the two local memories count with the eight global ones");
  assert.match(first.text, /- \[local:staging_deploys\] /, "a local entry with a global entry's id keeps both");

  const pi = nextDelivery({ state: mergedHarnessState(s.agentDir, s.local), flags: digestFlags(PI_TOOLS, [{ name: "refine" }]), input: testCase.input, recent: testCase.recent, delivered: [], after: 0, now: 0 });
  assert.equal(pi?.digest, expected.pi.digest);
  assert.equal(pi?.stateFingerprint, expected.pi.stateFingerprint);

  // Unchanged stores: nothing to send.
  assert.equal(nextDelivery({ state: mergedHarnessState(s.agentDir, s.local), flags, input: ["anything else"], recent: [], delivered: [first], after: 5, now: 1 }), undefined);

  // A changed local entry, a removed global one and a new refinement: Prime's update, which names only what changed since the digest.
  s.put(join(fixture, "changed"));
  const update = nextDelivery({ state: mergedHarnessState(s.agentDir, s.local), flags, input: testCase.input, recent: testCase.recent, delivered: [first], after: 5, now: 2 });
  assert.ok(update);
  assert.equal(update.text, HARNESS_DIGEST_DELTA_PREFIX + expected.changed.delta + HARNESS_DIGEST_DELTA_SUFFIX);
  assert.equal(update.digest, expected.changed.digest);
  assert.equal(update.stateFingerprint, expected.changed.stateFingerprint);
  assert.equal(update.stacked, true);
});

const hasPrime = existsSync(join(primeRepo, ".git")) && existsSync(join(boxHome, ".local/share/prime-agent/bin/prime-agent"));
test("vendor/prime-harness.ts and expected.json are the code and output of the Prime release the daemon runs", { skip: !hasPrime && "no Prime source checkout or release on this box" }, () => {
  const script = join(import.meta.dirname, "../../../../scripts/vendor-prime-harness.mjs");
  const out = execFileSync(process.execPath, [script, "--check", "--repo", primeRepo], { encoding: "utf8", env: { ...process.env, HOME: boxHome } });
  assert.match(out, /match [0-9a-f]{40}/);
});

/** A context view of the given entries, one message each. */
function viewOf(entries: { id: number; kind: string; message: Message }[], head?: number): ContextView {
  const records = entries.map(entry => ({ id: entry.id, kind: entry.kind, conversationId: 1, model: [entry.message] }) as unknown as EntryRecord);
  return { head: head === undefined ? undefined : records.find(record => record.id === head), entries: records, contributions: records.map(record => record.model ?? []), messages: records.flatMap(record => record.model ?? []) };
}
const user = (text: string, timestamp: number): Message => ({ role: "user", content: [{ type: "text", text }], timestamp });
const assistant = (text: string, timestamp: number): Message => ({ role: "assistant", content: [{ type: "text", text }], timestamp } as unknown as Message);
const delivery = (after: number, text: string): DigestDelivery => ({ after, at: 0, text, digest: text, stateFingerprint: text });

test("a delivery goes before the first input after its anchor, waits while that input is queued, and ends at a compaction", () => {
  const view = viewOf([
    { id: 1, kind: "pi.user", message: user("first", 10) },
    { id: 2, kind: "pi.assistant", message: assistant("ok", 11) },
    { id: 3, kind: "agent.message", message: user("[job] report", 12) },
  ]);
  const placed = placeDeliveries(view, [delivery(0, "D0"), delivery(2, "D2"), delivery(3, "D3")]);
  assert.deepEqual(placed.map(p => [p.delivery.text, p.before]), [["D0", 0], ["D2", 2], ["D3", -1]]);
  const messages = withDigests(view.messages, view, [delivery(0, "D0"), delivery(2, "D2"), delivery(3, "D3")])!;
  assert.deepEqual(messages.map(m => textOf(m.content)), ["D0", "first", "ok", "D2", "[job] report"]);

  // After a compaction (entry 9) that kept entry 3, every delivery from before it is gone, even D3 whose input it kept, as Prime's rebuilt
  // context drops digest messages from before a compaction. One sent after it goes before the next input.
  const compacted = viewOf([
    { id: 9, kind: "pi.compaction", message: user("summary", 20) },
    { id: 3, kind: "agent.message", message: user("[job] report", 12) },
    { id: 10, kind: "pi.user", message: user("next", 21) },
  ], 9);
  assert.deepEqual(placeDeliveries(compacted, [delivery(0, "D0"), delivery(2, "D2"), delivery(3, "D3"), delivery(9, "D9")]).map(p => [p.delivery.text, p.before]), [["D9", 2]]);
});

test("the turn wrappers leave a digest message alone, as Prime's custom digest message, and mark the owner's input", () => {
  const view = viewOf([{ id: 1, kind: "pi.user", message: user("first", 10) }]);
  const shaped = withTurnWrappers(withDigests(view.messages, view, [delivery(0, "[harness-digest]\n\nD")])!, view);
  assert.deepEqual(shaped[0], { role: "user", content: [{ type: "text", text: "[harness-digest]\n\nD" }] });
  assert.deepEqual((shaped[1]!.content as { text: string }[]).map(part => part.text), ["first", messageIdNote(10)]);
});

test("a thread gets the digest as a message before its first input, then only an update when an entry changes, and the prefix stays", async () => {
  const s = stores("thread");
  const requests: Message[][] = [];
  const systems: string[] = [];
  const threads = new DurableThreads({
    dir: join(s.agentDir, "pi-host", "durable"),
    models: () => {
      const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 0 });
      faux.setResponses(Array.from({ length: 4 }, () => ({ messages }: { messages: Message[] }) => {
        requests.push(messages.filter(m => m.role !== "system"));
        systems.push(getCurrentSystemPrompt(messages));
        return fauxAssistantMessage("ok");
      }));
      const models = createModels();
      models.setProvider(faux.provider);
      return models;
    },
    defaultModel: MODEL,
    defaultThinkingLevel: "off",
    defaultCwd: dir,
    prompt: { agentDir: s.agentDir, bundledSkillsDir: join(dir, "no-bundled-skills") },
  });
  try {
    const thread = await threads.create({ name: "digest chat" });
    const local = threadHarnessDir(threads.fileOf(thread.id), thread.id);
    cpSync(join(fixture, "local"), local, { recursive: true });
    const ask = async (text: string) => {
      const { submission } = await threads.submit(thread.id, { text });
      assert.equal((await threads.wait(thread.id, submission)).status, "done");
    };
    const texts = (messages: Message[]) => messages.map(m => textOf(m.content));

    await ask("how do staging deploys run?");
    const [digest, input] = texts(requests[0]!);
    assert.match(digest!, /^\[harness-digest\]\n\nThe persistent memories produced across this session so far:\n\n<harness_state>\n# Continual Harness State\n/);
    assert.match(digest!, /\nmemory: 10\n/);
    assert.match(digest!, /<\/harness_state>$/);
    assert.equal(input, "how do staging deploys run?");
    assert.doesNotMatch(systems[0]!, /harness-digest|Continual Harness State/);

    await ask("second");
    assert.deepEqual(texts(requests[1]!), [digest, input, "ok", "second"], "unchanged stores send nothing new");

    // A local entry changed after the digest went out, as the kernel's rlm.harness writes it.
    const state = JSON.parse(readFileSync(join(local, "harness_state.json"), "utf8"));
    Object.assign(state.entries.memory.thread_progress, { content: "The job vendored Prime's digest code.", version: 2, updated_at: new Date(Date.now() + 1000).toISOString() });
    writeFileSync(join(local, "harness_state.json"), JSON.stringify(state));
    await ask("third");
    const third = texts(requests[2]!);
    assert.deepEqual(third.slice(0, 4), texts(requests[1]!), "the earlier digest and everything after it stay in place");
    assert.match(third[5]!, /^\[harness-digest update\]\n\n[\s\S]*- \[local:thread_progress\] .*v2\): The job vendored Prime's digest code/);
    assert.equal(third[6], "third");

    const entries = (await threads.entries(thread.id, { limit: 100 })).entries;
    assert.ok(entries.every(entry => ["pi.user", "pi.assistant", "pi.system"].includes(entry.kind)), "the digest is no entry, so the chat and its search never show it");
  } finally {
    await threads.shutdown();
  }
});
