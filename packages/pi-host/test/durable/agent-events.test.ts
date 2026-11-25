/**
 * agent-events.ts: the events apps/chat reads come out of consecutive view values in the order pi-durable 1.4's
 * `watchEvents()` sent them, and a real conversation's watch sends a run's start, its entries and its end.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import { eventsBetween, watchEvents, type AgentEvent } from "../../src/durable/agent-events.ts";
import { openDurableHost } from "../../src/durable/open.ts";

const view = (live: object, entries: EntryRecord[] = []): ConversationView =>
  ({ conversation: { id: 1 }, entries, docs: { "pi.live": live } }) as unknown as ConversationView;
const entry = (id: number, role: "user" | "assistant" | "toolResult" = "user"): EntryRecord =>
  ({ id, conversationId: 1, kind: "pi.message", model: [{ role, content: [] }] }) as unknown as EntryRecord;
const types = (events: AgentEvent[]) => events.map(event => event.type);

test("a run's start comes before its entries and its end after them", () => {
  const idle = view({});
  const running = view({ run: { taskId: 5, inputs: [7], turns: 0 } }, [entry(1)]);
  assert.deepEqual(types(eventsBetween(idle, running, [entry(1)])), ["run_start", "entry_appended"]);
  const answered = view({ runFailure: undefined }, [entry(1), entry(2, "assistant")]);
  assert.deepEqual(types(eventsBetween(running, answered, [entry(2, "assistant")])), ["entry_appended", "run_end"]);
  assert.deepEqual(eventsBetween(running, answered, []).at(-1), { type: "run_end", inputs: [7] });
});

test("a run that ended and the next that started between two values give run_end, then run_start", () => {
  const first = view({ run: { taskId: 5, inputs: [7], turns: 0 } });
  const second = view({ run: { taskId: 9, inputs: [8], turns: 0 } });
  assert.deepEqual(types(eventsBetween(first, second, [])), ["run_end", "run_start"]);
  const sameRun = view({ run: { taskId: 9, inputs: [7], turns: 1 } });
  assert.deepEqual(types(eventsBetween(first, sameRun, [])), []);
});

test("a tool slot starts once it runs and ends with its result entry", () => {
  const call = { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }] };
  const asked = { ...entry(3, "assistant"), model: [call] } as unknown as EntryRecord;
  const run = { taskId: 5, inputs: [7], turns: 0 };
  const before = view({ run }, [asked]);
  const runningSlot = view({ run, tools: [{ callId: "c1", name: "bash", status: "running", taskId: 11 }] }, [asked]);
  assert.deepEqual(eventsBetween(before, runningSlot, []), [{ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } }]);
  const result = entry(4, "toolResult");
  const done = view({ run, tools: [{ callId: "c1", name: "bash", status: "done", taskId: 11, entry: 4 }] }, [asked, result]);
  assert.deepEqual(eventsBetween(runningSlot, done, [result]), [
    { type: "entry_appended", entry: result },
    { type: "tool_execution_end", toolCallId: "c1", toolName: "bash", entry: result },
  ]);
});

test("a retry's backoff starts and ends", () => {
  const run = { taskId: 5, inputs: [7], turns: 0 };
  const plain = view({ run, generation: { attempt: 1 } });
  const backoff = view({ run, generation: { attempt: 2, retry: { at: 1000, error: "overloaded" } } });
  assert.deepEqual(eventsBetween(plain, backoff, []), [{ type: "auto_retry_start", attempt: 2, at: 1000, errorMessage: "overloaded" }]);
  assert.deepEqual(eventsBetween(backoff, view({ run, generation: { attempt: 2 } }), []), [{ type: "auto_retry_end", attempt: 2 }]);
});

test("a real conversation's watch sends run_start, the input and the answer, and run_end", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-events-"));
  try {
    const faux = fauxProvider({ provider: "anthropic", models: [{ id: "claude-faux" }], tokensPerSecond: 0 });
    faux.setResponses([fauxAssistantMessage("pong")]);
    const models = createModels();
    models.setProvider(faux.provider);
    const { harness, root } = await openDurableHost({ file: join(dir, "t.sqlite"), models, model: { provider: "anthropic", modelId: "claude-faux" } }, context);
    harness.resume();
    const stream = await watchEvents(root, context);
    assert.equal(stream.snapshot.type, "snapshot");
    const seen: AgentEvent[] = [];
    let ended!: () => void;
    const done = new Promise<void>(resolve => (ended = resolve));
    stream.start(events => {
      seen.push(...events);
      if (events.some(event => event.type === "run_end")) ended();
    });
    const submission = await root.submit({ type: "input", content: "ping", requestId: "agent-events-1" }, context);
    await submission.wait(context);
    await done;
    const order = types(seen);
    assert.ok(order.indexOf("run_start") < order.lastIndexOf("entry_appended"), order.join(","));
    assert.equal(order.at(-1), "run_end", order.join(","));
    const texts = seen.flatMap(event => (event.type === "entry_appended" ? (event.entry.model ?? []).map(message => message.role) : []));
    assert.deepEqual(texts.filter(role => role !== "system"), ["user", "assistant"]);
    await stream.stop();
    await harness.close(context);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
