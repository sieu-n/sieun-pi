/**
 * Prime's `ipython` tool and its RLM runtime in a durable thread: pi-rlm's tool definition, loaded through the adapter in
 * `pi-extensions.ts` so its text is the extension's own, run on pi-rlm's kernel (`Kernel`, the relay under a systemd scope, the bootstrap
 * cell, the Python skills) with the kernel's host requests answered from the thread file. The kernel's `RLM_HARNESS_STATE_DIR` is the
 * conversation's local harness store, which is the agent's for a thread that belongs to one (`agent-profile.ts`).
 *
 * One kernel per conversation, started at its first `ipython` call and kept across turns while pi-host runs. A kernel is snapshotted
 * (`kernel-state.dill`, pi-rlm's format) after each settled run and freed once its conversation has had no cell and no run for
 * `idleMs` and no `bash()` handle is live (owner rule c92); the next call starts a fresh kernel and revives what the snapshot holds with
 * Prime's `[python-state-restored]` line alone. pi-host's stop frees every kernel the same way. Only a kernel that ended any other way
 * (it died, or was stopped mid-cell) brings pi-rlm's `<ipython_kernel_reset>` note. A kill of pi-host leaves the relay
 * running with no client: the next process kills it before it starts that conversation's kernel, and the relay ends itself after
 * `idleMs` with no client (`PI_RLM_RELAY_TTL_S`). The cell a restart cut off is not replay-safe, so it gets pi-durable's `interrupted`.
 *
 * The family is the thread file: `rlm.spawn` commits a background `rlm.deliver` task in the parent conversation and a child
 * conversation that task owns, and returns at admission with Prime's `rlm_child_id`, `name`, `session_dir` and `model`. The task hands
 * the child its `[task from parent]` input and waits for the run to settle; when the child did not reply itself with
 * `agent_message.send(receiver_role="parent")`, it hands the parent pi-rlm's `[child-exited: no-reply child:<name>]` (or
 * `[child-failed ...]`) as an agent message input, as pi-rlm's ChildManager does. A parent's later message to a child runs the same task.
 * Request ids keep a restart from delivering anything twice. `rlm.list_subagents`, `rlm.collect`, `rlm.delete_subagent`,
 * `rlm.progress_note`, `rlm.find_models`, `rlm.create_session`, `agent_message.send` and `agent_observe.*` read and write that family,
 * with Prime's reach rule (pi-rlm `bus/family.ts`): the parent, siblings and direct children, and every thread's root a sibling of the others.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  configure, defineExtension, LiveDoc, ROOT_CONVERSATION_ID, type ConversationId, type ConversationRecord, type Extension, type Harness, type ModelRef, type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { header, endpoint, receipt, parseMode, newMessageId } from "../../../pi-rlm/src/core/bus/message.ts";
import { family, relationship, type Member, type Relationship } from "../../../pi-rlm/src/core/bus/family.ts";
import { preview as previewOf, LATEST_CHARS, FIRST_CHARS } from "../../../pi-rlm/src/core/bus/observe.ts";
import { bootstrapCode, parseSkillImportErrors } from "../../../pi-rlm/src/core/bootstrap.ts";
import { Kernel, KernelBusyError, relayPaths, type CellResult, type HostRequest, type RestoreResult } from "../../../pi-rlm/src/core/kernel.ts";
import { BUS_SKILLS, kernelPython, pythonSkillOf, RLM_SKILLS, RUNTIME_SRC, type PythonSkill } from "../../../pi-rlm/src/core/python.ts";
import { NOTE_INTERVAL_MS } from "../../../pi-rlm/src/pi/children.ts";
import piRlm, { baseEnv, BUSY_NO_UI, formatCell, KERNEL_RESET, noticeMessage, restoreLine, SNAPSHOT_LIMITS, STILL_RUNNING, type Notice } from "../../../pi-rlm/src/pi/index.ts";
import { conversationHarnessDir, threadAgent } from "./agent-profile.ts";
import { CHAT_URL_ENV, DEFAULT_CHAT_URL } from "./chat-app.ts";
import { agentIdOf, artifactDirOf, DeliverTask, RlmChildDoc, sessionOf, textOfMessage, type RlmChild } from "./children.ts";
import { durableTool, loadPiExtension, type PiTool, type PiToolResult } from "./pi-extensions.ts";
import { PrimeChatName } from "./prime-chat.ts";
import { piThreadHeader } from "./prime-roots.ts";
import { bundledSkillsDir, primeResources } from "./prime-prompt.ts";
import { SendMessage } from "./send-message.ts";
import { Subagent } from "./subagent.ts";

const context: Context = BACKGROUND_CONTEXT;
export const RLM_EXTENSION = "rlm";
export const IPYTHON_TOOL = "ipython";
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MARKER = "kernel-started";

// ---------------------------------------------------------------------------------------------------------------------------
// One thread, as the RLM runtime reaches it.

export interface RlmSubmit {
  conversation: number;
  text: string;
  requestId: string;
  whenBusy: "steer" | "followUp";
  entry: { kind: "agent.message"; data: { from: string; via: string } };
}

export interface RlmThread {
  id: string;
  file: string;
  name: () => string;
  cwd: string;
  harness: () => Harness | undefined;
  /** Admits an input to a conversation of this thread; default the conversation's own submit. pi-host passes `DurableThreads.submit`. */
  submit?: (input: RlmSubmit) => Promise<unknown>;
  /**
   * The roots Prime's reach rule makes siblings of this thread's root: the other threads' and the Prime root sessions (`prime-roots.ts`), with
   * why some are missing when a listing failed.
   */
  roots?: () => Promise<{ rows: RootRow[]; missing?: string }>;
  /** Admits an input to another root: a thread's root conversation, or a Prime root through the chat service's outbox. */
  submitRoot?: (root: RootRow, input: Omit<RlmSubmit, "conversation">) => Promise<unknown>;
  /** `rlm.create_session`: a new thread with this first input. */
  createSession?: (input: { prompt: string; name?: string; model?: ModelRef; thinking?: string; cwd: string }) => Promise<{ id: string; name: string; file: string; model: string }>;
  log?: (line: string) => void;
}

/** Another pi-host thread's root. */
export interface PiRootRow { kind: "pi"; id: string; name: string; cwd?: string; status?: string }
/**
 * A Prime root session on some box; `activeId` is its active session id, which a send may name as well. An `unlisted` root is a saved one
 * that is no chat: no roster lists it, and only its full id reaches it.
 */
export interface PrimeRootRow { kind: "prime"; id: string; activeId?: string; name: string; box: string; status: string; unlisted?: true }

const unlisted = (known: Known): boolean => known.root?.kind === "prime" && known.root.unlisted === true;
export type RootRow = PiRootRow | PrimeRootRow;

/** A member of the thread's family: a conversation of this thread, or another root, whose row says where a send to it goes. */
interface Known { member: Member; conversation?: number; thread: string; root?: RootRow }

/** A member as an error names it, with its full id and where it runs. */
function described(known: Known): string {
  const where = known.root?.kind === "prime" ? `, a Prime session on ${known.root.box}` : known.root?.kind === "pi" ? ", a pi-host thread" : "";
  return `${known.member.name} (${known.member.id}${where})`;
}

interface Start { kernel: Kernel; restarted: boolean; restore?: RestoreResult; skillErrors?: Record<string, string> }

/** One conversation's kernel and what rides on it. */
class Slot {
  kernel: Kernel | undefined;
  starting: Promise<Start> | undefined;
  /** A free in flight. A start waits for it, because the old relay listens on the socket the new kernel would attach to until it ends. */
  freeing: Promise<void> | undefined;
  /** The ipython call running now, for host requests that need its model catalog, and the children its cell spawned. */
  call: { api: ToolExecutionApi; spawned: number[] } | undefined;
  notices = new Map<number, Notice>();
  idleTimer: NodeJS.Timeout | undefined;
  lastUsed = Date.now();
  /** Set once this process killed whatever kernel a previous process left for this conversation. */
  cleared = false;
  /** The folder the kernel works in, so a thread whose cwd changed moves its kernel there before the next cell. */
  cwd: string | undefined;
  readonly session: string;
  readonly artifactDir: string;

  constructor(readonly thread: RlmThread, readonly conversation: number) {
    this.session = sessionOf(thread.id, conversation);
    this.artifactDir = artifactDirOf(thread.file, thread.id, conversation);
  }

  get snapshotPath(): string {
    return join(this.artifactDir, "kernel-state.dill");
  }
}

export interface DurableRlmOptions {
  agentDir: string;
  /** How long a kernel with no cell, no run and no live `bash()` handle is kept; pi-host passes its idle close time for thread files. */
  idleMs?: number;
  /** RLM_MAX_DEPTH; default the env's, else 2, as pi-rlm. */
  maxDepth?: number;
  /** Prime's bundled skills folder, for the Python skills the prompt lists; default `bundledSkillsDir()`. */
  bundledSkillsDir?: string;
  /** The folder whose `rlm/kernel-venv` holds the durable kernels' Python; default `<agentDir>/pi-host/durable`. `PI_RLM_PYTHON` wins. */
  venvRoot?: string;
  /** apps/chat's URL, which the board skill reads and writes this thread's board through; default `PI_HOST_CHAT_URL`, else :5184. */
  chatUrl?: string;
  log?: (line: string) => void;
}

/** pi-rlm's `ipython` as its extension registers it. */
export async function loadIpythonTool(): Promise<PiTool> {
  const loaded = await loadPiExtension(piRlm as (pi: never) => unknown);
  const tool = loaded.tools.get(IPYTHON_TOOL);
  if (!tool) throw new Error("pi-rlm registered no ipython tool");
  return tool;
}

/** Kills a relay a previous pi-host left for this socket and waits until it is gone. */
async function killLeftover(socket: string): Promise<boolean> {
  if (!existsSync(socket)) return false;
  const killed = await new Promise<boolean>(resolve => {
    const conn = createConnection(socket);
    const done = (value: boolean) => { clearTimeout(timer); conn.destroy(); resolve(value); };
    const timer = setTimeout(() => done(true), 5_000);
    conn.once("connect", () => conn.write('{"type":"relay_kill"}\n'));
    conn.once("close", () => done(true));
    conn.once("error", () => done(false));
    conn.on("data", () => {});
  });
  rmSync(socket, { force: true });
  return killed;
}

export class DurableRlm {
  private readonly slots = new Map<string, Slot>();
  private readonly idleMs: number;
  private readonly maxDepth: number;
  private skills: Promise<PythonSkill[]> | undefined;

  private constructor(readonly tool: PiTool, private readonly options: DurableRlmOptions) {
    this.idleMs = options.idleMs ?? 10 * 60_000;
    const env = Number(process.env.RLM_MAX_DEPTH ?? "2");
    this.maxDepth = options.maxDepth ?? (Number.isInteger(env) && env >= 0 ? env : 2);
  }

  static async load(options: DurableRlmOptions): Promise<DurableRlm> {
    return new DurableRlm(await loadIpythonTool(), options);
  }

  private log(line: string): void {
    this.options.log?.(`rlm: ${line}`);
  }

  /** The pi-durable extension a thread's conversations select: `ipython` with pi-rlm's definition, and the delivery task. */
  extension(thread: RlmThread): Extension {
    return defineExtension({
      name: RLM_EXTENSION,
      tools: [durableTool(this.tool, {
        session: api => ({ id: sessionOf(thread.id, api.conversationId), name: thread.name(), file: thread.file, cwd: thread.cwd }),
        execute: (params, api, ctx) => this.execute(thread, params as { code?: unknown }, api, ctx),
        details: result => result.details as JsonValue | undefined,
      })],
    });
  }

  private slot(thread: RlmThread, conversation: number): Slot {
    const key = `${thread.id}:${conversation}`;
    let slot = this.slots.get(key);
    if (!slot) {
      slot = new Slot(thread, conversation);
      this.slots.set(key, slot);
    }
    return slot;
  }

  /** Kernels running now, by `<thread>:<conversation>`, for tests and the host's log. */
  live(): string[] {
    return [...this.slots.entries()].filter(([, slot]) => slot.kernel?.alive).map(([key]) => key);
  }

  kernelPid(thread: string, conversation: number): number | undefined {
    const kernel = this.slots.get(`${thread}:${conversation}`)?.kernel;
    return kernel?.alive ? (kernel as unknown as { link?: { pid?: number } }).link?.pid : undefined;
  }

  // ---- The kernel.

  /** The Python skills the prompt lists, with pi-rlm's own copies for the ones it ships, which answer the host requests answered here. */
  private pythonSkills(cwd: string): Promise<PythonSkill[]> {
    this.skills ??= (async () => {
      const own = new Map<string, PythonSkill>();
      for (const dir of [...RLM_SKILLS, ...BUS_SKILLS]) {
        const skill = pythonSkillOf(basename(dir), dir);
        if (skill) own.set(skill.importName, skill);
      }
      const out = new Map<string, PythonSkill>();
      try {
        const resources = await primeResources(this.options.agentDir, cwd, this.options.bundledSkillsDir ?? bundledSkillsDir());
        for (const skill of resources.skills) {
          const py = pythonSkillOf(skill.name, dirname(skill.filePath));
          if (py && !out.has(py.importName)) out.set(py.importName, own.get(py.importName) ?? py);
        }
      } catch (error) {
        this.log(`skills not read: ${error instanceof Error ? error.message : String(error)}`);
      }
      for (const [name, skill] of own) if (!out.has(name)) out.set(name, skill);
      return [...out.values()];
    })();
    return this.skills;
  }

  private async ensure(slot: Slot, depth: number, progress: (text: string) => void): Promise<Start> {
    while (slot.freeing) await slot.freeing;
    if (slot.kernel?.alive && !slot.starting) return { kernel: slot.kernel, restarted: false };
    slot.starting ??= this.start(slot, depth, progress).finally(() => (slot.starting = undefined));
    return slot.starting;
  }

  private async start(slot: Slot, depth: number, progress: (text: string) => void): Promise<Start> {
    mkdirSync(slot.artifactDir, { recursive: true });
    progress("Starting Python kernel...");
    const skills = await this.pythonSkills(slot.thread.cwd);
    // A skill that needs Prime's own runtime package (attach_image) cannot be installed here; it stays importable from its folder and is
    // reported unavailable when its imports fail.
    const installable = skills.filter(skill => !readFileSync(join(skill.dir, "pyproject.toml"), "utf8").includes("prime-agent-runtime"));
    const { python, binDir } = await kernelPython(this.options.venvRoot ?? join(this.options.agentDir, "pi-host", "durable"), installable, progress);
    const paths = relayPaths(slot.artifactDir, slot.session);
    if (!slot.cleared) {
      slot.cleared = true;
      if (await killLeftover(paths.socket)) this.log(`${slot.session}: killed the kernel a previous pi-host left`);
    }
    const sep = process.platform === "win32" ? ";" : ":";
    const env = baseEnv();
    Object.assign(env, {
      PYTHONPATH: [RUNTIME_SRC, ...skills.map(s => s.src), env.PYTHONPATH].filter(Boolean).join(sep),
      PYTHONUNBUFFERED: "1",
      ...(binDir ? { PATH: [binDir, env.PATH].filter(Boolean).join(sep) } : {}),
      RLM_SESSION_DIR: slot.artifactDir,
      RLM_HARNESS_STATE_DIR: conversationHarnessDir(slot.thread, slot.conversation, await threadAgent(slot.thread.harness(), context)),
      RLM_DEPTH: String(depth),
      RLM_MAX_DEPTH: String(this.maxDepth),
      PI_CODING_AGENT_DIR: this.options.agentDir,
      PRIME_AGENT_CODING_AGENT_DIR: this.options.agentDir,
      PRIME_AGENT_KERNEL_OWNER_PID: String(process.pid),
      // A relay whose pi-host died ends itself after the idle time, so a kill frees its kernel within that time.
      PI_RLM_RELAY_TTL_S: String(Math.max(60, Math.round(this.idleMs / 1000))),
      PI_HOST_THREAD: slot.thread.id,
      PI_HOST_CONVERSATION: String(slot.conversation),
      PI_HOST_CHAT_URL: this.options.chatUrl ?? process.env[CHAT_URL_ENV] ?? DEFAULT_CHAT_URL,
    });
    const cwd = slot.thread.cwd;
    let kernel: Kernel | undefined;
    kernel = await Kernel.relay({
      python, cwd, env, stderrLogPath: join(slot.artifactDir, "kernel-stderr.log"),
      onHostRequest: request => this.hostRequest(slot, request),
      interruptGraceMs: Number(process.env.PI_RLM_INTERRUPT_GRACE_MS ?? 3000),
      onExit: () => { if (slot.kernel === kernel) slot.kernel = undefined; },
    }, { ...paths, wakeSession: "" }, true);
    if (!kernel) throw new Error(`the kernel relay for ${slot.session} did not start`);
    await kernel.ready;
    const marker = join(slot.artifactDir, MARKER);
    const restarted = existsSync(marker);
    writeFileSync(marker, `${process.pid}\n`);
    let restore: RestoreResult | undefined;
    if (existsSync(slot.snapshotPath)) {
      progress("Restoring Python state...");
      restore = await kernel.restore(slot.snapshotPath);
    }
    progress("Preparing Python runtime...");
    const boot = await kernel.execute(bootstrapCode(skills.map(s => s.importName)));
    if (boot.status !== "ok") {
      await kernel.shutdown();
      throw new Error(`Failed to initialize the rlm runtime in the Python kernel:\n${boot.stderr}\n${boot.error?.traceback.join("\n") ?? ""}`);
    }
    slot.kernel = kernel;
    slot.cwd = cwd;
    const skillErrors = parseSkillImportErrors(boot.stdout);
    return { kernel, restarted, ...(restore ? { restore } : {}), ...(skillErrors ? { skillErrors } : {}) };
  }

  /** The ipython call: pi-rlm's cell run and result text, with the thread's family behind the kernel's host requests. */
  private async execute(thread: RlmThread, params: { code?: unknown }, api: ToolExecutionApi, ctx: Context): Promise<PiToolResult> {
    const slot = this.slot(thread, api.conversationId);
    if (slot.idleTimer) clearTimeout(slot.idleTimer);
    slot.idleTimer = undefined;
    const call = { api, spawned: [] as number[] };
    slot.call = call;
    let streamed = "";
    const progress = (text: string) => api.output(`${text}\n`);
    try {
      const depth = await this.depthOf(thread, api.conversationId);
      const start = await this.ensure(slot, depth, progress);
      if (slot.cwd !== thread.cwd) {
        const moved = await start.kernel.execute(`__import__("os").chdir(${JSON.stringify(thread.cwd)})`);
        if (moved.status === "ok") slot.cwd = thread.cwd;
        else this.log(`${slot.session}: the kernel did not move to ${thread.cwd}: ${moved.error?.evalue ?? moved.stderr}`);
      }
      let r: CellResult;
      try {
        r = await start.kernel.execute(String(params.code ?? ""), {
          ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
          onStream: text => {
            if (text.startsWith(streamed) && text.length > streamed.length) api.output(text.slice(streamed.length));
            streamed = text;
          },
        });
      } catch (error) {
        if (error instanceof KernelBusyError && !ctx.abortSignal?.aborted) throw new Error(BUSY_NO_UI);
        throw error;
      }
      let text = formatCell(r);
      const notes: string[] = [];
      if (start.restarted) notes.push(KERNEL_RESET);
      if (r.stillRunning) text = `${text ? `${text}\n\n` : ""}${STILL_RUNNING}`;
      if (start.restore) notes.push(restoreLine(start.restore));
      if (start.skillErrors) notes.push(`[python-skills-unavailable]\n${Object.entries(start.skillErrors).map(([k, v]) => `- ${k}: ${v}`).join("\n")}`);
      if (notes.length) text = `${notes.join("\n\n")}${text ? `\n\n${text}` : ""}`;
      const images = r.displays.flatMap(d => Object.entries(d)
        .filter(([mime, data]) => IMAGE_MIMES.has(mime) && typeof data === "string")
        .map(([mimeType, data]) => ({ type: "image" as const, data: data as string, mimeType })));
      return {
        content: [{ type: "text", text }, ...images],
        ...(call.spawned.length ? { details: { conversationId: call.spawned[0]!, conversations: call.spawned } } : {}),
        ...(r.status !== "ok" ? { isError: true } : {}),
      };
    } finally {
      if (slot.call === call) slot.call = undefined;
      slot.lastUsed = Date.now();
      this.armIdle(slot);
    }
  }

  /** Frees a kernel that stayed unused for `idleMs`: no cell, no run of its conversation and no live `bash()` handle. */
  private armIdle(slot: Slot): void {
    if (slot.idleTimer) clearTimeout(slot.idleTimer);
    slot.idleTimer = setTimeout(() => void this.idleCheck(slot), this.idleMs);
    slot.idleTimer.unref();
  }

  private async idleCheck(slot: Slot): Promise<void> {
    slot.idleTimer = undefined;
    const kernel = slot.kernel;
    if (!kernel?.alive || slot.call || slot.starting) return;
    const busy = await this.running(slot).catch(() => false) || (await this.liveHandles(kernel)) > 0;
    if (busy) return this.armIdle(slot);
    if (slot.call) return;
    this.log(`${slot.session}: freeing the idle kernel`);
    await this.free(slot, 60_000, true);
  }

  private async running(slot: Slot): Promise<boolean> {
    const harness = slot.thread.harness();
    return Boolean(harness && (await harness.snapshot(LiveDoc, slot.conversation as ConversationId, context))?.run);
  }

  private async liveHandles(kernel: Kernel): Promise<number> {
    if (!kernel.alive || kernel.busy) return 0;
    const r = await kernel.execute('__import__("rlm.bash", fromlist=["_live_handles"])._live_handles.__len__()').catch(() => undefined);
    return r?.status === "ok" ? Number(r.result ?? 0) || 0 : 0;
  }

  private async snapshot(slot: Slot, timeoutMs: number): Promise<void> {
    const kernel = slot.kernel;
    if (!kernel?.alive || kernel.busy || slot.call) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      kernel.snapshot(slot.snapshotPath, join(slot.artifactDir, "kernel-state.json"), SNAPSHOT_LIMITS).catch(() => undefined),
      new Promise(resolve => (timer = setTimeout(resolve, timeoutMs))),
    ]);
    clearTimeout(timer);
  }

  /**
   * Snapshots and stops the kernel. Stopping an idle kernel is no exit, so the marker goes and the next start says only what the
   * snapshot revived, as Prime does after a resume. A kernel stopped mid-cell keeps the marker, and the next start sends the reset note.
   */
  private async free(slot: Slot, snapshotMs: number, onlyIdle = false): Promise<void> {
    while (slot.freeing) await slot.freeing;
    if (slot.idleTimer) clearTimeout(slot.idleTimer);
    slot.idleTimer = undefined;
    const run = async () => {
      await this.snapshot(slot, snapshotMs);
      // A cell that started while the idle free took its snapshot keeps the kernel.
      if (onlyIdle && slot.call) return;
      const kernel = slot.kernel;
      slot.kernel = undefined;
      const idle = Boolean(kernel?.alive && !kernel.busy && !slot.call);
      await kernel?.shutdown().catch(() => undefined);
      if (idle) rmSync(join(slot.artifactDir, MARKER), { force: true });
    };
    slot.freeing = run().finally(() => (slot.freeing = undefined));
    await slot.freeing;
  }

  /**
   * A run of the conversation settled: snapshot its kernel as pi-rlm does at `agent_end`, hand over the `bash()` notices held while it ran,
   * and start the idle clock. pi-host calls it from the thread's settle.
   */
  async settled(threadId: string, conversation: number): Promise<void> {
    const slot = this.slots.get(`${threadId}:${conversation}`);
    if (!slot?.kernel?.alive) return;
    await this.snapshot(slot, 60_000);
    for (const notice of [...slot.notices.values()]) await this.sendNotice(slot, notice);
    slot.notices.clear();
    this.armIdle(slot);
  }

  /** Frees every kernel of a thread whose file closes. */
  async closeThread(threadId: string, reason: string): Promise<void> {
    const slots = [...this.slots.entries()].filter(([key]) => key.startsWith(`${threadId}:`));
    await Promise.all(slots.map(async ([key, slot]) => {
      await this.free(slot, reason === "shutdown" ? 5_000 : 60_000);
      this.slots.delete(key);
    }));
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.slots.values()].map(slot => this.free(slot, 5_000)));
    this.slots.clear();
  }

  // ---- Host requests.

  private async hostRequest(slot: Slot, request: HostRequest): Promise<unknown> {
    const { type, ...payload } = request;
    switch (type) {
      case "bash.completed":
        return this.onBashCompleted(slot, { pid: Number(payload.pid), command: String(payload.command ?? ""), exitCode: (payload.exitCode as number | null) ?? null });
      case "bash.consumed":
        slot.notices.delete(Number(payload.pid));
        return {};
      case "rlm.run":
        return this.spawn(slot, payload);
      case "rlm.list_subagents":
        return { subagents: await Promise.all((await this.children(slot.thread, slot.conversation)).map(c => this.row(slot.thread, c))) };
      case "rlm.delete_subagent":
        return { subagent: await this.deleteChild(slot, String(payload.target ?? "")), service_cleanup: "none" };
      case "rlm.collect":
        return { results: await this.collect(slot, Array.isArray(payload.targets) ? payload.targets.map(String) : [], typeof payload.timeout_ms === "number" ? payload.timeout_ms : 0) };
      case "rlm.progress.note":
        return this.progressNote(slot, String(payload.message ?? ""));
      case "rlm.find_models":
        return this.findModels(slot, String(payload.query ?? ""), typeof payload.limit === "number" ? payload.limit : 8);
      case "rlm.create_session":
        return this.createSession(slot, payload);
      case "agent_message.send":
        return this.send(slot, payload);
      case "agent_observe.list":
        return this.listAgents(slot);
      case "agent_observe.get": {
        const { known, rel, isCurrent } = await this.resolve(slot, String(payload.target ?? ""));
        return { agent: await this.agentRow(slot.thread, known, isCurrent, rel) };
      }
      case "agent_observe.recent":
        return this.recent(slot, payload);
      case "compact.run": {
        const harness = this.harnessOf(slot.thread);
        const conversation = await harness.conversation(slot.conversation as ConversationId, context);
        await conversation?.compact(typeof payload.instructions === "string" ? payload.instructions : undefined, context);
        return { scheduled: Boolean(conversation) };
      }
      case "compact.status":
        return { tokens: null, context_window: null, percent: null, scheduled: false };
      case "model.info": {
        const agent = await (await this.harnessOf(slot.thread).conversation(slot.conversation as ConversationId, context))?.agent(context);
        return agent?.model ? { provider: agent.model.provider, id: agent.model.modelId } : { provider: null, id: null };
      }
      default:
        throw new Error(`${type} does not run in pi-host durable threads yet (docs/prime-pi-prompt-parity.md lists what does)`);
    }
  }

  private harnessOf(thread: RlmThread): Harness {
    const harness = thread.harness();
    if (!harness) throw new Error(`thread ${thread.id} is not open`);
    return harness;
  }

  private onBashCompleted(slot: Slot, notice: Notice): Record<string, unknown> {
    // While a cell or a run is going, the notice waits for the run to settle, so a live cell that reads the handle drops it first.
    if (slot.call) slot.notices.set(notice.pid, notice);
    else void this.running(slot).then(async busy => { if (busy) slot.notices.set(notice.pid, notice); else await this.sendNotice(slot, notice); }, () => this.sendNotice(slot, notice));
    return {};
  }

  private async sendNotice(slot: Slot, notice: Notice): Promise<void> {
    await this.submit(slot.thread, {
      conversation: slot.conversation, text: noticeMessage(notice).content, requestId: `bash-done:${slot.session}:${notice.pid}:${Date.now()}`, whenBusy: "steer",
      entry: { kind: "agent.message", data: { from: "kernel", via: "bash-done" } },
    }).catch(error => this.log(`${slot.session}: bash notice failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  private async submit(thread: RlmThread, input: RlmSubmit): Promise<unknown> {
    if (thread.submit) return thread.submit(input);
    const conversation = await this.harnessOf(thread).conversation(input.conversation as ConversationId, context);
    if (!conversation) throw new Error(`thread ${thread.id} has no conversation ${input.conversation}`);
    return conversation.submit({ type: "input", content: input.text, requestId: input.requestId, whenBusy: input.whenBusy, entry: input.entry }, context);
  }

  // ---- The family.

  private async records(thread: RlmThread): Promise<ConversationRecord[]> {
    return this.harnessOf(thread).commit(async tx => {
      const out: ConversationRecord[] = [];
      let cursor: Parameters<typeof tx.scanConversations>[2];
      do {
        const page = await tx.scanConversations({}, 500, cursor);
        out.push(...page.items);
        cursor = page.next;
      } while (cursor !== undefined);
      return out;
    }, context);
  }

  async depthOf(thread: RlmThread, conversation: number): Promise<number> {
    if (conversation === ROOT_CONVERSATION_ID) return 0;
    const parents = new Map((await this.records(thread)).map(record => [record.id as number, record.owner?.conversationId as number | undefined]));
    let depth = 0;
    for (let at: number | undefined = conversation; at !== undefined && at !== ROOT_CONVERSATION_ID && depth < 64; at = parents.get(at)) depth++;
    return depth;
  }

  /** The rlm children of a conversation that are not deleted, oldest first. */
  private async children(thread: RlmThread, conversation: number): Promise<{ id: number; doc: Readonly<RlmChild> }[]> {
    const harness = this.harnessOf(thread);
    const out: { id: number; doc: Readonly<RlmChild> }[] = [];
    for (const record of await this.records(thread)) {
      if (record.owner?.conversationId !== conversation) continue;
      const doc = await harness.snapshot(RlmChildDoc, record.id, context);
      if (doc?.id && !doc.deleted) out.push({ id: record.id, doc });
    }
    return out;
  }

  /**
   * Every member of the thread in pi-rlm's member shape, and with `roots` the other roots, which only the root conversation reaches, so a
   * child's call never waits on the Prime listing.
   */
  private async members(thread: RlmThread, roots = false): Promise<{ all: Known[]; missing?: string }> {
    const harness = this.harnessOf(thread);
    const records = await this.records(thread);
    const parents = new Map(records.map(record => [record.id as number, record.owner?.conversationId as number | undefined]));
    const depth = (id: number) => { let d = 0; for (let at: number | undefined = id; at !== undefined && at !== ROOT_CONVERSATION_ID && d < 64; at = parents.get(at)) d++; return d; };
    const out: Known[] = [];
    for (const record of records) {
      const id = record.id as number;
      if (id === ROOT_CONVERSATION_ID) {
        out.push({ member: { id: thread.id, name: thread.name(), role: "root", depth: 0 }, conversation: id, thread: thread.id });
        continue;
      }
      const doc = await harness.snapshot(RlmChildDoc, record.id, context);
      if (!doc?.id || doc.deleted) continue;
      const parent = parents.get(id);
      out.push({ member: { id: agentIdOf(thread.id, id), name: doc.name, role: "child", depth: depth(id), ...(parent !== undefined ? { parentId: agentIdOf(thread.id, parent) } : {}) }, conversation: id, thread: thread.id });
    }
    if (!roots || !thread.roots) return { all: out };
    const listed = await thread.roots();
    for (const root of listed.rows) if (root.id !== thread.id) out.push({ member: { id: root.id, name: root.name, role: "root", depth: 0 }, thread: root.id, root });
    return { all: out, ...(listed.missing ? { missing: listed.missing } : {}) };
  }

  private async self(slot: Slot): Promise<Member> {
    const { all } = await this.members(slot.thread);
    const self = all.find(m => m.thread === slot.thread.id && m.conversation === slot.conversation);
    if (!self) throw new Error(`conversation ${slot.conversation} is not an agent of thread ${slot.thread.id}`);
    return self.member;
  }

  private async spawn(slot: Slot, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const prompt = payload.prompt;
    const kwargs = (payload.kwargs ?? {}) as Record<string, unknown>;
    if (typeof prompt !== "string") throw new Error("rlm.spawn prompt must be a string");
    const unknown = Object.keys(kwargs).filter(k => !["name", "model", "thinking"].includes(k));
    if (unknown.length) throw new Error(`rlm.spawn got unknown options: ${unknown.join(", ")}`);
    if (typeof kwargs.name !== "string") throw new Error("rlm.spawn needs name=");
    const name = kwargs.name;
    if (!name.trim()) throw new Error("rlm.spawn needs a non-empty name");
    const depth = await this.depthOf(slot.thread, slot.conversation);
    if (depth >= this.maxDepth) throw new Error(`rlm.spawn refused: this session is at depth ${depth} and RLM_MAX_DEPTH is ${this.maxDepth}`);
    if ((await this.children(slot.thread, slot.conversation)).some(c => c.doc.name === name)) {
      throw new Error(`a child named ${JSON.stringify(name)} already exists; pick another name or delete it first`);
    }
    const harness = this.harnessOf(slot.thread);
    const parentAgent = await (await harness.conversation(slot.conversation as ConversationId, context))?.agent(context);
    let model: ModelRef | undefined = parentAgent?.model;
    if (typeof kwargs.model === "string") {
      const [provider, ...rest] = kwargs.model.split("/");
      const ref = { provider: provider!, modelId: rest.join("/") };
      const models = slot.call?.api.models;
      if (!ref.modelId || (models && !models.getModel(ref.provider, ref.modelId))) throw new Error(`model ${kwargs.model} is not in the catalog; pick one from rlm.find_models()`);
      model = ref;
    }
    if (!model) throw new Error("rlm.spawn needs a parent model or model=");
    const thinking = typeof kwargs.thinking === "string" ? kwargs.thinking : parentAgent?.thinkingLevel ?? "high";
    const id = `sub-${randomBytes(4).toString("hex")}`;
    const parentName = slot.conversation === ROOT_CONVERSATION_ID ? slot.thread.name() : (await harness.snapshot(RlmChildDoc, slot.conversation as ConversationId, context))?.name ?? slot.session;
    const child = await harness.commit(async tx => {
      const task = await tx.createTask(DeliverTask, {
        parent: slot.conversation, thread: slot.thread.id, name, content: `[task from parent]\n\n${prompt}`, from: agentIdOf(slot.thread.id, slot.conversation),
        via: "rlm.spawn", requestId: `rlm-task:${id}`, whenBusy: "steer",
      }, { ownership: { kind: "conversation" }, conversationId: slot.conversation as ConversationId, background: true });
      const created = await tx.createConversation({ ownership: { kind: "task", taskId: task } });
      await configure(tx, created.id, { model, thinkingLevel: thinking as ModelThinkingLevel, extensions: { remove: [Subagent, SendMessage, PrimeChatName] } });
      const doc = await tx.doc(RlmChildDoc, created.id);
      Object.assign(doc, { id, name, task: prompt, model: `${model.provider}/${model.modelId}`, thinking, sessionDir: artifactDirOf(slot.thread.file, slot.thread.id, created.id), createdAt: Date.now(), status: "running" });
      return created.id as number;
    }, context);
    slot.call?.spawned.push(child);
    this.log(`${slot.session} spawned ${name} as conversation ${child} (parent ${parentName})`);
    return { rlm_child_id: id, name, session_dir: artifactDirOf(slot.thread.file, slot.thread.id, child), model: `${model.provider}/${model.modelId}` };
  }

  private async find(slot: Slot, selector: string): Promise<{ id: number; doc: Readonly<RlmChild> }> {
    const rows = await this.children(slot.thread, slot.conversation);
    const exact = rows.find(r => r.doc.id === selector || agentIdOf(slot.thread.id, r.id) === selector || sessionOf(slot.thread.id, r.id) === selector);
    if (exact) return exact;
    const named = rows.filter(r => r.doc.name === selector);
    if (named.length === 1) return named[0]!;
    if (named.length > 1) throw new Error(`more than one child is named ${JSON.stringify(selector)}; use its rlm_child_id`);
    throw new Error(`no direct child matches ${JSON.stringify(selector)}`);
  }

  private async row(thread: RlmThread, child: { id: number; doc: Readonly<RlmChild> }): Promise<Record<string, unknown>> {
    const running = Boolean((await this.harnessOf(thread).snapshot(LiveDoc, child.id as ConversationId, context))?.run);
    const status = running ? "running" : child.doc.status === "error" ? "error" : child.doc.status === "running" ? "running" : "completed";
    return {
      rlm_child_id: child.doc.id,
      active_session_id: agentIdOf(thread.id, child.id),
      session_id: agentIdOf(thread.id, child.id),
      session_name: child.doc.name,
      session_dir: child.doc.sessionDir,
      status,
      activity: null,
      tool_use_count: null,
      duration_ms: child.doc.endedAt && !running ? child.doc.endedAt - child.doc.createdAt : Date.now() - child.doc.createdAt,
      answer_preview: child.doc.answerPreview || null,
      replied_since_task: child.doc.repliedAt > 0 && child.doc.repliedAt >= child.doc.createdAt,
      progress_note: child.doc.progressNote || null,
      last_activity_at: Math.round(Math.max(child.doc.createdAt, child.doc.endedAt, child.doc.progressAt, child.doc.repliedAt)),
    };
  }

  private async collect(slot: Slot, targets: string[], timeoutMs: number): Promise<Record<string, unknown>[]> {
    const harness = this.harnessOf(slot.thread);
    const pick = async () => (targets.length ? Promise.all(targets.map(t => this.find(slot, t))) : this.children(slot.thread, slot.conversation));
    const settled = async (c: { id: number; doc: Readonly<RlmChild> }) => !(await harness.snapshot(LiveDoc, c.id as ConversationId, context))?.run && c.doc.status !== "running";
    const deadline = Date.now() + Math.max(0, timeoutMs);
    let rows = await pick();
    while (Date.now() < deadline && !(await Promise.all(rows.map(settled))).every(Boolean)) {
      await new Promise(resolve => setTimeout(resolve, 250));
      rows = await pick();
    }
    return Promise.all(rows.map(async c => {
      const row = await this.row(slot.thread, c);
      return {
        rlm_child_id: c.doc.id, session_name: c.doc.name, session_dir: c.doc.sessionDir, status: row.status === "completed" ? c.doc.status : row.status,
        settled: await settled(c), answer_preview: c.doc.answerPreview || null, error: c.doc.error || null, duration_ms: row.duration_ms, tool_use_count: null,
        replied_since_task: row.replied_since_task,
      };
    }));
  }

  private async deleteChild(slot: Slot, selector: string): Promise<Record<string, unknown>> {
    const child = await this.find(slot, selector);
    const row = await this.row(slot.thread, child);
    const harness = this.harnessOf(slot.thread);
    await harness.commit(async tx => { Object.assign(await tx.doc(RlmChildDoc, child.id as ConversationId), { deleted: true, status: "cancelled", endedAt: Date.now() }); }, context);
    await (await harness.conversation(child.id as ConversationId, context))?.abort(context, { background: true });
    await this.closeSlot(slot.thread.id, child.id);
    return { ...row, status: "completed", active_session_id: null };
  }

  private async closeSlot(threadId: string, conversation: number): Promise<void> {
    const key = `${threadId}:${conversation}`;
    const slot = this.slots.get(key);
    if (!slot) return;
    this.slots.delete(key);
    await this.free(slot, 5_000);
  }

  private async progressNote(slot: Slot, message: string): Promise<Record<string, unknown>> {
    if (slot.conversation === ROOT_CONVERSATION_ID) return { accepted: true };
    const harness = this.harnessOf(slot.thread);
    const now = Date.now();
    return harness.commit(async tx => {
      const doc = await tx.doc(RlmChildDoc, slot.conversation as ConversationId);
      if (doc.progressAt && now - doc.progressAt < NOTE_INTERVAL_MS) return { accepted: false, retry_after_ms: NOTE_INTERVAL_MS - (now - doc.progressAt) };
      Object.assign(doc, { progressNote: message, progressAt: now });
      return { accepted: true };
    }, context);
  }

  private async findModels(slot: Slot, query: string, limit: number): Promise<Record<string, unknown>> {
    const models = slot.call?.api.models;
    if (!models) throw new Error("rlm.find_models works only inside an ipython cell");
    const q = query.trim().toLowerCase();
    const available = await models.getAvailable().catch(() => models.getModels());
    return {
      models: available.filter(m => !q || `${m.provider}/${m.id} ${m.name}`.toLowerCase().includes(q)).slice(0, Math.max(1, Math.min(limit, 50)))
        .map(m => ({ provider: m.provider, id: m.id, name: m.name, selector: `${m.provider}/${m.id}` })),
    };
  }

  private async createSession(slot: Slot, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (slot.conversation !== ROOT_CONVERSATION_ID) throw new Error("rlm.create_session works only from a root session at depth 0");
    if (!slot.thread.createSession) throw new Error("rlm.create_session needs pi-host's thread list, which this thread was opened without");
    const kwargs = (payload.kwargs ?? {}) as Record<string, unknown>;
    const [provider, ...rest] = typeof kwargs.model === "string" ? kwargs.model.split("/") : [];
    const created = await slot.thread.createSession({
      prompt: String(payload.prompt ?? ""), ...(typeof kwargs.name === "string" ? { name: kwargs.name } : {}),
      ...(provider && rest.length ? { model: { provider, modelId: rest.join("/") } } : {}),
      ...(typeof kwargs.thinking === "string" ? { thinking: kwargs.thinking } : {}),
      cwd: typeof kwargs.cwd === "string" ? kwargs.cwd : slot.thread.cwd,
    });
    return { active_session_id: created.id, session_id: created.id, name: created.name, session_file: created.file, model: created.model };
  }

  private async send(slot: Slot, payload: Record<string, unknown>): Promise<unknown> {
    const self = await this.self(slot);
    const mode = parseMode(payload.mode);
    if (typeof payload.message !== "string") throw new Error("agent_message.send message must be a string");
    const text = payload.message.trim();
    if (!text) throw new Error("Agent session message cannot be empty");
    const listed = await this.members(slot.thread, slot.conversation === ROOT_CONVERSATION_ID);
    const members = family(self, listed.all);
    if (typeof payload.target === "string") {
      if (payload.target !== "all") throw new Error("positional agent_message.send targets are not supported; use receiver_role and receiver_name");
      if (payload.receiver_role != null || payload.receiver_name != null) throw new Error("agent_message.send broadcast cannot be combined with receiver_role/receiver_name");
      // A broadcast stays among pi-host's own agents, as a Prime root's reaches only the roots its own daemon runs.
      const local = members.filter(m => m.item.root?.kind !== "prime");
      const settled = await Promise.allSettled(local.map(m => this.deliver(slot, self, m.relationship, m.item, text, mode)));
      return { receipts: settled.map((r, i) => (r.status === "fulfilled" ? r.value : { target: local[i]!.item.member.id, error: r.reason instanceof Error ? r.reason.message : String(r.reason) })) };
    }
    const role = payload.receiver_role;
    if (role !== "parent" && role !== "sibling" && role !== "child") throw new Error('agent_message.send receiver_role must be "parent", "sibling", or "child"');
    const name = payload.receiver_name;
    if (role === "parent" && name != null) throw new Error("agent_message.send receiver_name must be omitted for parent messages");
    if (role !== "parent" && (typeof name !== "string" || !name.trim())) throw new Error("agent_message.send receiver_name is required for sibling and child messages");
    const wanted = typeof name === "string" ? name.trim() : undefined;
    // A full id or the exact name, never an id prefix (owner rule c149); a Prime root also answers to its full active session id.
    const matches = members.filter(m => m.relationship === role && (role === "parent" || (m.item.member.name === wanted && !unlisted(m.item)) || m.item.member.id === wanted
      || (m.item.root?.kind === "prime" && m.item.root.activeId === wanted)));
    if (matches.length === 0) {
      const why = role === "sibling" && listed.missing ? ` (${listed.missing})` : "";
      throw new Error(`No ${role} matches ${role === "parent" ? "the current agent" : JSON.stringify(name)}${why}`);
    }
    if (matches.length > 1) throw new Error(`${role} selector ${JSON.stringify(name)} is ambiguous: it names ${matches.map(m => described(m.item)).join(" and ")}; send to one full id`);
    return this.deliver(slot, self, matches[0]!.relationship, matches[0]!.item, text, mode);
  }

  private async deliver(slot: Slot, self: Member, rel: Relationship, target: Known, text: string, mode: ReturnType<typeof parseMode>) {
    const id = newMessageId();
    // What the sender is to the target, which names the header as Prime's host builds it; a Prime root also gets the full id to answer to.
    const back = relationship(target.member, self);
    const content = `${target.root?.kind === "prime" ? piThreadHeader(self.name, self.id) : header(self.name, back)}\n\n${text}`;
    const whenBusy = mode === "follow_up" ? "followUp" as const : "steer" as const;
    const entry = { kind: "agent.message" as const, data: { from: self.id, via: "agent_message" } };
    const harness = this.harnessOf(slot.thread);
    if (target.root) {
      if (!slot.thread.submitRoot) throw new Error(`${described(target)} is not reachable from here`);
      await slot.thread.submitRoot(target.root, { text: content, requestId: `agentmsg:${id}`, whenBusy, entry });
    } else if (rel === "child") {
      // A parent's message to its child runs like its task: the child's run end sends the parent a notice unless the child replied.
      await harness.commit(async tx => {
        await tx.createTask(DeliverTask, {
          parent: slot.conversation, child: target.conversation!, thread: slot.thread.id, name: target.member.name, content, from: self.id, via: "agent_message",
          requestId: `agentmsg:${id}`, whenBusy,
        }, { ownership: { kind: "conversation" }, conversationId: slot.conversation as ConversationId, background: true });
        Object.assign(await tx.doc(RlmChildDoc, target.conversation! as ConversationId), { status: "running" });
      }, context);
    } else {
      await this.submit(slot.thread, { conversation: target.conversation!, text: content, requestId: `agentmsg:${id}`, whenBusy, entry });
    }
    if (rel === "parent" && slot.conversation !== ROOT_CONVERSATION_ID) {
      await harness.commit(async tx => { Object.assign(await tx.doc(RlmChildDoc, slot.conversation as ConversationId), { repliedAt: Date.now() }); }, context);
    }
    const from = endpoint(self.id, self.name, self.role, "agent");
    const to = endpoint(target.member.id, target.member.name, target.member.role);
    const sent = receipt({ id, from: { id: self.id, name: self.name, role: self.role }, text, mode, sentAt: Date.now() }, from, to, "started", []);
    return target.root?.kind === "prime" ? { ...sent, host: target.root.box } : sent;
  }

  // ---- agent_observe.

  private async messagesOf(thread: RlmThread, conversation: number): Promise<Message[]> {
    const conv = await this.harnessOf(thread).conversation(conversation as ConversationId, context);
    if (!conv) return [];
    const view = await conv.context(context);
    return view.messages.filter(m => m.role !== "system") as Message[];
  }

  private async agentRow(thread: RlmThread, known: Known, isCurrent: boolean, rel?: Relationship): Promise<Record<string, unknown>> {
    const m = known.member;
    const base = {
      sessionId: m.id, sessionName: m.name, runtimeKind: m.role === "child" ? "subagent" : "top-level", isCurrent, isCompacting: false, attachedClients: 0,
      ...(m.parentId ? { parentActiveSessionId: m.parentId, parentSessionId: m.parentId } : {}),
      ...(rel ? { relationship: rel } : {}),
    };
    // Another root's row comes from its listing; its messages are not read here (a Prime transcript lives on its own box).
    if (known.root?.kind === "prime") {
      const root = known.root;
      return { ...(root.activeId ? { activeSessionId: root.activeId } : {}), ...base, kind: "prime", host: root.box, status: root.status, isStreaming: root.status === "running", queuedCount: 0,
        isSessionActive: true };
    }
    if (known.thread !== thread.id || known.conversation === undefined) {
      return { ...base, kind: "pi", status: known.root?.status ?? "inactive", isStreaming: known.root?.status === "running", queuedCount: 0, isSessionActive: false };
    }
    const harness = this.harnessOf(thread);
    const running = Boolean((await harness.snapshot(LiveDoc, known.conversation as ConversationId, context))?.run);
    const messages = await this.messagesOf(thread, known.conversation);
    const doc = known.conversation === ROOT_CONVERSATION_ID ? undefined : await harness.snapshot(RlmChildDoc, known.conversation as ConversationId, context);
    const first = doc?.task ?? textOfMessage(messages.find(msg => msg.role === "user"));
    const flat = first.replace(/^\[task from parent\]\s*/, "").trim();
    const last = messages.length - 1;
    return {
      activeSessionId: m.id, ...base, cwd: thread.cwd, status: running ? "running" : "idle", activity: running ? "model" : "idle", isStreaming: running,
      messageCount: messages.length, queuedCount: 0, isSessionActive: true,
      ...(rel === "child" && doc ? { repliedSinceTask: doc.repliedAt >= doc.createdAt && doc.repliedAt > 0 } : {}),
      ...(flat ? { firstMessage: flat.length > FIRST_CHARS ? `${flat.slice(0, FIRST_CHARS - 3).trimEnd()}...` : flat } : {}),
      ...(last >= 0 ? { latestMessage: previewOf(messages[last] as never, last, LATEST_CHARS) } : {}),
    };
  }

  private async listAgents(slot: Slot): Promise<Record<string, unknown>> {
    const { all, missing } = await this.members(slot.thread, slot.conversation === ROOT_CONVERSATION_ID);
    const self = all.find(m => m.thread === slot.thread.id && m.conversation === slot.conversation);
    if (!self) throw new Error("agent observation is not available in this conversation");
    const members = family(self.member, all).filter(m => !unlisted(m.item));
    return {
      current: await this.agentRow(slot.thread, self, true),
      agents: await Promise.all(members.map(m => this.agentRow(slot.thread, m.item, false, m.relationship))),
      ...(missing ? { missing } : {}),
    };
  }

  private async resolve(slot: Slot, target: string): Promise<{ known: Known; rel?: Relationship; isCurrent: boolean }> {
    const { all } = await this.members(slot.thread, slot.conversation === ROOT_CONVERSATION_ID);
    const self = all.find(m => m.thread === slot.thread.id && m.conversation === slot.conversation)!;
    const wanted = target.trim();
    if (wanted === self.member.id || wanted === self.member.name) return { known: self, isCurrent: true };
    const members = family(self.member, all);
    const exact = members.filter(m => m.item.member.id === wanted || (m.item.member.name === wanted && !unlisted(m.item)));
    // The id suffix a child's agent id ends in (`<thread>:<conversation>`) stays a match for pi-host's own agents only (owner rule c149).
    const hits = exact.length > 0 ? exact : members.filter(m => m.item.root?.kind !== "prime" && wanted.length >= 4 && m.item.member.id.endsWith(wanted));
    if (hits.length === 1) return { known: hits[0]!.item, rel: hits[0]!.relationship, isCurrent: false };
    if (hits.length > 1) throw new Error(`agent selector ${JSON.stringify(target)} is ambiguous: it names ${hits.map(m => described(m.item)).join(" and ")}`);
    if (all.some(m => m.member.id === wanted || (m.member.name === wanted && !unlisted(m)))) throw new Error("Agent reach is limited to parent, siblings, and children");
    throw new Error(`No agent matches ${JSON.stringify(target)}`);
  }

  private async recent(slot: Slot, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const bounded = (value: unknown, fallback: number, min: number, max: number, name: string): number => {
      const n = value ?? fallback;
      if (typeof n !== "number" || !Number.isInteger(n)) throw new Error(`${name} must be an integer`);
      if (n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}`);
      return n;
    };
    const limit = bounded(payload.limit, 8, 1, 50, "agent_observe limit");
    const maxChars = bounded(payload.max_chars, 800, 80, 2000, "agent_observe max_chars");
    const { known, rel, isCurrent } = await this.resolve(slot, String(payload.target ?? ""));
    const messages = known.thread === slot.thread.id && known.conversation !== undefined ? await this.messagesOf(slot.thread, known.conversation) : [];
    const start = Math.max(0, messages.length - limit);
    return {
      agent: await this.agentRow(slot.thread, known, isCurrent, rel),
      messages: messages.slice(start).map((m, i) => previewOf(m as never, start + i, maxChars)),
      limit, maxChars, truncated: start > 0,
    };
  }
}

/** The name an rlm child goes by in the thread's tree, or undefined for a conversation that is no rlm child. */
export async function rlmChildName(harness: Harness, conversation: ConversationId, ctx: Context = context): Promise<string | undefined> {
  const doc = await harness.snapshot(RlmChildDoc, conversation, ctx);
  return doc?.id ? doc.name : undefined;
}
