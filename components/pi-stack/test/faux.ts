import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createFauxCore, fauxAssistantMessage, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SessionManager,
  type AgentSessionRuntime,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";
process.env.PI_SKIP_VERSION_CHECK = "1";

export type FauxReply = string | (() => AssistantMessage);

/** A faux provider extension. Each call to `reply` queues more answers; the default answer is "faux reply". */
export function fauxProvider(provider = "faux", model = "m") {
  const core = createFauxCore({ api: `${provider}-api`, provider, tokensPerSecond: 5000, models: [{ id: model }] });
  const queue = (replies: FauxReply[]) =>
    core.setResponses(replies.map(r => (typeof r === "string" ? () => fauxAssistantMessage(r) : r)));
  queue(Array.from({ length: 500 }, () => "faux reply"));
  const factory: ExtensionFactory = pi =>
    pi.registerProvider(provider, {
      api: core.api,
      baseUrl: "http://localhost:0",
      apiKey: "faux",
      streamSimple: core.streamSimple,
      models: [{ id: model, name: model, api: core.api, reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 4000 }],
    });
  return { core, factory, provider, model, queue };
}

export interface OpenOptions {
  root: string;
  cwd?: string;
  sessionFile?: string;
  extensionFactories?: ExtensionFactory[];
  extensionPaths?: string[];
  provider?: ReturnType<typeof fauxProvider>;
}

/** Opens one in-process runtime in an isolated agent dir under `root`, with the faux provider selected. */
export async function openRuntime(opts: OpenOptions): Promise<AgentSessionRuntime> {
  const cwd = opts.cwd ?? join(opts.root, "ws");
  const agentDir = join(opts.root, "agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  const faux = opts.provider ?? fauxProvider();
  const factories = [faux.factory, ...(opts.extensionFactories ?? [])];
  const createRuntime = async ({ cwd, sessionManager, sessionStartEvent }: { cwd: string; sessionManager: SessionManager; sessionStartEvent?: unknown }) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      resourceLoaderOptions: { extensionFactories: factories, additionalExtensionPaths: opts.extensionPaths ?? [], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
    });
    return { ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent } as never)), services, diagnostics: services.diagnostics };
  };
  const sessionManager = opts.sessionFile ? SessionManager.open(opts.sessionFile, join(opts.root, "sessions"), cwd) : SessionManager.create(cwd, join(opts.root, "sessions"));
  const runtime = await createAgentSessionRuntime(createRuntime as never, { cwd, agentDir, sessionManager });
  await runtime.session.bindExtensions({ onError: (e: unknown) => console.error("extension error", e) } as never);
  const model = runtime.services.modelRuntime.getModel(faux.provider, faux.model);
  if (model) await runtime.session.setModel(model);
  return runtime;
}
