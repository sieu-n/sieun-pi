/**
 * A test extension for pi-host rigs: the `busy/m` faux model calls the `slow` tool when the newest user message asks for "busy <ms>", and
 * answers "ack" otherwise. The `slow` tool sleeps for that long, so a test can send into a busy receiver.
 */

import { createFauxCore, fauxAssistantMessage, fauxToolCall, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const core = createFauxCore({ api: "busy-api", provider: "busy", tokensPerSecond: 100_000, models: [{ id: "m" }] });

const reply = (context: { messages: { role: string; content: unknown }[] }): AssistantMessage => {
  if (core.getPendingResponseCount() < 100) refill();
  const last = context.messages[context.messages.length - 1];
  const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
  const busy = last?.role === "user" ? /busy (\d+)/.exec(text) : null;
  if (busy) return fauxAssistantMessage(fauxToolCall("slow", { ms: Number(busy[1]) }), { stopReason: "toolUse" });
  return fauxAssistantMessage("ack");
};

function refill(): void {
  core.appendResponses(Array.from({ length: 2000 }, () => reply as never));
}
refill();

const busyFixture: ExtensionFactory = pi => {
  pi.registerProvider("busy", {
    api: core.api,
    baseUrl: "http://localhost:0",
    apiKey: "busy",
    streamSimple: core.streamSimple,
    models: [{ id: "m", name: "m", api: core.api, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 4000 }],
  });
  pi.registerTool({
    name: "slow",
    label: "slow",
    description: "Sleeps for ms milliseconds.",
    parameters: Type.Object({ ms: Type.Number() }),
    async execute(_id, params) {
      await new Promise(resolve => setTimeout(resolve, (params as { ms: number }).ms));
      return { content: [{ type: "text", text: "slept" }], details: {} };
    },
  });
};

export default busyFixture;
