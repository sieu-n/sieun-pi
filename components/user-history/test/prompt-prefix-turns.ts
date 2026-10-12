/**
 * Drives one real prime-agent chat session through every turn kind that reaches the model, with the installed sieun-pi extensions
 * (global-rules and user-history), the AGENTS.md the test put in the agent dir, and a faux provider that serializes each request with pi-ai's
 * Anthropic payload builder.
 * Started by test/prompt-prefix.test.ts in a child process with a clean env. argv: <data dir>. Writes <data dir>/requests.json: { requests, pending }.
 * Each request is the Anthropic wire payload (system, tools, messages, cache_control) labelled with the turn kind that sent it.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AuthStorage, createAgentSession, DefaultResourceLoader, type ExtensionAPI, ModelRegistry, SessionManager, SettingsManager } from "prime-agent";
import { type Context, fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai";
import { streamAnthropic } from "@earendil-works/pi-ai/anthropic";
import historyExtension from "../extension/index.ts";
import { briefNote, CHAT_BRIEF } from "../src/chat-brief.ts";
import { CHAT_BOARD_TOOL, CHAT_FLAG } from "../src/chat-guard.ts";
import { CHAT_NOTICE } from "../src/shared/chat-feed.ts";

const dataDir = process.argv[2]!;
// Loaded by URL so this package's stricter tsconfig does not type-check global-rules, which the root tsconfig owns.
const globalRules = (await import(pathToFileURL(join(import.meta.dirname, "../../global-rules/index.ts")).href) as { default: (pi: ExtensionAPI) => Promise<void> }).default;
const agentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR!;
const fauxProvider = () => registerFauxProvider({ api: "anthropic-messages", provider: "anthropic", models: [{ id: "claude-opus-5-5", reasoning: true }] });
let faux = fauxProvider();
const model = faux.getModel();

const NEW_RULE = "Brief edit: a rule another agent added while this chat ran.";
export type Request = { turn: string; payload: { system?: unknown; tools?: unknown; messages: unknown[] } };
const requests: Request[] = [];
let turn = "";
async function wire(context: Context): Promise<Request["payload"]> {
  let payload: Request["payload"] | undefined;
  await streamAnthropic(model as never, context, { apiKey: "sk-ant-oat-offline-prefix-test", cacheRetention: "long",
    onPayload(value) { payload = structuredClone(value) as Request["payload"]; throw new Error("captured before network"); } }).result();
  if (!payload) throw new Error("the Anthropic payload was not built");
  return payload;
}
type Step = (context: Context) => Promise<ReturnType<typeof fauxAssistantMessage>>;
const said = (text: string): Step => async context => { requests.push({ turn, payload: await wire(context) }); return fauxAssistantMessage(fauxText(text)); };
const board = (during?: () => void): Step => async context => {
  requests.push({ turn, payload: await wire(context) });
  during?.();
  return fauxAssistantMessage([fauxText("Reading the board."), fauxToolCall(CHAT_BOARD_TOOL, {}, { id: `toolu_${requests.length}` })], { stopReason: "toolUse" });
};

const chatExtension = (pi: ExtensionAPI) => {
  const flags = (name: string) => name === "agent-chat-data-dir" ? dataDir : name === CHAT_FLAG ? true : pi.getFlag(name);
  historyExtension(new Proxy(pi, { get: (target, key) => key === "getFlag" ? flags : Reflect.get(target, key) }));
};
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } });
// Each session gets its own loader, as each daemon session does (agent-session-services.ts), so extension state is per session.
const loader = async () => {
  const resourceLoader = new DefaultResourceLoader({ cwd: dataDir, agentDir, settingsManager, extensionFactories: [globalRules, chatExtension],
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, bundledSkillsDir: null });
  await resourceLoader.reload();
  return resourceLoader;
};
const resourceLoader = await loader();
const authStorage = AuthStorage.inMemory();
authStorage.setRuntimeApiKey("anthropic", "sk-ant-oat-offline-prefix-test");
const sessionManager = SessionManager.inMemory(dataDir);
const { session } = await createAgentSession({ cwd: dataDir, agentDir, authStorage, modelRegistry: ModelRegistry.inMemory(authStorage), model,
  resourceLoader, sessionManager, settingsManager, includeGoals: false, includeCompactSkill: false, prewarmIpythonKernel: false, telemetryDisabled: true } as never);
// The daemon binds every session it runs (daemon-extension-binding.ts), so a reload emits session_start again; an empty binding would not.
const bindings = { shutdownHandler: () => {} };
await session.bindExtensions(bindings);
const idle = async () => { await session.waitForIdle(); await new Promise(resolve => setTimeout(resolve, 50)); await session.waitForIdle(); };
// The daemon delivers a peer's message as a custom agent_message (see prime-agent createAgentSessionMessage), not as an owner message.
let messageCount = 0;
const agentMessage = (text: string) => {
  const id = `agentmsg_prefix_${++messageCount}`;
  const content = `[agent-message from child:worker]\n\n${text}`;
  return { content, options: { customMessage: { role: "custom", customType: "agent_message", content, display: true, timestamp: Date.now(),
    details: { id, message: text, from: { sessionName: "worker" }, fromRelationship: "child" } } } };
};
const wake = async (text: string) => { const { content, options } = agentMessage(text); await session.acceptAgentMessagePrompt(content, options as never); await idle(); };
const correction = (id: string, rule: string) => ({ id, at: "2026-10-12T03:00:00.000Z", chat: { id: "other", name: "other chat" }, words: "w", rule,
  enforcedBy: "brief", ref: "r", status: "active", theme: [id, "rule"], repeats: [] });

turn = "owner"; faux.setResponses([board(), said("Done.")]);
await session.prompt("Look at the board.");
turn = "agent-message wake"; faux.setResponses([said("Noted.")]);
await wake("The job finished.");
turn = "owner again"; faux.setResponses([said("Sure.")]);
await session.prompt("Thanks, what next?");
turn = "child exit notice"; faux.setResponses([said("Child noted.")]);
await session.sendCustomMessage({ customType: "rlm_child_terminal_notice", content: "[child finished] worker done.", display: true }, { triggerTurn: true }); await idle();
turn = "check-in"; faux.setResponses([said("Checked in.")]);
await session.prompt("[check-in] What changed: nothing new.");
turn = "heartbeat"; faux.setResponses([said("Heartbeat done.")]);
await session.promptHeartbeat({ id: "hb1", prompt: "Check the queue.", schedule: { expression: "every 15m" }, status: "active", runCount: 1, nextRunAt: null, lastRunAt: null } as never); await idle();
turn = "agent message mid-turn"; faux.setResponses([board(() => { const { content, options } = agentMessage("A mid-turn note.");
  void session.acceptAgentMessagePrompt(content, { ...options, streamingBehavior: "steer", queueIfBusy: true } as never); }), said("Both handled.")]);
await session.prompt("Check the board again."); await idle();
await writeFile(join(dataDir, "corrections.json"), JSON.stringify({ corrections: [correction("c1", "Written between turns.")] }));
turn = "agent-message wake after a correction"; faux.setResponses([said("Rule noted.")]);
await wake("Second report.");
turn = "owner after a correction"; faux.setResponses([said("Ok.")]);
await session.prompt("Carry on.");
// Prime saves a failed call's assistant message to the session but drops it from the context it retries with.
const rateLimited: Step = async () => fauxAssistantMessage([], { stopReason: "error", errorMessage: "429 rate_limit_error: This request would exceed your account's rate limit." });
turn = "owner after a rate-limited call"; faux.setResponses([rateLimited, board(), said("Retried.")]);
await session.prompt("Look again."); await idle();
await writeFile(join(dataDir, "corrections.json"), JSON.stringify({ corrections: [correction("c1", "Written between turns."), correction("c2", "Written after the retry.")] }));
turn = "tool calls after a correction"; faux.setResponses([board(), board(), board(), said("Three reads done.")]);
await session.prompt("Read the board three times.");
// The chat server (and its job reload) sends the daemon's reload between turns: it re-runs the extensions on the build on disk.
await session.reload();
// The reload resets pi-ai's API providers to the built-in ones; the faux one goes back in place of the real Anthropic transport.
faux = fauxProvider();
turn = "agent-message wake after a reload"; faux.setResponses([said("Reloaded.")]);
await wake("Third report.");
// A session started fresh on the same build: its system prompt and tools are what the reloaded session sends.
const freshRequests = requests.length;
const fresh = await createAgentSession({ cwd: dataDir, agentDir, authStorage, modelRegistry: ModelRegistry.inMemory(authStorage), model, resourceLoader: await loader(),
  sessionManager: SessionManager.inMemory(dataDir), settingsManager, includeGoals: false, includeCompactSkill: false, prewarmIpythonKernel: false, telemetryDisabled: true } as never);
await fresh.session.bindExtensions(bindings);
turn = "fresh session"; faux.setResponses([said("Fresh.")]);
await fresh.session.prompt("Look at the board.");
const freshRequest = requests.splice(freshRequests)[0];
// Another agent edits the chat brief while the chat runs. The chat service reloads the chat onto the new build and leaves its `[brief]`
// notice in the transcript between turns (Chats.refreshExtension).
const before = [...CHAT_BRIEF];
(CHAT_BRIEF as string[]).push(NEW_RULE);
await session.reload();
faux = fauxProvider();
const note = briefNote(before, CHAT_BRIEF);
if (note) await session.sendCustomMessage({ customType: CHAT_NOTICE, content: note, display: true });
turn = "agent-message wake after a brief change"; faux.setResponses([said("New rule noted.")]);
await wake("Fourth report.");
// A chat started after the edit, and the running chat once it compacts, carry the new brief in the system prompt.
const briefRequests = requests.length;
const freshBrief = await createAgentSession({ cwd: dataDir, agentDir, authStorage, modelRegistry: ModelRegistry.inMemory(authStorage), model, resourceLoader: await loader(),
  sessionManager: SessionManager.inMemory(dataDir), settingsManager, includeGoals: false, includeCompactSkill: false, prewarmIpythonKernel: false, telemetryDisabled: true } as never);
await freshBrief.session.bindExtensions(bindings);
turn = "fresh session after a brief change"; faux.setResponses([said("Fresh.")]);
await freshBrief.session.prompt("Look at the board.");
faux.setResponses([fauxAssistantMessage(fauxText("Summary: the chat read the board and noted four reports."))]);
await session.compact();
turn = "owner after a compaction"; faux.setResponses([said("Compacted.")]);
await session.prompt("Carry on after the compaction.");
const [freshAfterBrief, compacted] = requests.splice(briefRequests);
await writeFile(join(dataDir, "requests.json"), JSON.stringify({ requests, fresh: freshRequest, freshAfterBrief, compacted, note, rule: NEW_RULE, pending: faux.getPendingResponseCount() }));
process.exit(0);
