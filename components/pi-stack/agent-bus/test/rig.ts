import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SessionManager,
  type AgentSessionRuntime,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { assignIdentity, type Identity } from "../../shared/registry.ts";
import agentBus from "../index.ts";

process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";
process.env.PI_SKIP_VERSION_CHECK = "1";

/**
 * A faux model that calls the `slow` tool when the newest user or agent message asks for "busy <ms>", and answers "ack" otherwise.
 * A factory per call keeps it answering for as long as the test runs.
 */
function busyFaux(provider: string) {
  const core = createFauxCore({ api: `${provider}-api`, provider, tokensPerSecond: 100_000, models: [{ id: "m" }] });
  let calls = 0;
  const factory = (context: { messages: { role: string; content: unknown }[] }): AssistantMessage => {
    calls += 1;
    const last = context.messages[context.messages.length - 1];
    const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
    const busy = last && last.role === "user" ? /busy (\d+)/.exec(text) : null;
    if (busy) return fauxAssistantMessage(fauxToolCall("slow", { ms: Number(busy[1]) }), { stopReason: "toolUse" });
    return fauxAssistantMessage("ack");
  };
  const refill = () => core.setResponses(Array.from({ length: 5000 }, () => factory as never));
  refill();
  return { core, refill, calls: () => calls };
}

const slowTool: ExtensionFactory = pi =>
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

export interface Opened {
  id: string;
  runtime: AgentSessionRuntime;
  file: () => string | undefined;
}

let counter = 0;

/** Opens one session with pi-agent-bus and a `slow` tool in its own agent dir under `root`. `identity` makes it a child. */
export async function openAgent(root: string, name: string, identity?: Omit<Identity, "name">, sessionFile?: string): Promise<Opened> {
  const provider = `faux${++counter}`;
  const cwd = join(root, "ws");
  const agentDir = join(root, `agent-${provider}`);
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  const faux = busyFaux(provider);
  const fauxFactory: ExtensionFactory = pi =>
    pi.registerProvider(provider, {
      api: faux.core.api,
      baseUrl: "http://localhost:0",
      apiKey: "faux",
      streamSimple: faux.core.streamSimple,
      models: [{ id: "m", name: "m", api: faux.core.api, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 4000 }],
    });
  const factories = [fauxFactory, slowTool, agentBus];
  const sessionDir = join(root, "sessions");
  const sessionManager = sessionFile ? SessionManager.open(sessionFile, sessionDir, cwd) : SessionManager.create(cwd, sessionDir);
  const id = sessionManager.getSessionId();
  if (!sessionFile) sessionManager.appendSessionInfo(name);
  if (identity) assignIdentity(id, { name, ...identity });
  const createRuntime = async (o: { cwd: string; sessionManager: SessionManager; sessionStartEvent?: unknown }) => {
    const services = await createAgentSessionServices({
      cwd: o.cwd,
      agentDir,
      resourceLoaderOptions: { extensionFactories: factories, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
    });
    return { ...(await createAgentSessionFromServices({ services, sessionManager: o.sessionManager, sessionStartEvent: o.sessionStartEvent } as never)), services, diagnostics: services.diagnostics };
  };
  const runtime = await createAgentSessionRuntime(createRuntime as never, { cwd, agentDir, sessionManager });
  await runtime.session.bindExtensions({ onError: (e: unknown) => console.error("extension error", e) } as never);
  const model = runtime.services.modelRuntime.getModel(provider, "m");
  if (model) await runtime.session.setModel(model);
  return { id, runtime, file: () => runtime.session.sessionManager.getSessionFile() };
}

export interface Landed {
  id: string;
  message: string;
  fromName: string;
  header: string;
}

/** Every agent message in a session file, read from disk the way sieun-pi's transcript readers read it. */
export function landed(file: string | undefined): Landed[] {
  if (!file || !existsSync(file)) return [];
  const out: Landed[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line) as { type?: string; customType?: string; content?: string; details?: { id: string; message: string; from: { sessionName: string } } };
    if (e.type === "custom_message" && e.customType === "agent_message" && e.details) {
      out.push({ id: e.details.id, message: e.details.message, fromName: e.details.from.sessionName, header: String(e.content).split("\n")[0] });
    }
  }
  return out;
}

export async function until(check: () => boolean, timeoutMs = 20_000, what = "condition"): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
