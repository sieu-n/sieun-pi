/**
 * Runs a real prime-agent session with the faux provider and this extension as a marked chat, then prints what the model saw. Started by
 * test/chat-corrections.test.ts in a child process with a clean env (PRIME_AGENT_CODING_AGENT_DIR and HOME in a temp dir, no RLM_DEPTH).
 * argv: <data dir>. A correction written to the ledger between turns must reach the agent-message turn, which skips before_agent_start.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AuthStorage, createAgentSession, DefaultResourceLoader, type ExtensionAPI, ModelRegistry, SessionManager, SettingsManager } from "prime-agent";
import { type Context, fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import historyExtension from "../extension/index.ts";
import { CHAT_FLAG } from "../src/chats.ts";

const dataDir = process.argv[2]!;
const agentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR!;
const faux = registerFauxProvider({ models: [{ id: "faux-1" }] });
const firstMessages: string[] = [];
const reply = (context: Context) => {
  const first = context.messages[0];
  firstMessages.push(first && first.role === "user" && Array.isArray(first.content) && first.content[0]?.type === "text" ? first.content[0].text : "");
  return fauxAssistantMessage("ok");
};
faux.setResponses([reply, reply]);
let beforeAgentStart = 0;
const chatExtension = (pi: ExtensionAPI) => {
  const flags = (name: string) => name === "agent-chat-data-dir" ? dataDir : name === CHAT_FLAG ? true : pi.getFlag(name);
  historyExtension(new Proxy(pi, { get: (target, key) => key === "getFlag" ? flags : Reflect.get(target, key) }));
  pi.on("before_agent_start", () => { beforeAgentStart++; return undefined; });
};
const settingsManager = SettingsManager.inMemory();
const resourceLoader = new DefaultResourceLoader({ cwd: dataDir, agentDir, settingsManager, extensionFactories: [chatExtension], noExtensions: true, noSkills: true });
await resourceLoader.reload();
const authStorage = AuthStorage.inMemory();
authStorage.setRuntimeApiKey("faux", "test");
const { session } = await createAgentSession({ cwd: dataDir, agentDir, authStorage, modelRegistry: ModelRegistry.inMemory(authStorage), model: faux.getModel(),
  resourceLoader, sessionManager: SessionManager.inMemory(dataDir), settingsManager });
await session.bindExtensions({});
const tools = session.getActiveToolNames();
await session.prompt("hello");
const afterOwnerTurn = beforeAgentStart;
const entry = { id: "c1", at: "2026-10-09T13:00:00.000Z", chat: { id: "other", name: "other chat" }, words: "w", rule: "Written between turns.",
  enforcedBy: "brief", ref: "r", status: "active", theme: ["between", "turn"], repeats: [] };
await writeFile(join(dataDir, "corrections.json"), JSON.stringify({ corrections: [entry] }));
await session.acceptAgentMessagePrompt("[agent-message from worker]\n\nDone.");
const deadline = Date.now() + 20_000;
while (firstMessages.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
process.stdout.write(JSON.stringify({ tools, firstMessages, beforeAgentStart: { afterOwnerTurn, afterAgentMessage: beforeAgentStart } }) + "\n");
process.exit(0);
