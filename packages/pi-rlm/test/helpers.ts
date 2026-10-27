import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SessionManager,
  type AgentSessionRuntime,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { fauxProvider } from "@sieun-pi/pi-testkit/faux";
import { kernelPython } from "../src/core/python.ts";

/**
 * The Python the tests run kernels with: `PI_RLM_PYTHON` when set, else pi-rlm's own uv venv under the OS temp dir, built on first use.
 * It also sets `PI_RLM_PYTHON`, so every extension the test opens uses the same interpreter.
 */
export async function testPython(): Promise<string> {
  const set = process.env.PI_RLM_PYTHON;
  if (set && existsSync(set)) return set;
  const { python } = await kernelPython(join(tmpdir(), "pi-rlm-test"), []);
  process.env.PI_RLM_PYTHON = python;
  return python;
}

/** Like `pi-testkit/faux.ts` `openRuntime`, with skills on, so extension-provided Python skills load into the kernel. */
export async function openWithSkills(opts: { root: string; provider: ReturnType<typeof fauxProvider>; extensionFactories: ExtensionFactory[]; sessionFile?: string; select?: (title: string, options: string[]) => Promise<string | undefined> }): Promise<AgentSessionRuntime> {
  const cwd = join(opts.root, "ws");
  const agentDir = join(opts.root, "agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  const factories = [opts.provider.factory, ...opts.extensionFactories];
  const createRuntime = async ({ cwd, sessionManager, sessionStartEvent }: { cwd: string; sessionManager: SessionManager; sessionStartEvent?: unknown }) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      resourceLoaderOptions: { extensionFactories: factories, noPromptTemplates: true, noThemes: true, noContextFiles: true },
    });
    return { ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent } as never)), services, diagnostics: services.diagnostics };
  };
  const sessionManager = opts.sessionFile ? SessionManager.open(opts.sessionFile, join(opts.root, "sessions"), cwd) : SessionManager.create(cwd, join(opts.root, "sessions"));
  const runtime = await createAgentSessionRuntime(createRuntime as never, { cwd, agentDir, sessionManager });
  const uiContext = opts.select ? fakeUi(opts.select) : undefined;
  await runtime.session.bindExtensions({ onError: (e: unknown) => console.error("extension error", e), ...(uiContext ? { uiContext } : {}) } as never);
  const model = runtime.services.modelRuntime.getModel(opts.provider.provider, opts.provider.model);
  if (model) await runtime.session.setModel(model);
  return runtime;
}

/** A UI whose `select` the test answers; every other UI call does nothing. */
function fakeUi(select: (title: string, options: string[]) => Promise<string | undefined>): unknown {
  return new Proxy({ select, confirm: async () => false, input: async () => undefined }, {
    get: (target, key) => (key in target ? target[key as keyof typeof target] : () => undefined),
  });
}
