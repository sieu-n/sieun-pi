/**
 * A test extension: the `echo` provider answers each turn with `echo: <last user text>`. A text with "slow" waits 1.5 s first, so a test can
 * send into a busy session. A text with "boom" also throws from a timer 20 ms later, the extension timer fault of research probe P6.
 */

import { createFauxCore, fauxAssistantMessage, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

function lastUserText(context: { messages: { role: string; content: unknown }[] }): string {
  const user = [...context.messages].reverse().find(message => message.role === "user");
  if (!user) return "";
  if (typeof user.content === "string") return user.content;
  return (user.content as { type: string; text?: string }[]).map(part => part.text ?? "").join("");
}

const core = createFauxCore({ api: "echo-api", provider: "echo", tokensPerSecond: 2000, models: [{ id: "m" }] });
const reply = async (context: unknown): Promise<AssistantMessage> => {
  const text = lastUserText(context as { messages: { role: string; content: unknown }[] });
  if (text.includes("slow")) await new Promise(resolve => setTimeout(resolve, 1500));
  if (text.includes("boom")) setTimeout(() => { throw new Error("extension timer boom"); }, 20);
  return fauxAssistantMessage(`echo: ${text}`);
};
core.setResponses(Array.from({ length: 5000 }, () => reply as never));

const echo: ExtensionFactory = pi =>
  pi.registerProvider("echo", {
    api: core.api,
    baseUrl: "http://localhost:0",
    apiKey: "echo",
    streamSimple: core.streamSimple,
    models: [{ id: "m", name: "m", api: core.api, reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 4000 }],
  });

export default echo;
