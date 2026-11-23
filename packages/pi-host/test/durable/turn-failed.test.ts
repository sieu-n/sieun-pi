/**
 * A root run that ends with no answer on an error pi-durable does not retry tells someone once (`turn-failed.ts`). On 11-22 comm thread
 * 5d50e997 failed on a 400 for a bad image media type on the owner's posts 42 and 43, and nothing told the room or anyone else.
 * 1. A comm thread's failed run on a room post writes the room line as a tell_owner call and result that reply to that post, and agent
 *    factory's work thread gets one notice, also when the report runs twice.
 * 2. A job's failed run tells its agent's work thread, with no room line.
 * 3. After the fix, `retryFailedPosts` gives the newest failed owner post one more turn, and a second call retries nothing.
 * 4. On 11-23 agent factory's own work thread failed 11 turns in compaction and only logged "run failed with no one to tell": it now tells
 *    its DM comm thread, reads failed, and reads idle again once a root turn answers. A stop is no failure.
 * 5. A start clears the failed flag that a build before 58af9c85 wrote on a stop, which kept 20 stopped threads such as duty thread
 *    efbf242e on the Hosts page's Failed tab on 11-23.
 * 6. With no one to tell, as on a compose dev instance, the room line gives the error and names no one, and a retry that fails again
 *    posts no second line.
 * 7. A post whose run failed on "Connection error" gets its one retry at once, which answers it, and a restart retries it no more.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxProvider, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { durableSettings } from "@sieun-pi/pi-pool/durable";
import { DurableThreads } from "../../src/durable/threads.ts";
import { clearsOnItsOwn, failedInputs, rootFailed, roomLine, TURN_FAILED_VIA } from "../../src/durable/turn-failed.ts";
import { TOLD } from "../../src/durable/turn-end.ts";
import { MODEL } from "./crash-scenario.ts";

const scratch = mkdtempSync(join(tmpdir(), "pi-host-turn-failed-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const BAD_IMAGE = '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.426.content.1.image.source.base64.media_type: Input should be \'image/jpeg\', \'image/png\', \'image/gif\' or \'image/webp\'"}}';
const dir = "/tmp/agents/vent";

async function until<T>(read: () => Promise<T | undefined>, what: string): Promise<T> {
  for (let i = 0; i < 400; i++) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test("a failed comm run posts one room line in the post's thread, tells agent factory once, and its post gets one retry after the fix", async () => {
  // Each thread's faux model: the comm and job threads fail with the 400 until `fixed`, and every other answer is a plain reply.
  let fixed = false;
  const failing = new Set<string>();
  const ids: { factory?: string; work?: string } = {};
  const threads = new DurableThreads({
    dir: join(scratch, "durable"), defaultModel: MODEL, defaultThinkingLevel: "off", defaultCwd: scratch, primeRoots: null,
    models: id => {
      const models = createModels();
      const faux = fauxProvider({ provider: "anthropic", models: [{ id: MODEL.modelId }] });
      faux.setResponses(Array.from({ length: 20 }, () => () => failing.has(id) && !fixed
        ? fauxAssistantMessage([], { stopReason: "error", errorMessage: BAD_IMAGE })
        : fauxAssistantMessage("On it.")));
      models.setProvider(faux.provider);
      return models;
    },
    // The faux provider defers when asked to, and only pi-pool needs deferred waits.
    settings: () => ({ ...durableSettings({ baseDelayMs: 5, maxAgentDelayMs: 20 }), stream: {} }),
    agentWork: async (agent: string): Promise<string | undefined> => (agent === "ag_agent-factory" ? ids.factory : agent === "ag_vent" ? ids.work : undefined),
  });
  const factory = await threads.create({ name: "agent factory" });
  const work = await threads.create({ name: "vent" });
  ids.factory = factory.id;
  ids.work = work.id;
  const comm = await threads.create({ name: "vent · #relay" });
  const job = await threads.create({ name: "relay page job" });
  failing.add(comm.id).add(job.id);
  await threads.docPut(factory.id, "agent.ref", { agent: "ag_agent-factory", dir, role: "work" });
  await threads.docPut(work.id, "agent.ref", { agent: "ag_vent", dir, role: "work", comm: comm.id });
  await threads.docPut(comm.id, "agent.ref", { agent: "ag_vent", dir, role: "comm", room: "ch_abcd1234", work: work.id });
  await threads.docPut(job.id, "agent.ref", { agent: "ag_vent", dir, role: "job" });

  const models = async (id: string): Promise<{ kind: string; data?: unknown; message?: Message }[]> =>
    (await threads.entries(id, { conversation: 1, after: 0, limit: 500 })).entries.map(entry => ({ kind: entry.kind, data: entry.data, message: entry.model?.[0] as Message | undefined }));
  const notices = async (id: string) => (await models(id)).filter(entry => entry.kind === "agent.message" && (entry.data as { via?: string } | undefined)?.via === TURN_FAILED_VIA);

  try {
    const post = await threads.submit(comm.id, { text: "[#relay · post 7 from You (owner) · hops 0]\n\nhow is the relay?", requestId: `d:ch_abcd1234:p7:ag_vent` });
    const settled = await threads.wait(comm.id, post.submission);
    assert.equal(settled.status, "unanswered");
    assert.equal(settled.status === "unanswered" ? settled.reason : "", "model_error");

    const told = await until(async () => (await notices(factory.id))[0], "agent factory's notice");
    assert.match(String((told.message?.content as { text: string }[])[0]?.text), new RegExp(`turn-failed thread:${comm.id}[\\s\\S]*invalid_request_error`));
    const calls = (await models(comm.id)).flatMap(entry => entry.message?.role === "assistant" ? entry.message.content.filter(part => part.type === "toolCall") : []);
    assert.deepEqual(calls.map(call => call.type === "toolCall" ? [call.name, call.arguments] : []), [["tell_owner", { text: roomLine("agent factory", BAD_IMAGE), reply_to: "ch_abcd1234/p7" }]]);
    const results = (await models(comm.id)).flatMap(entry => entry.message?.role === "toolResult" ? [entry.message] : []);
    assert.deepEqual(results.map(result => [result.toolName, result.isError, (result.content[0] as { text: string }).text]), [["tell_owner", false, TOLD]]);
    assert.deepEqual((await models(comm.id)).filter(entry => entry.message?.role === "toolResult").map(entry => entry.kind), ["pi.tool-result"], "the result is a tool result entry, as pi-durable writes one");

    // The report runs again, as after a crash between its writes: nothing lands twice.
    const open = await threads.thread(comm.id);
    const failed = failedInputs([{ type: "submission", value: settled } as never]);
    await (threads as unknown as { reportFailure(open: unknown, failed: unknown): Promise<void> }).reportFailure(open, failed);
    assert.equal((await notices(factory.id)).length, 1);
    assert.equal((await models(comm.id)).filter(entry => entry.kind === "pi.assistant" && entry.message?.role === "assistant" && entry.message.stopReason === "toolUse").length, 1);

    const jobRun = await threads.submit(job.id, { text: "Build the relay page." });
    assert.equal((await threads.wait(job.id, jobRun.submission)).status, "unanswered");
    const jobNotice = await until(async () => (await notices(work.id))[0], "the job's notice to its agent's work thread");
    assert.match(String((jobNotice.message?.content as { text: string }[])[0]?.text), new RegExp(`turn-failed thread:${job.id}`));
    assert.equal((await models(job.id)).filter(entry => entry.message?.role === "toolResult").length, 0, "a job posts no room line");

    fixed = true;
    const retried = await threads.retryFailedPosts();
    assert.deepEqual(retried, [`${comm.id} retry:d:ch_abcd1234:p7:ag_vent`]);
    const answered = await until(async () => {
      const last = (await models(comm.id)).at(-1)?.message;
      return last?.role === "assistant" && last.stopReason === "stop" ? last : undefined;
    }, "the retried post's answer");
    assert.equal((answered.content[0] as { text: string }).text, "On it.");
    assert.deepEqual(await threads.retryFailedPosts(), [], "a post gets one retry");
  } finally {
    await threads.shutdown();
  }
});

test("with no one to tell, the room line gives the error and names no one, and a retry that fails again posts no second line", async () => {
  // A compose dev instance with no API key: no agent factory, and every run ends on the token hook's message.
  const NO_KEY = "No model credential for anthropic: set ANTHROPIC_API_KEY in .env and run docker compose up -d.";
  const threads = new DurableThreads({
    dir: join(scratch, "durable-alone"), defaultModel: MODEL, defaultThinkingLevel: "off", defaultCwd: scratch, primeRoots: null,
    models: () => {
      const models = createModels();
      const faux = fauxProvider({ provider: "anthropic", models: [{ id: MODEL.modelId }] });
      faux.setResponses(Array.from({ length: 20 }, () => () => fauxAssistantMessage([], { stopReason: "error", errorMessage: NO_KEY })));
      models.setProvider(faux.provider);
      return models;
    },
    settings: () => ({ ...durableSettings({ baseDelayMs: 5, maxAgentDelayMs: 20 }), stream: {} }),
    agentWork: async (): Promise<string | undefined> => undefined,
  });
  const work = await threads.create({ name: "walk" });
  const comm = await threads.create({ name: "walk · DM" });
  await threads.docPut(work.id, "agent.ref", { agent: "ag_walk", dir, role: "work", comm: comm.id });
  await threads.docPut(comm.id, "agent.ref", { agent: "ag_walk", dir, role: "comm", room: "dm_walk", work: work.id });
  const lines = async () => (await threads.entries(comm.id, { conversation: 1, after: 0, limit: 500 })).entries
    .flatMap(entry => { const m = entry.model?.[0] as Message | undefined; return m?.role === "assistant" ? m.content.filter(part => part.type === "toolCall") : []; })
    .map(call => (call.type === "toolCall" ? call.arguments : {}));
  try {
    const post = await threads.submit(comm.id, { text: "[DM · post 1 from You (owner)]\n\nhi", requestId: "d:p1:ag_walk" });
    assert.equal((await threads.wait(comm.id, post.submission)).status, "unanswered");
    const first = await until(async () => { const all = await lines(); return all.length ? all : undefined; }, "the room line");
    assert.deepEqual(first, [{ text: roomLine(undefined, NO_KEY), reply_to: "dm_walk/p1" }]);
    assert.doesNotMatch(String(first[0]!.text), /is told/);
    assert.match(String(first[0]!.text), /ANTHROPIC_API_KEY/);

    // A restart with nothing fixed retries the post once; the retry fails the same way and adds no line.
    const retried = await threads.retryFailedPosts();
    assert.deepEqual(retried, [`${comm.id} retry:d:p1:ag_walk`]);
    await until(async () => (await threads.list()).find(row => row.id === comm.id && row.status !== "running" && row.status !== "sleeping") ? true : undefined, "the retry to settle");
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal((await lines()).length, 1, "the room keeps one line for the post");
    assert.deepEqual(await threads.retryFailedPosts(), [], "and the post gets no third run");
  } finally {
    await threads.shutdown();
  }
});

test("a post whose run failed on an error that clears on its own gets its one retry at once, and a restart retries it no more", async () => {
  assert.equal(clearsOnItsOwn("Connection error."), true);
  assert.equal(clearsOnItsOwn("pi-pool: the anthropic service is temporarily unavailable"), true);
  assert.equal(clearsOnItsOwn(BAD_IMAGE), false);
  let calls = 0;
  const threads = new DurableThreads({
    dir: join(scratch, "durable-transient"), defaultModel: MODEL, defaultThinkingLevel: "off", defaultCwd: scratch, primeRoots: null,
    models: () => {
      const models = createModels();
      const faux = fauxProvider({ provider: "anthropic", models: [{ id: MODEL.modelId }] });
      faux.setResponses(Array.from({ length: 20 }, () => () => (calls++ === 0 ? fauxAssistantMessage([], { stopReason: "error", errorMessage: "Connection error." }) : fauxAssistantMessage("On it."))));
      models.setProvider(faux.provider);
      return models;
    },
    // pi-durable's own retry is off here, as for an error it does not call transient.
    settings: () => ({ ...durableSettings({ baseDelayMs: 5, maxAgentDelayMs: 20, maxRetries: 0 }), stream: {} }),
    agentWork: async (): Promise<string | undefined> => undefined,
  });
  const work = await threads.create({ name: "walk" });
  const comm = await threads.create({ name: "walk · DM" });
  await threads.docPut(work.id, "agent.ref", { agent: "ag_walk", dir, role: "work", comm: comm.id });
  await threads.docPut(comm.id, "agent.ref", { agent: "ag_walk", dir, role: "comm", room: "dm_walk", work: work.id });
  try {
    const post = await threads.submit(comm.id, { text: "[DM · post 2 from You (owner)]\n\nhow is the relay?", requestId: "d:p2:ag_walk" });
    assert.equal((await threads.wait(comm.id, post.submission)).status, "unanswered");
    const answered = await until(async () => {
      const last = (await threads.entries(comm.id, { conversation: 1, after: 0, limit: 500 })).entries.at(-1)?.model?.[0] as Message | undefined;
      return last?.role === "assistant" && last.stopReason === "stop" ? last : undefined;
    }, "the retried post's answer");
    assert.equal((answered.content[0] as { text: string }).text, "On it.");
    assert.deepEqual(await threads.retryFailedPosts(), [], "the post had its one retry");
  } finally {
    await threads.shutdown();
  }
});

test("agent factory's failed work thread tells its DM comm thread and reads failed until a root turn answers", async () => {
  let fixed = false;
  const ids: { factory?: string } = {};
  const threads = new DurableThreads({
    dir: join(scratch, "durable-self"), defaultModel: MODEL, defaultThinkingLevel: "off", defaultCwd: scratch, primeRoots: null,
    models: id => {
      const models = createModels();
      const faux = fauxProvider({ provider: "anthropic", models: [{ id: MODEL.modelId }] });
      faux.setResponses(Array.from({ length: 20 }, () => () => id === ids.factory && !fixed
        ? fauxAssistantMessage([], { stopReason: "error", errorMessage: "Compaction failed: Summarization hit the token limit" })
        : fauxAssistantMessage("On it.")));
      models.setProvider(faux.provider);
      return models;
    },
    settings: () => ({ ...durableSettings({ baseDelayMs: 5, maxAgentDelayMs: 20 }), stream: {} }),
    agentWork: async (agent: string): Promise<string | undefined> => (agent === "ag_agent-factory" ? ids.factory : undefined),
  });
  const factory = await threads.create({ name: "agent factory" });
  const comm = await threads.create({ name: "agent factory · DM" });
  ids.factory = factory.id;
  await threads.docPut(factory.id, "agent.ref", { agent: "ag_agent-factory", dir, role: "work", comm: comm.id });
  await threads.docPut(comm.id, "agent.ref", { agent: "ag_agent-factory", dir, role: "comm", room: "dm_agent-factory", work: factory.id });
  const texts = async (id: string) => (await threads.entries(id, { conversation: 1, after: 0, limit: 500 })).entries
    .filter(entry => entry.kind === "agent.message" && (entry.data as { via?: string } | undefined)?.via === TURN_FAILED_VIA)
    .map(entry => String(((entry.model?.[0] as Message | undefined)?.content as { text: string }[])[0]?.text));
  try {
    const run = await threads.submit(factory.id, { text: "[agent message] check the relay." });
    assert.equal((await threads.wait(factory.id, run.submission)).status, "unanswered");
    const notice = await until(async () => (await texts(comm.id))[0], "the comm thread's notice");
    assert.match(notice, new RegExp(`turn-failed thread:${factory.id}[\\s\\S]*Summarization hit the token limit[\\s\\S]*Tell the owner`));
    assert.deepEqual(await texts(factory.id), [], "the work thread does not tell itself");
    assert.equal(threads.info(factory.id).status, "failed");

    fixed = true;
    const again = await threads.submit(factory.id, { text: "[agent message] try again." });
    assert.equal((await threads.wait(factory.id, again.submission)).status, "done");
    await until(async () => (threads.info(factory.id).status === "idle" ? true : undefined), "the work thread to read idle");
  } finally {
    await threads.shutdown();
  }
});

test("a root input settled on a failure marks the thread failed, and a done, a stop or a reset does not", () => {
  const settle = (status: string, reason?: string, conversationId = 1) =>
    ({ type: "submission", value: { type: "input", conversationId, status, ...(reason ? { reason } : {}) } }) as never;
  assert.equal(rootFailed([settle("unanswered", "model_error")]), true);
  assert.equal(rootFailed([settle("unanswered", "faulted")]), true);
  assert.equal(rootFailed([settle("done"), settle("unanswered", "model_error")]), true);
  assert.equal(rootFailed([settle("unanswered", "model_error"), settle("done")]), true);
  assert.equal(rootFailed([settle("done")]), false);
  assert.equal(rootFailed([settle("unanswered", "aborted")]), false);
  assert.equal(rootFailed([settle("unanswered", "reset")]), false);
  assert.equal(rootFailed([settle("unanswered", "model_error", 2)]), undefined, "a job conversation's input is not the root's turn");
  assert.equal(rootFailed([]), undefined);
});

test("a start clears a failed flag that an older build wrote on a stop and keeps a real failure (duty thread efbf242e, 11-23)", async () => {
  const at = join(scratch, "durable-stale");
  const ids: { stopped?: string; broken?: string } = {};
  let sent = 0;
  const make = () => new DurableThreads({
    dir: at, defaultModel: MODEL, defaultThinkingLevel: "off", defaultCwd: scratch, primeRoots: null,
    models: id => {
      const models = createModels();
      const faux = fauxProvider({ provider: "anthropic", models: [{ id: MODEL.modelId }] });
      // The stopped thread's run retries a 529 until Stop, as a duty run that someone stopped; the broken one fails for good.
      faux.setResponses(Array.from({ length: 200 }, () => () => id === ids.stopped
        ? (sent++, fauxAssistantMessage([], { stopReason: "error", errorMessage: '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' }))
        : fauxAssistantMessage([], { stopReason: "error", errorMessage: BAD_IMAGE })));
      models.setProvider(faux.provider);
      return models;
    },
    settings: () => ({ ...durableSettings({ baseDelayMs: 5, maxAgentDelayMs: 20 }), stream: {} }),
  });
  const first = make();
  try {
    const stopped = await first.create({ name: "Wiki and skill facts duty" });
    const broken = await first.create({ name: "Search traffic duty" });
    ids.stopped = stopped.id;
    ids.broken = broken.id;
    const run = await first.submit(stopped.id, { text: "check the wiki facts." });
    await until(async () => (sent > 0 ? true : undefined), "the stopped thread's first model call");
    await first.abort(stopped.id);
    const settled = await first.wait(stopped.id, run.submission);
    assert.equal(settled.status === "unanswered" ? settled.reason : settled.status, "aborted");
    const bad = await first.submit(broken.id, { text: "check the search traffic." });
    assert.equal((await first.wait(broken.id, bad.submission)).status, "unanswered");
    await until(async () => (first.info(broken.id).status === "failed" ? true : undefined), "the broken thread to read failed");
    assert.equal(first.info(stopped.id).status, "idle", "this build marks no stop failed");
  } finally {
    await first.shutdown();
  }
  // What a build before 58af9c85 left on a stop: the index row reads failed while the thread file holds only the stop.
  const index = new DatabaseSync(join(at, "index.sqlite"));
  index.prepare("UPDATE threads SET failed = 1 WHERE id = ?").run(ids.stopped!);
  index.close();

  const second = make();
  try {
    await second.start();
    assert.equal(second.info(ids.stopped!).status, "idle", "the stale flag is gone after a start");
    assert.equal(second.info(ids.broken!).status, "failed", "a real failure keeps its flag");
    await second.start();
    assert.equal(second.info(ids.stopped!).status, "idle", "a second start changes nothing");
    assert.equal(second.info(ids.broken!).status, "failed");
  } finally {
    await second.shutdown();
  }
});
