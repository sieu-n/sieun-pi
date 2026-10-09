import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "prime-agent";
import { agentLines } from "../src/chat-agents.ts";
import { BoardStore } from "../src/chat-board-store.ts";
import { ensureChatService } from "../src/chat-service.ts";
import { CHAT_BOARD_TOOL, CHAT_BRIEF, CHAT_FLAG, CHAT_MODE_ENTRY, chatGuard, chatModeAt, type ChatJobOf, createSessionNames, fileChatName, hasChatMarker, JOB_REPLY_TOOL, jobOf,
  jobPersonaGuideline, jobRegistry, jobReplyGuideline, TELL_OWNER_LIMIT, TELL_OWNER_TOOL, tellOwner, withChatTool } from "../src/chats.ts";
import { parseBoardOps, PLAN_STATUSES, renderBoard } from "../src/shared/chat-board.ts";
import { ImageFitter } from "../src/context-images.ts";
import { chatCheckIn, checkInLine, checkInSettings, parseChatCheckIn } from "../src/chat-checkin.ts";
import { CORRECTION_TOOL, CorrectionLedger, correctionResult, ENFORCEMENTS, ledgerPrompt, parseCorrectionCall } from "../src/chat-corrections.ts";
import type { ChatAgent } from "../src/shared/types.ts";

export default function historyExtension(pi: ExtensionAPI): void {
  const images = new ImageFitter();
  pi.on("context", async event => {
    const messages = await images.messages(event.messages);
    return messages ? { messages } : undefined;
  });
  pi.registerFlag(CHAT_FLAG, { description: "Create this session as a browser chat (the chat server sets it; the session entry chat_mode is the durable mark)", type: "boolean" });
  // The chat brief lives in the board tool's promptGuidelines: when the tool is active the base system prompt carries the bullets, so agent-message
  // wakes and heartbeat turns (which skip before_agent_start) read it too. The board file is the one the chat server shows and the owner edits.
  // tell_owner below is active with it (CHAT_TOOLS).
  pi.registerTool({
    name: CHAT_BOARD_TOOL,
    label: "Chat board",
    description: "Read or change this chat's board, which the owner sees next to the chat: the plan (a nested checklist of goals and steps, any depth, each " +
      "step linked to its job), the owner's todo list (asks only the owner can answer, each with choices), and the scratchpad (short notes, nested to any " +
      "depth, each with links to what it is about). Ops apply in order, all or none. No ops returns the current board. Every result shows the whole board with item " +
      "ids (p1, t1, s1) and this chat's own link target. check_in changes this chat's own check-in (a pause or the interval).",
    promptGuidelines: [...CHAT_BRIEF],
    parameters: {
      type: "object",
      properties: {
        ops: {
          type: "array",
          description: "Board ops. plan_set {items:[{text,status?,job?,note?,waitUntil?,waitFor?,children?}]} replaces the plan. plan_add {text,parent?,status?,job?,waitUntil?,waitFor?} " +
            "adds a goal, or a step under parent. plan_update {id,text?,status?,job?,note?,waitUntil?,waitFor?} (null clears job, note, waitUntil or waitFor). " +
            "waitUntil (an ISO date-time) or waitFor (the event or thread, in a few words) marks a step that waits on purpose: the check-in leaves it until " +
            "that time and then has you act on it, or for 2 h after you last changed it and then has you chase it (a thread named in waitFor is nudged every 2 h); " +
            "after 24 h a chase must become a For you todo or a new plan. plan_remove {id} removes an item and its steps. " +
            "scratch_add {text,parent?,links?} adds one note, or a note under the note parent; scratch_update {id,text?,links?} (links replaces the list, [] clears it); " +
            "scratch_remove {id} removes a note and the notes under it. " +
            "A link is {label,target}, up to 5 per bullet; target is job:<name> (a job's report), thread:<sessionId> or thread:<sessionId>@<message " +
            "timestamp ms> (a thread or one message in it), wiki:<path under the llm-wiki content>, file:<absolute path to a text file>, or an http(s) URL. " +
            "todo_add {text,choices?} asks the owner one short question; choices are 2 to 4 short answers, your recommendation first. " +
            "todo_update {id,text?,done?,reply?}. todo_remove {id}.",
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: ["plan_set", "plan_add", "plan_update", "plan_remove", "scratch_add", "scratch_update", "scratch_remove", "todo_add", "todo_update", "todo_remove"] },
              id: { type: "string" }, parent: { type: "string" }, text: { type: "string" },
              status: { type: "string", enum: [...PLAN_STATUSES] }, job: { type: ["string", "null"] }, note: { type: ["string", "null"] },
              waitUntil: { type: ["string", "null"] }, waitFor: { type: ["string", "null"] },
              done: { type: "boolean" }, reply: { type: ["string", "null"] },
              links: { type: "array", items: { type: "object", properties: { label: { type: "string" }, target: { type: "string" } }, required: ["target"] } },
              choices: { type: "array", items: { type: "string" } },
              items: { type: "array", items: { type: "object" } },
            },
            required: ["op"],
          },
        },
        check_in: {
          type: "object",
          description: "Change this chat's own check-in, in the owner's settings: pause \"1h\" or \"tomorrow\" (until 09:00), null to resume your own pause, " +
            "and/or every_minutes (1 to 240). A pause the owner set stays; the owner's later change replaces yours. The feed shows the owner one line.",
          properties: { pause: { type: ["string", "null"], enum: ["1h", "tomorrow", null] }, every_minutes: { type: "integer", minimum: 1, maximum: 240 } },
        },
      },
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const input = params as { ops?: unknown; check_in?: unknown };
      const ops = parseBoardOps(input.ops ?? []);
      const change = input.check_in === undefined ? undefined : parseChatCheckIn(input.check_in);
      const sessionId = ctx.sessionManager.getSessionId();
      const settings = checkInSettings(join(dataDir(), "check-in-settings.json"));
      const now = Date.now();
      const changed = change ? [await chatCheckIn(settings, sessionId, change, now)] : [];
      const { board, summaries } = await boards().apply(sessionId, ops, "agent");
      const checkIn = checkInLine(await settings.get(sessionId), now);
      const agents = agentLines(await chatAgentsOf(sessionId), now);
      return { content: [{ type: "text", text: [...changed, ...summaries, renderBoard(board, sessionId, checkIn), ...agents].join("\n") }], details: undefined };
    },
  });
  // The feed shows this call's text as a bubble on any turn; on a turn the owner did not start it is the only text the owner sees.
  pi.registerTool({
    name: TELL_OWNER_TOOL,
    label: "Tell the owner",
    description: "Say one or two sentences to the owner on a turn the owner did not start (a job report, another thread, a check-in). " +
      `Up to ${TELL_OWNER_LIMIT} characters; longer is refused. Call it once per wake-up, at the end, only when a goal finished, something failed ` +
      "or is blocked, or you need a decision. On a turn the owner started, reply with text instead.",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: `What the owner reads: one or two casual spoken sentences that read straight through, with no ids, hashes or asides; up to ${TELL_OWNER_LIMIT} characters.` } },
      required: ["text"],
    },
    async execute(_toolCallId, params) {
      const result = tellOwner((params as { text?: unknown }).text);
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
  // The owner's corrections reach a chat before every model call, read live from <data dir>/corrections.json. The context event runs for
  // every call of every turn kind (owner prompts, agent-message wakes, heartbeats, check-ins, tool-call continuations), unlike before_agent_start,
  // which agent-message wakes skip. The ledger goes first, so the cached prefix changes only when the ledger does. Any error fails open.
  pi.on("context", async event => {
    if (!marked) return undefined;
    try {
      const text = ledgerPrompt(await corrections().read());
      return text ? { messages: [{ role: "user", content: [{ type: "text", text }], timestamp: 0 }, ...event.messages] } : undefined;
    } catch { return undefined; }
  });
  // correction_add exists only in a chat: registered at the chat's session_start, so jobs and other sessions never see it.
  let correctionTool = false;
  const registerCorrectionTool = () => {
    if (correctionTool) return;
    correctionTool = true;
    pi.registerTool({
      name: CORRECTION_TOOL,
      label: "Record an owner correction",
      description: "Record the owner's correction of how chats work, in the same turn the owner gives it. Every chat reads the active corrections " +
        "before each model call. A correction whose theme matches an earlier one is recorded as a repeat and reopens it: a repeat is a sev, and " +
        "its fix must be code or a test. With id instead of words, record that the fix for that correction landed (enforcedBy, ref) or retire it.",
      parameters: {
        type: "object",
        properties: {
          words: { type: "string", description: "The owner's message, verbatim, in the owner's language." },
          rule: { type: "string", description: "The rule in one plain English line every chat follows, like 'Job reports stay folded; the chat sends a short message with a job: link.'" },
          theme: { type: "string", description: "3 to 6 key words naming what the correction is about (job report folded link). Reuse an earlier entry's words when it is the same thing." },
          enforcedBy: { type: "string", enum: [...ENFORCEMENTS], description: "What holds the rule now: the chat brief, code, or a test." },
          ref: { type: "string", description: "The brief bullet, file, commit or test name that enforces it, or 'pending <job>' while the fix is in flight." },
          id: { type: "string", description: "A correction id (c3) to update instead of adding: its fix landed (enforcedBy, ref) or status retired." },
          status: { type: "string", enum: ["active", "retired"], description: "With id: active (default) or retired." },
        },
      },
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const call = parseCorrectionCall(params);
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
  const findJob = async (ctx: ExtensionContext): Promise<void> => {
    if (job) return;
    const header = ctx.sessionManager.getHeader();
    const depth = depthOf(header);
    const parentChat = depth === 1 && header?.parentSession ? await fileChatName(header.parentSession) : null;
    const name = depth === 0 && !marked ? ctx.sessionManager.getSessionName()?.trim() : undefined;
    job = jobOf({ depth, marked, parentChat, registered: name ? await jobs().chatOf(name) : undefined });
    if (!job) return;
    const guideline = jobReplyGuideline(job);
    const persona = jobPersonaGuideline(join(getAgentDir(), "skills", "poteto-mode", "SKILL.md"));
    pi.registerTool({
      name: JOB_REPLY_TOOL,
      label: "Report to the chat",
      description: "Shows how this job reports to the chat that started it. Calling it is optional; the instruction is already in your guidelines.",
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
    if (marked) registerCorrectionTool();
    await findJob(ctx).catch(() => {});
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
      if (marked && event.toolName === "ipython" && typeof event.input.code === "string") {
        const names = createSessionNames(event.input.code);
        if (names.length) await jobs().add(names, ctx.sessionManager.getSessionName()?.trim() || ctx.sessionManager.getSessionId());
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
