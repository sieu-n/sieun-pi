/**
 * A real pi-host on a temp socket for the agent relay test, with a faux model: an input `SPEAK <text>` makes the root call send_message with
 * <text>, an input `SLOW <text>` does the same after a slow stream, and anything else gets a plain answer.
 *
 *   node --import tsx components/prime-relay/test/pi-host-worker.ts <socket> <dir>    (cwd packages/, where tsx resolves)
 *
 * Prints `{"event":"ready"}` once the socket listens. The faux model comes from packages/node_modules by path, because the repo root holds
 * another pi-ai version and pi-host must see the same module it imports.
 */
import { join } from "node:path";
import { DurableCommands, DurableThreads } from "../../../packages/pi-host/src/durable/index.ts";
import { PiHost } from "../../../packages/pi-host/src/host.ts";
import { listen } from "../../../packages/pi-host/src/server.ts";
import { SEND_MESSAGE_TOOL } from "../../../packages/pi-host/src/durable/send-message.ts";

const ai = await import("../../../packages/node_modules/@earendil-works/pi-ai/dist/index.js");
const { createModels } = await import("../../../packages/node_modules/@earendil-works/pi-ai/dist/models.js");

const [socket, dir] = process.argv.slice(2);
if (!socket || !dir) throw new Error("usage: pi-host-worker.ts <socket> <dir>");
const MODEL = { provider: "anthropic", modelId: "claude-opus-5-5" };

type Content = string | { type: string; text?: string }[];
const textOf = (content: Content): string => (typeof content === "string" ? content : content.flatMap(c => (typeof c.text === "string" ? [c.text] : [])).join(""));

const respond = (transcript: { messages: { role: string; content: Content }[] }) => {
  const messages = transcript.messages;
  if (messages.at(-1)?.role === "toolResult") return ai.fauxAssistantMessage("Sent it.");
  const last = [...messages].reverse().find(m => m.role === "user");
  const text = last ? textOf(last.content) : "";
  const speak = /^(SPEAK|SLOW) (.*)$/s.exec(text.trim());
  if (!speak) return ai.fauxAssistantMessage("OK");
  const preamble = speak[1] === "SLOW" ? "Thinking this through before I answer. ".repeat(20) : "";
  return ai.fauxAssistantMessage([...(preamble ? [ai.fauxText(preamble)] : []), ai.fauxToolCall(SEND_MESSAGE_TOOL, { text: speak[2] })], { stopReason: "toolUse" });
};

function modelsFor() {
  const models = createModels();
  const faux = ai.fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 200 });
  faux.setResponses(Array.from({ length: 64 }, () => respond));
  models.setProvider(faux.provider);
  return models;
}

const log = (line: string) => process.stderr.write(`${new Date().toISOString()} ${line}\n`);
const threads = new DurableThreads({ dir: join(dir, "durable"), models: modelsFor, defaultModel: MODEL, defaultThinkingLevel: "off", defaultCwd: dir, log, primeRoots: null });
const host = new PiHost({ agentDir: join(dir, "agent"), dataDir: join(dir, "data"), extensions: [], idleUnloadMs: 0, durable: new DurableCommands(threads), log });
await listen(host, socket);
await threads.start();
process.stdout.write(`${JSON.stringify({ event: "ready" })}\n`);
process.on("SIGTERM", () => void host.shutdown().then(() => process.exit(0)));
