import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "prime-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { agentLines } from "../src/chat-agents.ts";
import { agentOpsViaService, applyAgentOps } from "../src/agent-board.ts";
import { BRIEF_CORRECTIONS, CHAT_BRIEF, CHAT_BRIEF_ENTRY, type ChatJobOf, createdRootChat, JOB_REPLY_TOOL, jobOf, jobReplyGuideline, PERSONA_TOOL, personaGuideline, pinnedBrief } from "../src/chat-brief.ts";
import { CHAT_BOARD_TOOL, CHAT_FLAG, CHAT_MODE_ENTRY, chatModeAt, chatShellNote, createSessionNames, hasChatMarker, tellOwner, topSession, withChatTool, withMessageIds } from "../src/chat-guard.ts";
import { registerPrintedRoots } from "../src/chat-sources.ts";
import { chatService, hostJobRegistry, remoteChatService, serviceCall } from "../src/chat-host.ts";
import { TELL_OWNER_TOOL } from "../src/shared/chat-feed.ts";
import { BOARD_OP_NAMES, boardRevLine, PLAN_STATUSES, renderOpenPlan } from "../src/shared/chat-board.ts";
import { ImageFitter } from "../src/context-images.ts";
import { shortNotices } from "../src/prime-notices.ts";
import { chatCheckIn, checkInLine, checkInSettings, parseChatCheckIn } from "../src/checkin-settings.ts";
import { CLEAN_ROOM_CHATS_FILE, CLEAN_ROOM_CORRECTIONS_FILE, CORRECTION_TOOL, CorrectionLedger, correctionResult, ENFORCEMENTS, type Ledger, parseCorrectionCall } from "../src/chat-corrections.ts";
import { IdIndex } from "../src/id-index.ts";
import { CORRECTION_CHECKPOINT, deliverCorrections } from "../src/correction-delivery.ts";
import { withMessageCheck } from "../src/message-limit-check.ts";
import { endLoadWait, loadWaitNote } from "../src/load-wait.ts";
import { recordPrompt } from "../src/prompt-capture.ts";
import { REQUIREMENT_STATUSES, type ChatAgent } from "../src/shared/types.ts";

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
    description: "Read or change this chat's board: plan and owner todos. No ops returns the open checklist with ids; ops return their " +
      "summaries. The board skill's SKILL.md explains each op and field.",
    promptGuidelines: [...brief],
    parameters: {
      type: "object",
      properties: {
        ops: {
          type: "array",
          description: `Applied in order, all or none. Fields: id, parent, text, status (${PLAN_STATUSES.join("|")}), job, sessionId, note, waitUntil, ` +
            `waitFor, done, step, choices, items, go ("needed"), kind ("build"), requirements [{text,status (${REQUIREMENT_STATUSES.join("|")}),evidence,` +
            "note}], target {metric,target,unit,current,measuredAt,source,cadence}, duty (\"<dutyId>/<metricKey>\", the duty metric a step fixes), " +
            "links [{label,target}]; null clears a field.",
          items: {
            type: "object",
            properties: { op: { type: "string", description: BOARD_OP_NAMES.join("|") } },
            required: ["op"],
          },
        },
        check_in: { type: "object", description: "pause (\"1h\", \"tomorrow\", null resumes) and/or every_minutes (a whole number of minutes; 120 is the usual interval, and the owner sets a shorter one on his page)." },
      },
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const input = params as { ops?: unknown; check_in?: unknown };
      const raw = input.ops ?? [];
      const writes = Array.isArray(raw) && raw.length > 0;
      const change = input.check_in === undefined ? undefined : parseChatCheckIn(input.check_in);
      const sessionId = ctx.sessionManager.getSessionId();
      // The live chat service runs the gates for a write (agentOpsViaService), so this session's loaded copy judges only while no service answers.
      // On a box whose chat host is another box, reads and check-in changes go there too, since its files are the only live ones (src/chat-host.ts).
      const service = await chatService(dataDir());
      const remote = service?.remote ? service : null;
      const { board, summaries } = (writes || remote ? await agentOpsViaService(dataDir(), sessionId, raw, signal) : null) ?? await applyAgentOps(dataDir(), sessionId, raw);
      const now = Date.now();
      let changed: string[];
      let checkIn: string;
      if (remote) {
        const answer = await serviceCall<{ changed: string[]; line: string }>(remote, "api/agent/check-in", { chat: sessionId, ...(change ? { change: input.check_in } : {}) });
        changed = answer?.changed ?? [];
        checkIn = answer?.line ?? "";
      } else {
        const settings = checkInSettings(join(dataDir(), "check-in-settings.json"));
        changed = change ? [await chatCheckIn(settings, sessionId, change, now)] : [];
        checkIn = checkInLine(await settings.get(sessionId), now);
      }
      if (writes && board) return { content: [{ type: "text", text: [...changed, ...summaries, boardRevLine(board)].join("\n") }], details: undefined };
      const agents = agentLines(await chatAgentsOf(sessionId), now);
      return { content: [{ type: "text", text: [...changed, renderOpenPlan(board, sessionId, checkIn), ...agents].join("\n") }], details: undefined };
    },
  }); };
  boardTool(CHAT_BRIEF);
  // A chat pins the brief its system prompt carries at its first start and after each compaction, when the prompt is rewritten anyway; a
  // reload in between keeps the pinned one, and the chat server's [brief] notice tells it what changed.
  const pinBrief = () => pi.appendEntry(CHAT_BRIEF_ENTRY, { lines: [...CHAT_BRIEF] });
  // The feed shows each call's text as its own bubble on any turn. On a wake-up it is the only text the owner sees; on an owner turn that calls
  // it, the chat's own text folds into notes. It refuses only empty text (c97).
  pi.registerTool({
    name: TELL_OWNER_TOOL,
    label: "Tell the owner",
    description: "Send the owner one chat message, its own bubble, like a DM: one point in 1 or 2 short casual sentences, with no " +
      "bullets, bold or labels. Call it again for a second point. Markdown, images and mermaid diagrams render, for when he asks for one.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
        reply_to: { type: "string", description: "[message id] of the owner message this message answers, when newer messages came after it. " +
          "Leave it out on an update nobody asked for. On a wake-up, set it only on the one message that brings the result that owner message asked for." },
      },
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
  // Each session's last provider payload for the Prompt view (src/prompt-capture.ts). No other extension hooks this event and user-history
  // loads last, so this is the request as sent. The JSON is built here; the file write runs after the request leaves.
  pi.on("before_provider_request", (event, ctx) => {
    try {
      void recordPrompt(dataDir(), { capturedAt: new Date().toISOString(), sessionId: ctx.sessionManager.getSessionId(),
        sessionFile: ctx.sessionManager.getSessionFile() ?? null, provider: ctx.model?.provider ?? "", model: ctx.model?.id ?? "", payload: event.payload });
    } catch { /* no capture this call */ }
    return undefined;
  });
  // The chat server computes the agents list (subagents, roots, step owners, message partners) and serves it under its capability URL,
  // recorded in <data dir>/instance.json. No server, no section.
  const chatAgentsOf = async (sessionId: string): Promise<ChatAgent[]> => {
    try {
      const service = await chatService(dataDir());
      if (!service) return [];
      const response = await fetch(`${service.base}api/threads/${encodeURIComponent(sessionId)}/agents`, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) return [];
      const body = await response.json() as { agents?: unknown };
      return Array.isArray(body.agents) ? body.agents as ChatAgent[] : [];
    } catch { return []; }
  };
  const jobs = () => hostJobRegistry(dataDir());
  const corrections = () => new CorrectionLedger(dataDir());
  // The chat host's ledger, read at most once a minute: the context hook runs before every model request, and the box is 0.2 s away from the Mac.
  let remoteLedger: { at: number; ledger: Ledger | null } | null = null;
  const readLedger = async (): Promise<Ledger | null> => {
    const service = await remoteChatService();
    if (!service) return await corrections().read();
    if (!remoteLedger || Date.now() - remoteLedger.at > 60_000) remoteLedger = { at: Date.now(), ledger: await serviceCall<Ledger>(service, "api/agent/corrections") };
    return remoteLedger.ledger;
  };
  pi.on("context", async (event, ctx) => {
    if (!marked && !job && !underChat) return undefined;
    let messages = event.messages;
    if (marked) try { messages = withMessageIds(messages) ?? messages; } catch { /* no ids */ }
    let ledger: Ledger | null = null;
    try { ledger = await readLedger(); } catch { /* no ledger */ }
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
          status: { type: "string", enum: ["active", "retired"] }, handoff: { type: "object" }, notRepeatOf: { type: "string" }, mergeInto: { type: "string" },
        },
      },
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const call = parseCorrectionCall(params);
        const chat = { id: ctx.sessionManager.getSessionId(), name: ctx.sessionManager.getSessionName()?.trim() ?? "" };
        const service = await remoteChatService();
        if (service) {
          const answer = await serviceCall<{ text: string }>(service, "api/agent/corrections", { call: params, chat });
          remoteLedger = null;
          return { content: [{ type: "text", text: answer?.text ?? "The chat host has no corrections route yet." }], details: undefined };
        }
        // A clean-room chat's owner messages are the script's, so its corrections go to a scratch ledger no other chat reads.
        const cleanRoom = await new IdIndex(join(dataDir(), CLEAN_ROOM_CHATS_FILE), "Clean-room chat index").ids().then(ids => ids.includes(chat.id), () => false);
        const ledger = cleanRoom ? new CorrectionLedger(dataDir(), CLEAN_ROOM_CORRECTIONS_FILE) : corrections();
        return { content: [{ type: "text", text: correctionResult(await ledger.apply(call, chat)) }], details: undefined };
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
  // A duty job, registered by its session id: the roots it starts with rlm.create_session are its chat's jobs (`createdRootChat`).
  let dutyJob = false;
  // A subagent at any depth whose top session is a chat or a root a chat started: it reads the corrections ledger like a job.
  let underChat = false;
  /** The session id of the chat a root this session creates is filed under: the chat's own, or for a duty job the one its own entry holds. */
  const rootChatId = async (ctx: ExtensionContext): Promise<string | undefined> =>
    marked ? ctx.sessionManager.getSessionId() : dutyJob ? await jobs().chatIdOf(ctx.sessionManager.getSessionId()).catch(() => undefined) : undefined;
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
    const byId = root ? await jobs().chatOf(ctx.sessionManager.getSessionId()) : undefined;
    const registered = byId ?? (root && name ? await jobs().chatOf(name) : undefined);
    job = jobOf({ depth, marked, parentChat, registered });
    dutyJob = job !== null && byId !== undefined;
    if (!job) return;
    const guideline = jobReplyGuideline(job);
    pi.registerTool({
      name: JOB_REPLY_TOOL,
      label: "Report to the chat",
      description: "Shows how this job reports to its chat.",
      promptGuidelines: [guideline],
      parameters: { type: "object", properties: {} },
      async execute() { return { content: [{ type: "text", text: guideline }], details: undefined }; },
    });
  };
  // A chat, each job of it and every subagent under them work in poteto-mode: one tool whose guideline is the line. Any error fails open.
  let persona: string | null = null;
  const registerPersona = (): string | null => {
    if (persona) return persona;
    persona = personaGuideline(join(getAgentDir(), "skills", "poteto-mode", "SKILL.md"));
    const line = persona;
    if (line) pi.registerTool({
      name: PERSONA_TOOL,
      label: "poteto-mode",
      description: "Shows the skill this session works in.",
      promptGuidelines: [line],
      parameters: { type: "object", properties: {} },
      async execute() { return { content: [{ type: "text", text: line }], details: undefined }; },
    });
    return persona;
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
    if (marked || job || underChat) try { registerPersona(); } catch { /* no line */ }
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
    let line: string | null = null;
    try { line = registerPersona(); } catch { /* no line */ }
    const add = [guideline, line].filter((line): line is string => line !== null && !event.systemPrompt.includes(line));
    return add.length ? { systemPrompt: `${event.systemPrompt}\n\n${add.join("\n")}` } : undefined;
  });
  /** The soft-cap notes of each tool call: the call runs, and its result gets them (a chat's shell past look-ups, a load-wait loop). */
  const callNotes = new Map<string, string[]>();
  pi.on("tool_call", async (event, ctx) => {
    try {
      const notes = [chatShellNote({ toolName: event.toolName, input: event.input, depth: depthOf(ctx.sessionManager.getHeader()), marked }),
        marked || job || underChat ? loadWaitNote(event.toolName, event.input) : undefined].filter((note): note is string => note !== undefined);
      if (notes.length) callNotes.set(event.toolCallId, notes);
      // The result reaches the agent only when the call ends, so a load-wait call's wait ends after its first check (load-wait.ts).
      const ended = marked || job || underChat ? endLoadWait(event.toolName, event.input) : undefined;
      if (ended) Object.assign(event.input, ended);
      const rootChat = createdRootChat({ marked, self: ctx.sessionManager.getSessionName()?.trim() || ctx.sessionManager.getSessionId(), job, dutyJob });
      if (rootChat && event.toolName === "ipython" && typeof event.input.code === "string") {
        const names = createSessionNames(event.input.code);
        if (names.length) await jobs().add(names, rootChat, await rootChatId(ctx));
      }
      // A message a chat or a job of a chat sends its job gets the c47 hold note on its receipt (message-limit-check.py).
      // Every other session's kernel gets the send checks too: the 5180 SSR hang fix job, no job of a chat, read each daemon timeout as a
      // failure and sent one report 4 times on 10-16 between 05:03 and 05:44Z.
      if (event.toolName === "ipython" && typeof event.input.code === "string") {
        const code = withMessageCheck(event.input.code, marked || job || underChat ? dataDir() : null);
        if (code !== undefined) event.input.code = code;
      }
      return undefined;
    } catch { return undefined; }
  });
  // A root started with a computed name (`name=name` in a loop) has no literal for tool_call to read, so its printed handle registers it
  // (AI harness 10-14: the 15:01 check-in started skill rules land, stale tree guard land and skill rewrite land this way, so the 17:01
  // check-in read their steps as held by other threads and closed them before their runs went green).
  pi.on("tool_result", async (event, ctx) => {
    const notes = callNotes.get(event.toolCallId);
    callNotes.delete(event.toolCallId);
    try {
      const rootChat = event.toolName === "ipython" &&
        createdRootChat({ marked, self: ctx.sessionManager.getSessionName()?.trim() || ctx.sessionManager.getSessionId(), job, dutyJob });
      if (rootChat) await registerPrintedRoots(jobs(), event.content.map(part => part.type === "text" ? part.text : "").join("\n"), rootChat, await rootChatId(ctx));
    } catch { /* the literal names tool_call registered */ }
    return notes ? { content: [...event.content, ...notes.map(note => ({ type: "text" as const, text: `\n${note}` }))] } : undefined;
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
        const { ensureChatService } = await import("../src/chat-service.ts");
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
