/**
 * A rig extension: the `script` provider runs the tool call a user message spells out, so a check drives real tool calls through pi-host
 * without a model. A user text `TOOL {"name": "<tool>", "arguments": {...}}` gets that call, and the turn after its result ends with
 * `done`. The newest user text with such a line counts, so a harness digest after it does not hide it, the line may follow a header such as
 * a child's `[task from parent]`, and a chat's `[message id: ...]` suffix is dropped first. Any other text gets `ok: <text>`. Each request's system prompt, system sections and messages go to `$RULES_RIG_CONTEXT` as one JSON line.
 */

import { appendFileSync } from "node:fs";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type AssistantMessage } from "@earendil-works/pi-ai";

type ToolArguments = Parameters<typeof fauxToolCall>[1];
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

type Message = { role: string; content: unknown; customType?: string };
type Context = { systemPrompt?: string; messages: Message[] };

const textOf = (message: Message | undefined): string => {
  if (!message) return "";
  const sections = (message as { sections?: Record<string, string> }).sections;
  if (sections) return Object.values(sections).join("\n");
  return typeof message.content === "string" ? message.content : (message.content as { type: string; text?: string }[]).map(part => part.text ?? "").join("");
};

const TOOL_LINE = /(?:^|\n)TOOL (\{[\s\S]*\})$/;

const reply = (context: Context): AssistantMessage => {
  if (process.env.RULES_RIG_CONTEXT) {
    try {
      appendFileSync(process.env.RULES_RIG_CONTEXT, `${JSON.stringify({ at: new Date().toISOString(), systemPrompt: context.systemPrompt ?? "", messages: context.messages.map(m => ({ role: m.role, customType: m.customType, text: m.role === "system" ? textOf(m) : textOf(m).slice(0, 4000) })) })}\n`);
    } catch { /* the reply still goes out */ }
  }
  const last = context.messages.at(-1);
  if (last?.role === "toolResult") return fauxAssistantMessage([fauxText("done")]);
  const texts = context.messages.filter(m => m.role === "user").map(m => textOf(m).trim().replace(/\[message id: [^\]]*\]$/, ""));
  const text = texts.findLast(t => TOOL_LINE.test(t)) ?? texts.at(-1) ?? "";
  const match = TOOL_LINE.exec(text);
  if (match) {
    const call = JSON.parse(match[1]!) as { name: string; arguments: ToolArguments };
    return fauxAssistantMessage(fauxToolCall(call.name, call.arguments));
  }
  return fauxAssistantMessage([fauxText(`ok: ${text.slice(0, 200)}`)]);
};

const core = createFauxCore({ api: "script-api", provider: "script", tokensPerSecond: 5000, models: [{ id: "m" }] });
core.setResponses(Array.from({ length: 5000 }, () => reply as never));

const scripted: ExtensionFactory = pi =>
  pi.registerProvider("script", {
    api: core.api,
    baseUrl: "http://localhost:0",
    apiKey: "script",
    streamSimple: core.streamSimple,
    models: [{ id: "m", name: "m", api: core.api, reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 4000 }],
  });

export default scripted;
