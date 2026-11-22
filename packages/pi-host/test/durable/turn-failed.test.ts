/**
 * A root run that ends with no answer on an error pi-durable does not retry tells someone once (`turn-failed.ts`). On 11-22 comm thread
 * 5d50e997 failed on a 400 for a bad image media type on the owner's posts 42 and 43, and nothing told the room or anyone else.
 * 1. A comm thread's failed run on a room post writes the room line as a tell_owner call and result that reply to that post, and agent
 *    factory's work thread gets one notice, also when the report runs twice.
 * 2. A job's failed run tells its agent's work thread, with no room line.
 * 3. After the fix, `retryFailedPosts` gives the newest failed owner post one more turn, and a second call retries nothing.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxProvider, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { durableSettings } from "@sieun-pi/pi-pool/durable";
import { DurableThreads } from "../../src/durable/threads.ts";
import { failedInputs, ROOM_LINE, TURN_FAILED_VIA } from "../../src/durable/turn-failed.ts";
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
    settings: () => durableSettings({ baseDelayMs: 5, maxAgentDelayMs: 20 }),
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
    assert.deepEqual(calls.map(call => call.type === "toolCall" ? [call.name, call.arguments] : []), [["tell_owner", { text: ROOM_LINE, reply_to: "ch_abcd1234/p7" }]]);
    const results = (await models(comm.id)).flatMap(entry => entry.message?.role === "toolResult" ? [entry.message] : []);
    assert.deepEqual(results.map(result => [result.toolName, result.isError, (result.content[0] as { text: string }).text]), [["tell_owner", false, TOLD]]);

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
