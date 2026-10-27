/**
 * pi-rlm: Prime Agent's RLM kernel as an upstream Pi extension.
 *
 * It registers the `ipython` tool over the vendored Prime runtime in `python/`, answers the kernel's `host_request` calls, wakes the agent
 * when a background `bash()` handle finishes, runs `rlm.spawn` children in this process as their own `AgentSession`s, and keeps the kernel's
 * namespace across compaction (the process stays up) and across a restart (a dill snapshot in the session's artifact dir).
 *
 * One pi-host loads this module once and calls the factory once per session runtime, so every piece of session state lives in `RlmSession`,
 * keyed by session id inside the factory closure.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dropKernelHandlers, kernelHandler } from "@sieun-pi/pi-family/kernel-bridge";
import { sessionArtifactDir } from "@sieun-pi/pi-family/paths";
import { dormantOf, get as registryGet, identityOf, type Identity } from "@sieun-pi/pi-family/registry";
import { bootstrapCode, parseSkillImportErrors } from "../core/bootstrap.ts";
import { ChildManager, childRecordOf, closingReason, setClosingReason, type ChildRecord, type CloseReason } from "./children.ts";
import { GoalState } from "./goal.ts";
import { createSession } from "../core/host-client.ts";
import { hostApi, HOST_SOCKET_ENV } from "@sieun-pi/pi-family/host-api";
import { Kernel, KernelBusyError, relayPaths, type CellResult, type HostRequest, type KernelOptions, type RestoreResult } from "../core/kernel.ts";
import { BASE_PROMPT, childSection, rlmSection, skillsSection } from "../core/prompt.ts";
import { kernelPython, pythonSkillOf, RLM_SKILLS, RUNTIME_SRC, type PythonSkill } from "../core/python.ts";

export { setChildLoaderOptions } from "./children.ts";

const AGENT_MESSAGE_MIME = "application/vnd.prime-agent.agent-message+json";
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const SNAPSHOT_LIMITS = { maxBytes: 256 * 1024 * 1024, maxVariableBytes: 16 * 1024 * 1024, pruneOversized: true };
const BUSY_WAIT = "Wait and preserve state";
const BUSY_KILL = "Kill kernel and restart";
const BUSY_TITLE = [
  "Interrupted Python cell is still running",
  "Ctrl+C sent an interrupt, but the previous cell has not stopped yet. A new command cannot start until it finishes.",
  "Waiting preserves the current kernel state. Killing restarts the kernel and loses in-memory variables, imports, and running tasks.",
].join("\n");
const BUSY_NO_UI =
  "The previous Python cell ignored the interrupt and is still running, so this cell did not start. Nobody can choose to wait or restart here; call ipython again later, or end the turn.";
const STILL_RUNNING = "[ipython_interrupt_pending]\nThe cell did not stop after the interrupt and is still running in the kernel. The next ipython call asks whether to wait for it or restart the kernel.";
const RESUME_TEXT = "[host-restart]\n\nThe session host restarted while you were working. Your Python kernel and its bash() jobs kept running. Continue the task.";
const KERNEL_RESET = [
  "<ipython_kernel_reset>",
  "The Python kernel was restarted after it exited. Variables, imports, async tasks, and open resources from before the restart are no longer available unless the snapshot revived them; recreate the rest before using them.",
  "</ipython_kernel_reset>",
].join("\n");

/** The env a kernel starts from: the host's env without Prime's own kernel and worker variables, which name another runtime's files. */
function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^(RLM_(?!GLOBAL_HARNESS_STATE_DIR$)|PRIME_AGENT_INTERNAL_|PRIME_AGENT_KERNEL_OWNER_PID$)/.test(k)) continue;
    env[k] = v;
  }
  return env;
}

function maxDepthFromEnv(): number {
  const n = Number(process.env.RLM_MAX_DEPTH ?? "2");
  return Number.isInteger(n) && n >= 0 ? n : 2;
}

interface Notice {
  pid: number;
  command: string;
  exitCode: number | null;
}

function noticeMessage(n: Notice) {
  return {
    customType: "async_bash_completion",
    content: `[bash-done pid:${n.pid} exit:${n.exitCode}]\n\nCommand: ${JSON.stringify(n.command)}`,
    display: true,
    details: n,
  };
}

/** Kernels run under the relay when a pi-host holds the session, so a host restart leaves them and their `bash()` jobs running. */
function useRelay(): boolean {
  return hostApi() !== undefined || process.env.PI_RLM_RELAY === "1";
}

const HOST_LISTENER = Symbol.for("sieun-pi.pi-stack.rlm.host-listener");

/** Records pi-host's close reason for each session before it disposes, once per process. */
function listenToHost(): void {
  const api = hostApi();
  const g = globalThis as unknown as Record<symbol, unknown>;
  if (!api || g[HOST_LISTENER] === api) return;
  g[HOST_LISTENER] = api;
  api.onEvent(event => {
    const e = event as { type: string; sessionId?: string; reason?: CloseReason };
    if (e.type === "closing" && e.sessionId && e.reason) setClosingReason(e.sessionId, e.reason);
  });
}

interface KernelStart {
  kernel: Kernel;
  restarted: boolean;
  reattached?: boolean;
  restore?: RestoreResult;
  skillErrors?: Record<string, string>;
}

class RlmSession {
  readonly id: string;
  readonly identity: Identity;
  readonly artifactDir: string;
  readonly agentDir: string;
  readonly goal: GoalState;
  ctx: ExtensionContext;
  pythonSkills: PythonSkill[] = [];
  kernel: Kernel | undefined;
  private starting: Promise<KernelStart> | undefined;
  private kernelStarts = 0;
  private children: ChildManager | undefined;
  private notices = new Map<number, Notice>();
  private compactRequest: { instructions?: string } | undefined;
  /** The stop reason of the run's last assistant message; an errored or aborted run gets no goal continuation. */
  lastStop: string | undefined;
  private maxDepthOverride: number | undefined;
  private disposed = false;

  constructor(
    private readonly pi: ExtensionAPI,
    ctx: ExtensionContext,
  ) {
    this.ctx = ctx;
    this.id = ctx.sessionManager.getSessionId();
    this.identity = identityOf(this.id, ctx.sessionManager.getSessionName() ?? this.id);
    this.agentDir = getAgentDir();
    this.artifactDir = sessionArtifactDir(this.id, ctx.sessionManager.getSessionFile(), this.agentDir) ?? join(tmpdir(), `pi-rlm-${this.id}`);
    this.goal = new GoalState(pi);
    this.goal.load(ctx);
  }

  get snapshotPath(): string | undefined {
    return this.ctx.sessionManager.getSessionFile() ? join(this.artifactDir, "kernel-state.dill") : undefined;
  }

  maxDepth(): number {
    return this.maxDepthOverride ?? maxDepthFromEnv();
  }

  setMaxDepth(n: number): void {
    this.maxDepthOverride = n;
  }

  childManager(): ChildManager {
    return (this.children ??= new ChildManager({
      sessionId: this.id,
      sessionName: () => this.pi.getSessionName() ?? this.identity.name,
      artifactDir: this.artifactDir,
      sessionFile: this.ctx.sessionManager.getSessionFile(),
      agentDir: this.agentDir,
      cwd: this.ctx.cwd,
      depth: this.identity.depth,
      maxDepth: () => this.maxDepth(),
      activeTools: () => this.pi.getActiveTools(),
      notify: (customType, content, details) => this.pi.sendMessage({ customType, content, display: true, details }, { triggerTurn: true, deliverAs: "steer" }),
      attributeUsage: data => this.pi.appendEntry("child_usage_attributed", data),
      changed: record => this.pi.events.emit("rlm:child", { parentId: this.id, child: record }),
    }));
  }

  /** Loads the child index from disk, so a reopened parent lists its children and the bus can wake them. */
  async restoreChildren(): Promise<void> {
    if (!existsSync(join(this.artifactDir, "rlm-children.json"))) return;
    await this.childManager().resumeInterrupted(record => relayPaths(record.sessionDir, record.sessionId).socket);
  }

  private kernelEnv(binDir: string | undefined): Record<string, string> {
    const env = baseEnv();
    const sep = process.platform === "win32" ? ";" : ":";
    env.PYTHONPATH = [RUNTIME_SRC, ...this.pythonSkills.map(s => s.src), env.PYTHONPATH].filter(Boolean).join(sep);
    env.PYTHONUNBUFFERED = "1";
    if (binDir) env.PATH = [binDir, env.PATH].filter(Boolean).join(sep);
    env.RLM_SESSION_DIR = this.artifactDir;
    env.RLM_HARNESS_STATE_DIR = join(this.artifactDir, "harness");
    env.RLM_DEPTH = String(this.identity.depth);
    env.RLM_MAX_DEPTH = String(this.maxDepth());
    env.PI_CODING_AGENT_DIR = this.agentDir;
    env.PRIME_AGENT_CODING_AGENT_DIR = this.agentDir;
    env.PRIME_AGENT_KERNEL_OWNER_PID = String(process.pid);
    return env;
  }

  ensureKernel(onProgress: (text: string) => void): Promise<KernelStart> {
    if (this.kernel?.alive && !this.starting) return Promise.resolve({ kernel: this.kernel, restarted: false });
    this.starting ??= this.startKernel(onProgress, false).then(s => s!).finally(() => (this.starting = undefined));
    return this.starting;
  }

  /** Reattaches to a kernel a previous host left under its relay, so the events it buffered, such as finished `bash()` jobs, arrive now. */
  async reattach(): Promise<void> {
    if (!useRelay() || this.kernel?.alive || this.starting || !existsSync(relayPaths(this.artifactDir, this.id).socket)) return;
    const job = this.startKernel(() => {}, true);
    this.starting = job.then(s => s ?? this.startKernel(() => {}, false).then(x => x!)).finally(() => (this.starting = undefined));
    await this.starting.catch(() => undefined);
  }

  /** What the relay sends pi-host to reopen this session's tree after a restart: the root's session file, which the host reopens from any path. */
  private wakeTarget(): string {
    let identity = this.identity;
    let id = this.id;
    for (let i = 0; i < 16 && identity.parentId; i++) {
      id = identity.parentId;
      identity = identityOf(id, id);
    }
    const file = id === this.id ? this.ctx.sessionManager.getSessionFile() : registryGet(id)?.sessionFile ?? dormantOf(id)?.sessionFile;
    return file ?? id;
  }

  private async startKernel(onProgress: (text: string) => void, attachOnly: boolean): Promise<KernelStart | undefined> {
    mkdirSync(this.artifactDir, { recursive: true });
    onProgress("Starting Python kernel...");
    const { python, binDir } = await kernelPython(this.agentDir, this.pythonSkills, onProgress);
    let kernel: Kernel | undefined;
    const options: KernelOptions = {
      python,
      cwd: this.ctx.cwd,
      env: this.kernelEnv(binDir),
      stderrLogPath: this.snapshotPath ? join(this.artifactDir, "kernel-stderr.log") : undefined,
      onHostRequest: request => this.hostRequest(request),
      interruptGraceMs: Number(process.env.PI_RLM_INTERRUPT_GRACE_MS ?? 3000),
      onExit: () => {
        if (this.kernel === kernel) this.kernel = undefined;
      },
    };
    if (useRelay()) {
      const paths = relayPaths(this.artifactDir, this.id);
      kernel = await Kernel.relay(options, { ...paths, hostSocket: hostApi()?.socketPath ?? process.env[HOST_SOCKET_ENV], wakeSession: this.wakeTarget() }, !attachOnly);
      if (!kernel) return undefined;
    } else {
      kernel = Kernel.spawn(options);
    }
    const ready = await kernel.ready;
    if (ready.reattached) {
      this.kernel = kernel;
      return { kernel, restarted: false, reattached: true };
    }
    const restarted = this.kernelStarts > 0;
    this.kernelStarts += 1;
    let restore: RestoreResult | undefined;
    if (this.snapshotPath && existsSync(this.snapshotPath)) {
      onProgress("Restoring Python state...");
      restore = await kernel.restore(this.snapshotPath);
    }
    onProgress("Preparing Python runtime...");
    const boot = await kernel.execute(bootstrapCode(this.pythonSkills.map(s => s.importName)));
    if (boot.status !== "ok") {
      await kernel.shutdown();
      throw new Error(`Failed to initialize the rlm runtime in the Python kernel:\n${boot.stderr}\n${boot.error?.traceback.join("\n") ?? ""}`);
    }
    this.kernel = kernel;
    return { kernel, restore, restarted, skillErrors: parseSkillImportErrors(boot.stdout) };
  }

  /** The "Kill kernel and restart" choice. The next `ensureKernel` starts a fresh kernel from the last snapshot. */
  async killKernel(): Promise<void> {
    const kernel = this.kernel;
    this.kernel = undefined;
    await kernel?.kill();
  }

  async snapshot(timeoutMs = 60_000): Promise<void> {
    const path = this.snapshotPath;
    const kernel = this.kernel;
    if (!path || !kernel?.alive || kernel.busy) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      kernel.snapshot(path, join(this.artifactDir, "kernel-state.json"), SNAPSHOT_LIMITS).catch(() => undefined),
      new Promise(r => (timer = setTimeout(r, timeoutMs))),
    ]);
    clearTimeout(timer);
  }

  private get interruptedPath(): string {
    return join(this.artifactDir, "rlm-interrupted.json");
  }

  /** A root the host stopped mid-run gets a `[host-restart]` message when it reopens, as children do. */
  resumeIfInterrupted(): void {
    if (!existsSync(this.interruptedPath)) return;
    let wasRunning = false;
    try {
      wasRunning = (JSON.parse(readFileSync(this.interruptedPath, "utf8")) as { wasRunning?: boolean }).wasRunning === true;
    } catch {}
    rmSync(this.interruptedPath, { force: true });
    if (wasRunning && this.identity.role === "root") this.pi.sendMessage({ customType: "rlm_resume", content: RESUME_TEXT, display: true }, { triggerTurn: true, deliverAs: "steer" });
  }

  /** One kernel `host_request`. Another extension's handler in `pi-family/kernel-bridge.ts` wins over pi-rlm's own. */
  async hostRequest(request: HostRequest): Promise<unknown> {
    const { type, ...payload } = request;
    const external = kernelHandler(this.id, type);
    if (external) return external(payload);
    switch (type) {
      case "bash.completed":
        return this.onBashCompleted({ pid: Number(payload.pid), command: String(payload.command ?? ""), exitCode: (payload.exitCode as number | null) ?? null });
      case "bash.consumed":
        this.notices.delete(Number(payload.pid));
        return {};
      case "rlm.run":
        return this.spawn(payload);
      case "rlm.list_subagents":
        return { subagents: this.childManager().all().map(r => this.childManager().row(r)) };
      case "rlm.delete_subagent":
        return { subagent: await this.childManager().delete(String(payload.target ?? "")), service_cleanup: "none" };
      case "rlm.collect": {
        const targets = Array.isArray(payload.targets) ? payload.targets.map(String) : [];
        const timeout = typeof payload.timeout_ms === "number" ? payload.timeout_ms : 0;
        return { results: await this.childManager().collect(targets, timeout) };
      }
      case "rlm.progress.note":
        return this.progressNote(String(payload.message ?? ""));
      case "rlm.find_models":
        return this.findModels(String(payload.query ?? ""), typeof payload.limit === "number" ? payload.limit : 8);
      case "rlm.create_session":
        return this.createSession(payload);
      case "goal.get":
        return this.goal.view();
      case "goal.create":
        return this.goal.create(payload);
      case "goal.complete":
        return this.goal.complete();
      case "compact.status": {
        const usage = this.ctx.getContextUsage();
        return { tokens: usage?.tokens ?? null, context_window: usage?.contextWindow ?? null, percent: usage?.percent ?? null, scheduled: this.compactRequest !== undefined };
      }
      case "compact.run": {
        if (this.ctx.sessionManager.getEntries().filter(e => e.type === "message").length < 2) return { scheduled: false, reason: "nothing to compact yet" };
        this.compactRequest = { instructions: typeof payload.instructions === "string" ? payload.instructions : undefined };
        return { scheduled: true };
      }
      case "model.info": {
        const m = this.ctx.model;
        return m ? { provider: m.provider, id: m.id, name: m.name, input: m.input, context_window: m.contextWindow } : { provider: null, id: null };
      }
      default:
        throw new Error(`pi-rlm has no handler for host request ${type}`);
    }
  }

  private onBashCompleted(n: Notice): Record<string, unknown> {
    if (this.ctx.isIdle()) this.pi.sendMessage(noticeMessage(n), { triggerTurn: true, deliverAs: "steer" });
    else this.notices.set(n.pid, n);
    return {};
  }

  /** Notices held while the agent was busy, for the next boundary. Reading a handle in a live cell removed its notice first. */
  takeNotices(): Notice[] {
    const out = [...this.notices.values()];
    this.notices.clear();
    return out;
  }

  /** Background `bash()` handles still running in the kernel, which hold a goal continuation as Prime's do. */
  async liveHandles(): Promise<number> {
    if (!this.kernel?.alive) return 0;
    const r = await this.kernel.execute('__import__("rlm.bash", fromlist=["_live_handles"])._live_handles.__len__()').catch(() => undefined);
    return r?.status === "ok" ? Number(r.result ?? 0) || 0 : 0;
  }

  /**
   * Whether the settling run gets a `[goal: continuation]`: the goal is active, the run did not end in an error or an abort, no compaction is
   * pending, and no child or background handle is still working. A child's reply or a `[bash-done]` notice starts the next run, whose settle
   * asks again.
   */
  async goalContinues(): Promise<boolean> {
    if (!this.goal.active || this.lastStop === "error" || this.lastStop === "aborted" || this.compactRequest) return false;
    if (this.children?.all().some(r => r.status === "running" || r.status === "queued")) return false;
    return (await this.liveHandles()) === 0;
  }

  takeCompactRequest(): { instructions?: string } | undefined {
    const r = this.compactRequest;
    this.compactRequest = undefined;
    return r;
  }

  private async spawn(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const prompt = payload.prompt;
    const kwargs = (payload.kwargs ?? {}) as Record<string, unknown>;
    if (typeof prompt !== "string") throw new Error("rlm.spawn prompt must be a string");
    const unknown = Object.keys(kwargs).filter(k => !["name", "model", "thinking"].includes(k));
    if (unknown.length) throw new Error(`rlm.spawn got unknown options: ${unknown.join(", ")}`);
    if (typeof kwargs.name !== "string") throw new Error("rlm.spawn needs name=");
    let model = this.ctx.model;
    if (typeof kwargs.model === "string") {
      const [provider, ...rest] = kwargs.model.split("/");
      model = this.ctx.modelRegistry.find(provider!, rest.join("/"));
      if (!model) throw new Error(`model ${kwargs.model} is not in the catalog; pick one from rlm.find_models()`);
      if (!this.ctx.modelRegistry.hasConfiguredAuth(model)) throw new Error(`model ${kwargs.model} has no configured credentials`);
    }
    if (!model) throw new Error("rlm.spawn needs a parent model or model=");
    const thinking = (typeof kwargs.thinking === "string" ? kwargs.thinking : this.pi.getThinkingLevel()) as ThinkingLevel;
    const record = this.childManager().spawn({ prompt, name: kwargs.name, model, thinking });
    return { rlm_child_id: record.id, name: record.name, session_dir: record.sessionDir, model: record.model };
  }

  private progressNote(message: string): Record<string, unknown> {
    const mine = childRecordOf(this.id);
    if (!mine) return { accepted: true };
    return mine.owner.progress(mine.record, message);
  }

  private findModels(query: string, limit: number): Record<string, unknown> {
    const q = query.trim().toLowerCase();
    const models = this.ctx.modelRegistry
      .getAvailable()
      .filter(m => !q || `${m.provider}/${m.id} ${m.name}`.toLowerCase().includes(q))
      .slice(0, Math.max(1, Math.min(limit, 50)))
      .map(m => ({ provider: m.provider, id: m.id, name: m.name, selector: `${m.provider}/${m.id}` }));
    return { models };
  }

  private async createSession(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.identity.depth !== 0) throw new Error("rlm.create_session works only from a root session at depth 0");
    const kwargs = (payload.kwargs ?? {}) as Record<string, unknown>;
    const [provider, ...rest] = typeof kwargs.model === "string" ? kwargs.model.split("/") : [this.ctx.model?.provider, this.ctx.model?.id];
    const handle = await createSession({
      prompt: String(payload.prompt ?? ""),
      name: typeof kwargs.name === "string" ? kwargs.name : undefined,
      provider: provider ?? undefined,
      model: rest.length ? rest.join("/") : undefined,
      thinking: typeof kwargs.thinking === "string" ? kwargs.thinking : this.pi.getThinkingLevel(),
      cwd: typeof kwargs.cwd === "string" ? kwargs.cwd : this.ctx.cwd,
    });
    return { ...handle };
  }

  /**
   * Closes the session's kernel. When pi-host stops, the relayed kernel and its children's kernels detach and keep running, and the relay
   * asks the next host to reopen the root. An idle unload detaches only a kernel with live `bash()` jobs. Any other close stops the kernel.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const reason = closingReason(this.id);
    const kernel = this.kernel;
    const wasRunning = !this.ctx.isIdle();
    await this.snapshot(reason === "shutdown" ? 5_000 : 60_000);
    const keep = !!kernel?.alive && kernel.relayed && (reason === "shutdown" || (reason === "idle_unload" && (await this.liveHandles()) > 0));
    await this.children?.closeAll(reason);
    if (keep && kernel) {
      if (reason === "shutdown") writeFileSync(this.interruptedPath, JSON.stringify({ wasRunning, at: Date.now() }));
      kernel.detach(reason === "shutdown" ? "now" : "on_event");
    } else {
      await kernel?.shutdown();
    }
    this.kernel = undefined;
    setClosingReason(this.id, undefined);
    dropKernelHandlers(this.id);
  }
}

function formatCell(r: CellResult): string {
  let text = r.stdout;
  if (r.stderr) text += (text ? "\n" : "") + r.stderr;
  if (r.result) text += (text ? "\n" : "") + r.result;
  if (r.status !== "ok" && r.error) text += (text ? "\n" : "") + r.error.traceback.join("\n");
  if (r.backgroundOutput) text += `${text ? "\n" : ""}[background output (unattributed)]\n${r.backgroundOutput}`;
  return text;
}

function restoreLine(r: RestoreResult): string {
  const lines = ["[python-state-restored]"];
  if (r.restored.length) lines.push(`Your Python kernel state was revived from your previous session. These names are available again: ${r.restored.join(", ")}.`);
  else lines.push("Your previous Python kernel state could not be revived; the kernel is starting fresh.");
  if (r.failed.length) lines.push(`These could not be restored and must be recreated if needed: ${r.failed.map(f => f.name).join(", ")}.`);
  return lines.join("\n");
}

export default function piRlm(pi: ExtensionAPI): void {
  const sessions = new Map<string, RlmSession>();
  const of = (ctx: ExtensionContext): RlmSession => {
    const id = ctx.sessionManager.getSessionId();
    let s = sessions.get(id);
    if (!s) {
      s = new RlmSession(pi, ctx);
      sessions.set(id, s);
    }
    s.ctx = ctx;
    return s;
  };

  pi.on("resources_discover", () => ({ skillPaths: RLM_SKILLS }));

  pi.on("session_start", async (_event, ctx) => {
    listenToHost();
    const s = of(ctx);
    await s.reattach();
    void s.restoreChildren();
    s.resumeIfInterrupted();
  });

  pi.on("before_agent_start", (event, ctx) => {
    const s = of(ctx);
    const skills: PythonSkill[] = [];
    for (const skill of event.systemPromptOptions.skills) {
      const py = pythonSkillOf(skill.name, skill.baseDir);
      if (py && !skills.some(k => k.importName === py.importName)) skills.push(py);
    }
    s.pythonSkills = skills;
    const options = event.systemPromptOptions;
    if (options.customPrompt === undefined && options.selectedTools.includes("ipython")) options.customPrompt = BASE_PROMPT;
    options.sections.rlm = rlmSection(skills);
    if (options.skills.length) options.sections.skills = skillsSection(options.skills, skills);
    if (s.identity.role === "child") {
      const parent = s.identity.parentId ? identityOf(s.identity.parentId, s.identity.parentId).name : undefined;
      event.systemPromptOptions.sections.rlm_child = childSection(parent);
    }
  });

  pi.registerTool({
    name: "ipython",
    label: "ipython",
    description:
      "Execute Python code in a persistent Python REPL. Top-level `await` is supported. Variables, imports, and loaded data persist across calls, and are revived on a best-effort basis when a session is resumed (objects that cannot be serialized are dropped and reported). Run shell commands with `bash('cmd')` / `await bash('cmd')`. Project imports, tests, scripts, CLIs, and dependency checks should run through the target project's own environment.",
    promptSnippet: "ipython - persistent Python REPL for code, state, and bash() orchestration",
    executionMode: "sequential",
    parameters: Type.Object({
      code: Type.String({ description: "Python code to execute in the persistent Python REPL. Use the target project's own environment for project imports, tests, scripts, CLIs, and dependency checks instead of direct kernel imports." }),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const s = of(ctx);
      const progress = (text: string) => onUpdate?.({ content: [{ type: "text", text }], details: { status: "starting" } });
      let start = await s.ensureKernel(progress);
      let killed = false;
      let r: CellResult;
      for (;;) {
        try {
          r = await start.kernel.execute(params.code, {
            signal,
            onStream: text => onUpdate?.({ content: [{ type: "text", text }], details: { status: "running" } }),
          });
          break;
        } catch (error) {
          if (!(error instanceof KernelBusyError) || signal?.aborted) throw error;
          const choice = ctx.hasUI ? await ctx.ui.select(BUSY_TITLE, [BUSY_WAIT, BUSY_KILL], { signal }) : undefined;
          if (choice === BUSY_WAIT) {
            progress("Waiting for Python kernel...");
            await start.kernel.idle(signal);
          } else if (choice === BUSY_KILL) {
            progress("Restarting Python kernel...");
            await s.killKernel();
            start = await s.ensureKernel(progress);
            killed = true;
          } else {
            throw new Error(BUSY_NO_UI);
          }
        }
      }
      const { restore, restarted, skillErrors } = start;
      let text = formatCell(r);
      const notes: string[] = [];
      if (restarted || killed) notes.push(KERNEL_RESET);
      if (r.stillRunning) text = `${text ? `${text}\n\n` : ""}${STILL_RUNNING}`;
      if (restore) notes.push(restoreLine(restore));
      if (skillErrors) notes.push(`[python-skills-unavailable]\n${Object.entries(skillErrors).map(([k, v]) => `- ${k}: ${v}`).join("\n")}`);
      if (notes.length) text = `${notes.join("\n\n")}${text ? `\n\n${text}` : ""}`;
      const images = r.displays.flatMap(d =>
        Object.entries(d)
          .filter(([mime, data]) => IMAGE_MIMES.has(mime) && typeof data === "string")
          .map(([mimeType, data]) => ({ type: "image" as const, data: data as string, mimeType })),
      );
      const sentAgentMessages = r.displays.filter(d => AGENT_MESSAGE_MIME in d).map(d => d[AGENT_MESSAGE_MIME]);
      return {
        content: [{ type: "text", text }, ...images],
        details: {
          durationMs: r.durationMs,
          status: r.status,
          errorEname: r.error?.ename,
          stdout: r.stdout,
          stderr: r.stderr,
          result: r.result,
          backgroundOutput: r.backgroundOutput,
          sentAgentMessages,
          kernelRestarted: restarted || killed,
          stillRunning: r.stillRunning,
          restored: restore ? { restored: restore.restored, failed: restore.failed } : undefined,
          error: r.error,
        },
        isError: r.status !== "ok",
      };
    },
  });

  pi.registerCommand("rlm-max-depth", {
    description: "Show or set RLM_MAX_DEPTH for this session's children",
    handler: async (args, ctx) => {
      const s = of(ctx);
      const n = Number(args.trim());
      if (args.trim() && Number.isInteger(n) && n >= 0) s.setMaxDepth(n);
      ctx.ui.notify(`RLM_MAX_DEPTH is ${s.maxDepth()} for this session`, "info");
    },
  });

  pi.registerCommand("goal", {
    description: "Set, show, pause, resume or clear this session's goal: /goal [--budget <tokens>] <objective>",
    handler: async (args, ctx) => {
      const s = of(ctx);
      ctx.ui.notify(s.goal.command(args), "info");
      if (s.goal.active && ctx.isIdle()) pi.sendMessage(s.goal.continuation(), { triggerTurn: true });
    },
  });

  pi.on("agent_start", (_event, ctx) => {
    of(ctx).lastStop = undefined;
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const s = of(ctx);
    const message = event.message as { stopReason?: string; errorMessage?: string; usage?: { input?: number; output?: number } };
    s.lastStop = message.stopReason;
    if (s.goal.terminal(message)) return;
    if (s.goal.account(message)) pi.sendMessage(s.goal.message("budget_limit"), { triggerTurn: true, deliverAs: "steer" });
  });

  pi.on("turn_end", (_event, ctx) => {
    const notices = of(ctx).takeNotices();
    if (!notices.length) return;
    return { entries: notices.map(n => ({ type: "custom_message" as const, ...noticeMessage(n) })), continue: true };
  });

  pi.on("agent_before_settle", async (_event, ctx) => {
    const s = of(ctx);
    const notices = s.takeNotices();
    if (notices.length) return { entries: notices.map(n => ({ type: "custom_message" as const, ...noticeMessage(n) })), continue: true };
    if (await s.goalContinues()) return { entries: [{ type: "custom_message" as const, ...s.goal.continuation() }], continue: true };
  });

  pi.on("agent_settled", (_event, ctx) => {
    const s = of(ctx);
    const request = s.takeCompactRequest();
    const flush = () => {
      for (const n of s.takeNotices()) pi.sendMessage(noticeMessage(n), { triggerTurn: true, deliverAs: "steer" });
    };
    if (!request) return flush();
    ctx.compact({
      customInstructions: request.instructions,
      onComplete: () => {
        pi.sendMessage(
          { customType: "compaction_resume", content: "[compaction-resume]\n\nThe context was compacted as you asked. Continue the task from the summary and the retained messages.", display: true },
          { triggerTurn: true, deliverAs: "steer" },
        );
        flush();
      },
      onError: error => {
        pi.sendMessage({ customType: "compaction_outcome", content: `[compaction-failed]\n\n${error.message}`, display: true }, { triggerTurn: true, deliverAs: "steer" });
        flush();
      },
    });
  });

  pi.on("agent_end", async (_event, ctx) => {
    await of(ctx).snapshot();
  });

  pi.on("session_compact", async (_event, ctx) => {
    const s = of(ctx);
    const kernel = s.kernel;
    if (!kernel?.alive) return;
    const names = await kernel.listNames().catch(() => null);
    if (names === null) return;
    const tail = names.length ? ` These names are still defined: ${names.join(", ")}.` : " You have not defined any names yet.";
    pi.sendMessage(
      { customType: "ipython_state", content: `[python-state]\n\nYour Python kernel persisted through compaction; its remaining variables, imports, and helpers are still available.${tail}`, display: false },
      { deliverAs: "nextTurn" },
    );
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const id = ctx.sessionManager.getSessionId();
    const s = sessions.get(id);
    sessions.delete(id);
    await s?.dispose();
  });
}

export type { ChildRecord };
