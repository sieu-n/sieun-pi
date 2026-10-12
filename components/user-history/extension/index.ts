import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "prime-agent";
import { agentLines } from "../src/chat-agents.ts";
import { BoardStore } from "../src/chat-board-store.ts";
import { ensureChatService } from "../src/chat-service.ts";
import { BRIEF_CORRECTIONS, CHAT_BRIEF, CHAT_BRIEF_ENTRY, type ChatJobOf, JOB_REPLY_TOOL, jobOf, jobPersonaGuideline, jobReplyGuideline, pinnedBrief } from "../src/chat-brief.ts";
import { CHAT_BOARD_TOOL, CHAT_FLAG, CHAT_MODE_ENTRY, chatGuard, chatModeAt, createSessionNames, hasChatMarker, topSession, withChatTool, withReplyCap } from "../src/chat-guard.ts";
import { jobRegistry } from "../src/chat-sources.ts";
import { TELL_OWNER_LIMIT, TELL_OWNER_TOOL } from "../src/chats.ts";
import { boardRevLine, parseBoardOps, PLAN_STATUSES, renderOpenPlan } from "../src/shared/chat-board.ts";
import { ImageFitter } from "../src/context-images.ts";
import { shortNotices } from "../src/prime-notices.ts";
import { chatCheckIn, checkInLine, checkInSettings, parseChatCheckIn } from "../src/checkin-settings.ts";
import { CORRECTION_TOOL, CorrectionLedger, correctionResult, ENFORCEMENTS, type Ledger, ownerWordsRefusal, parseCorrectionCall } from "../src/chat-corrections.ts";
import { ownerMessages } from "../src/shared/brief-check.ts";
import { CORRECTION_CHECKPOINT, deliverCorrections } from "../src/correction-delivery.ts";
import { boardLimitRefusal, lastOwnerText } from "../src/shared/reply-lint.ts";
import { linkableJobs, tellOwnerChecked } from "../src/tell-owner.ts";
import { jobNames } from "../src/limit-names.ts";
import { withMessageCheck } from "../src/message-limit-check.ts";
import { loadWaitGuard } from "../src/load-wait.ts";
import { REQUIREMENT_STATUSES, type ChatAgent, type ThreadMessage } from "../src/shared/types.ts";

export default function historyExtension(pi: ExtensionAPI): void {
  const images = new ImageFitter();
  pi.on("context", async event => {
    const short = shortNotices(event.messages);
    const messages = await images.messages(short ?? event.messages) ?? short;
    return messages ? { messages } : undefined;
  });
  pi.registerFlag(CHAT_FLAG, { description: "Create this session as a browser chat (the chat server sets it; the session entry chat_mode is the durable mark)", type: "boolean" });
  // The chat brief lives in the board tool's promptGuidelines: when the tool is active the base system prompt carries the bullets, so agent-message
  // wakes and heartbeat turns (which skip before_agent_start) read it too. A chat registers it again at session_start with the brief it pinned
  // (pinnedBrief), so a reload onto an edited brief keeps its cached prompt. The board file is the one the chat server shows and the owner edits.
  // tell_owner below is active with it (CHAT_TOOLS).
  let boardBrief: readonly string[] = CHAT_BRIEF;
  const boardTool = (brief: readonly string[]) => { boardBrief = brief; pi.registerTool({
    name: CHAT_BOARD_TOOL,
    label: "Chat board",
    description: "Read or change this chat's board: plan, owner todos, scratchpad. No ops returns the open checklist with ids; ops return their " +
      "summaries. The board skill's SKILL.md explains each op and field.",
    promptGuidelines: [...brief],
    parameters: {
      type: "object",
      properties: {
        ops: {
          type: "array",
          description: `Applied in order, all or none. Fields: id, parent, text, status (${PLAN_STATUSES.join("|")}), job, sessionId, note, waitUntil, ` +
            `waitFor, done, step, choices, items, go ("needed"), kind ("build"), requirements [{text,status (${REQUIREMENT_STATUSES.join("|")}),evidence,` +
            "note}], target {metric,target,unit,current,measuredAt,source,cadence}, links [{label,target}]; null clears a field.",
          items: {
            type: "object",
            properties: { op: { type: "string", enum: ["plan_set", "plan_add", "plan_update", "plan_remove", "scratch_add", "scratch_update", "scratch_remove", "todo_add", "todo_update", "todo_remove"] } },
            required: ["op"],
          },
        },
        check_in: { type: "object", description: "pause (\"1h\", \"tomorrow\", null resumes) and/or every_minutes (1 to 240)." },
      },
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const input = params as { ops?: unknown; check_in?: unknown };
      const ops = parseBoardOps(input.ops ?? []);
      const refusal = boardLimitRefusal(ops) && boardLimitRefusal(ops, await jobNames(dataDir()));
      if (refusal) throw new Error(refusal);
      const change = input.check_in === undefined ? undefined : parseChatCheckIn(input.check_in);
      const sessionId = ctx.sessionManager.getSessionId();
      const settings = checkInSettings(join(dataDir(), "check-in-settings.json"));
      const now = Date.now();
      const changed = change ? [await chatCheckIn(settings, sessionId, change, now)] : [];
      const { board, summaries } = await boards().apply(sessionId, ops, "agent");
      if (ops.length && board) return { content: [{ type: "text", text: [...changed, ...summaries, boardRevLine(board)].join("\n") }], details: undefined };
      const checkIn = checkInLine(await settings.get(sessionId), now);
      const agents = agentLines(await chatAgentsOf(sessionId), now);
      return { content: [{ type: "text", text: [...changed, renderOpenPlan(board, sessionId, checkIn), ...agents].join("\n") }], details: undefined };
    },
  }); };
  boardTool(CHAT_BRIEF);
  // A chat pins the brief its system prompt carries at its first start and after each compaction, when the prompt is rewritten anyway; a
  // reload in between keeps the pinned one, and the chat server's [brief] notice tells it what changed.
  const pinBrief = () => pi.appendEntry(CHAT_BRIEF_ENTRY, { lines: [...CHAT_BRIEF] });
  // The feed shows this call's text as a bubble on any turn. On a wake-up it is the only text the owner sees; on an owner turn that calls it,
  // the chat's own text folds into notes.
  pi.registerTool({
    name: TELL_OWNER_TOOL,
    label: "Tell the owner",
    description: `The only text the owner reads: one or two plain sentences. Over ${TELL_OWNER_LIMIT} characters, dashes, labels, ` +
      "headings or jargon are refused with fixes.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
        reply_to: { type: "string", description: "[message id] of an older owner message it answers." },
      },
      required: ["text"],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      let owner = "";
      try { owner = lastOwnerText(ctx.sessionManager.getBranch().flatMap(entry => entry.type === "message" ? [entry.message as ThreadMessage] : [])); } catch { /* no owner words */ }
      const jobsOf = async () => linkableJobs(await chatAgentsOf(ctx.sessionManager.getSessionId()));
      const result = await tellOwnerChecked((params as { text?: unknown }).text, owner, jobsOf);
      if (!result.ok) throw new Error(result.text);
      return { content: [{ type: "text", text: result.text }], details: undefined };
    },
  });
  // Same directory as the chat server: the agent-chat-data-dir flag, else <agentDir>/browser-chat.
  const dataDir = () => {
    const flag = pi.getFlag("agent-chat-data-dir");
    return typeof flag === "string" && flag ? resolve(flag) : join(getAgentDir(), "browser-chat");
  };
  const boards = () => new BoardStore(dataDir());
  // The chat server computes the agents list (subagents, roots, step owners, message partners) and serves it under its capability URL,
  // recorded in <data dir>/instance.json. No server, no section.
  const chatAgentsOf = async (sessionId: string): Promise<ChatAgent[]> => {
    try {
      const instance = JSON.parse(await readFile(join(dataDir(), "instance.json"), "utf8")) as { url?: unknown };
      if (typeof instance.url !== "string") return [];
      const response = await fetch(`${instance.url}api/threads/${encodeURIComponent(sessionId)}/agents`, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) return [];
      const body = await response.json() as { agents?: unknown };
      return Array.isArray(body.agents) ? body.agents as ChatAgent[] : [];
    } catch { return []; }
  };
  const jobs = () => jobRegistry(join(dataDir(), "chat-jobs.json"));
  const corrections = () => new CorrectionLedger(dataDir());
  pi.on("context", async (event, ctx) => {
    if (!marked && !job && !underChat) return undefined;
    let messages = event.messages;
    if (marked) try { messages = withReplyCap(messages) ?? messages; } catch { /* no cap */ }
    let ledger: Ledger | null = null;
    try { ledger = await corrections().read(); } catch { /* no ledger */ }
    messages = deliverCorrections({ messages, branch: ctx.sessionManager.getBranch(), ledger, job: !marked, brief: BRIEF_CORRECTIONS,
      append: data => pi.appendEntry(CORRECTION_CHECKPOINT, data) });
    return { messages };
  });
  // correction_add exists only in a chat: registered at the chat's session_start, so jobs and other sessions never see it.
  let correctionTool = false;
  const registerCorrectionTool = () => {
    if (correctionTool) return;
    correctionTool = true;
    pi.registerTool({
      name: CORRECTION_TOOL,
      label: "Record an owner correction",
      description: "Record an owner correction of how chats work in the turn he gives it; with id, record its fix or retire it. Fields: the " +
        "board skill's references/corrections.md.",
      parameters: {
        type: "object",
        properties: {
          words: { type: "string", description: "His words, verbatim." }, rule: { type: "string" }, theme: { type: "string" },
          enforcedBy: { type: "string", enum: [...ENFORCEMENTS] }, ref: { type: "string" }, id: { type: "string" },
          status: { type: "string", enum: ["active", "retired"] }, handoff: { type: "object" },
        },
      },
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const call = parseCorrectionCall(params);
        const transcript = ctx.sessionManager.getBranch().flatMap(entry => entry.type === "message" ? [entry.message as ThreadMessage] : []);
        const refusal = ownerWordsRefusal(call, ownerMessages(transcript).map(message => message.text));
        if (refusal) throw new Error(refusal);
        const chat = { id: ctx.sessionManager.getSessionId(), name: ctx.sessionManager.getSessionName()?.trim() ?? "" };
        return { content: [{ type: "text", text: correctionResult(await corrections().apply(call, chat)) }], details: undefined };
      },
    });
  };
  // The marker is written once, at the first session_start of a flagged root, and read back on every later start. Children (depth > 0) inherit
  // the flag and the active tool list through the runtime config, so they drop the tool. Any error fails open.
  let marked = false;
  // A job of a chat (a direct subagent, or a root the chat started with rlm.create_session) gets job_reply, whose one guideline puts "how to
  // report" in its base prompt even when the chat's brief left it out. A root's name may land after session_start, so its first prompt looks
  // again. Any error fails open: no tool.
  let job: ChatJobOf | null = null;
  let rootLooked = false;
  // A subagent at any depth whose top session is a chat or a root a chat started: it reads the corrections ledger like a job.
  let underChat = false;
  const findJob = async (ctx: ExtensionContext): Promise<void> => {
    if (job) return;
    const header = ctx.sessionManager.getHeader();
    const depth = depthOf(header);
    const top = depth > 0 && header?.parentSession ? await topSession(header.parentSession) : null;
    if (top) underChat = top.chat || await jobs().chatOf(top.id) !== undefined || (top.name !== "" && await jobs().chatOf(top.name) !== undefined);
    const parentChat = depth === 1 && top?.chat ? top.name : null;
    const root = depth === 0 && !marked;
    const name = root ? ctx.sessionManager.getSessionName()?.trim() : undefined;
    // A duty job is registered by its session id (src/chat-duty-job.ts), a create_session root by its name.
    const registered = root ? await jobs().chatOf(ctx.sessionManager.getSessionId()) ?? (name ? await jobs().chatOf(name) : undefined) : undefined;
    job = jobOf({ depth, marked, parentChat, registered });
    if (!job) return;
    const guideline = jobReplyGuideline(job);
    const persona = jobPersonaGuideline(join(getAgentDir(), "skills", "poteto-mode", "SKILL.md"));
    pi.registerTool({
      name: JOB_REPLY_TOOL,
      label: "Report to the chat",
      description: "Shows how this job reports to its chat.",
      promptGuidelines: persona ? [persona, guideline] : [guideline],
      parameters: { type: "object", properties: {} },
      async execute() { return { content: [{ type: "text", text: guideline }], details: undefined }; },
    });
  };
  pi.on("session_start", async (_event, ctx) => {
    try {
      const depth = depthOf(ctx.sessionManager.getHeader());
      marked = depth === 0 && hasChatMarker(ctx.sessionManager.getEntries());
      const mode = chatModeAt({ depth, flagged: pi.getFlag(CHAT_FLAG) === true, marked });
      if (mode.mark) { pi.appendEntry(CHAT_MODE_ENTRY, { v: 1 }); marked = true; }
      const tools = withChatTool(pi.getActiveTools(), mode.active);
      if (tools) pi.setActiveTools(tools);
    } catch { marked = false; }
    if (marked) {
      registerCorrectionTool();
      try {
        const pinned = pinnedBrief(ctx.sessionManager.getBranch());
        if (!pinned) pinBrief();
        const brief = pinned ?? CHAT_BRIEF;
        if (brief.join("\n") !== boardBrief.join("\n")) boardTool(brief);
      } catch { /* the loaded brief */ }
    }
    await findJob(ctx).catch(() => {});
  });
  pi.on("session_compact", () => {
    if (!marked) return;
    try { pinBrief(); boardTool(CHAT_BRIEF); } catch { /* the pinned brief until the next start */ }
  });
  pi.on("before_agent_start", async (event, ctx) => {
    if (job || rootLooked || marked || depthOf(ctx.sessionManager.getHeader()) !== 0) return undefined;
    rootLooked = true;
    await findJob(ctx).catch(() => {});
    if (!job) return undefined;
    const guideline = jobReplyGuideline(job);
    const persona = jobPersonaGuideline(join(getAgentDir(), "skills", "poteto-mode", "SKILL.md"));
    const add = [persona, guideline].filter((line): line is string => line !== null && !event.systemPrompt.includes(line));
    return add.length ? { systemPrompt: `${event.systemPrompt}\n\n${add.join("\n")}` } : undefined;
  });
  pi.on("tool_call", async (event, ctx) => {
    try {
      const blocked = chatGuard({ toolName: event.toolName, input: event.input, depth: depthOf(ctx.sessionManager.getHeader()), marked });
      if (blocked) return blocked;
      if (marked || job || underChat) {
        const loadWait = loadWaitGuard(event.toolName, event.input);
        if (loadWait) return loadWait;
      }
      if (marked && event.toolName === "ipython" && typeof event.input.code === "string") {
        const names = createSessionNames(event.input.code);
        if (names.length) await jobs().add(names, ctx.sessionManager.getSessionName()?.trim() || ctx.sessionManager.getSessionId());
      }
      // A limit a chat or a job of a chat sends another session gets the reply rule's evidence check before it leaves the kernel (c43).
      if ((marked || job || underChat) && event.toolName === "ipython" && typeof event.input.code === "string") {
        const code = withMessageCheck(event.input.code, dataDir());
        if (code !== undefined) event.input.code = code;
      }
      return undefined;
    } catch { return undefined; }
  });
  pi.registerFlag("agent-chat-socket", {
    description: "Native daemon socket for browser chat",
    type: "string",
  });
  pi.registerFlag("agent-chat-port", {
    description: "Fixed browser chat port (default 5182)",
    type: "string",
  });
  pi.registerFlag("agent-chat-data-dir", {
    description: "Private browser chat service directory",
    type: "string",
  });
  for (const command of ["what-did-i-say", "agent-chat"]) pi.registerCommand(command, {
    description: "Print the shared native chat URL",
    async handler(_args, ctx) {
      try {
        const socketPath = pi.getFlag("agent-chat-socket");
        const port = pi.getFlag("agent-chat-port");
        const dataDir = pi.getFlag("agent-chat-data-dir");
        const service = await ensureChatService({
          ...(typeof socketPath === "string" ? { socketPath } : {}),
          ...(typeof port === "string" ? { port: Number(port) } : {}),
          ...(typeof dataDir === "string" ? { dataDir } : {}),
        });
        const thread = "#" + encodeURIComponent(ctx.sessionManager.getSessionId());
        ctx.ui.notify(service.url + thread + (service.phoneUrl ? `\nPhone: ${service.phoneUrl}${thread}` : ""), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "Could not start agent chat.", "error");
      }
    },
  });
}

function depthOf(header: { rlmDepth?: number; parentSession?: string } | null): number {
  return header?.rlmDepth ?? (header?.parentSession ? 1 : 0);
}
