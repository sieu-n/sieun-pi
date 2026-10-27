/** What one session's model receives on a call, split into labelled parts in payload order. Served by `GET api/threads/<id>/prompt` for any session id: a thread, a chat, a duty or check-in job, a subagent. */
export type PromptPartKind =
  | "system"
  | "instructions"
  | "skills"
  | "harness"
  | "tools"
  | "message";

/**
 * One block of the payload: a system section, a tool definition, or one content block of a message (thinking, text, a tool call, a tool result,
 * an image). Labels name the block: "Assistant thinking", "Assistant", "Assistant tool call: <tool>", "Tool result: <tool>", "Image", and for an
 * incoming text its sender and kind (userSource in src/prompt-view.ts).
 */
export type PromptPart = {
  id: string;
  kind: PromptPartKind;
  label: string;
  source: string;
  role?: "user" | "assistant" | "toolResult";
  text: string;
  tokens: number;
  /** The index of the payload message that holds the block (Anthropic `messages`, OpenAI `input`; in a rebuild, the rebuilt message); absent before the conversation. */
  message?: number;
  /** The tool call id, on a tool call and on its result. */
  call?: string;
  /** Set on a block the user-history context hook adds on every call ([corrections], [message id], the wake note, an image it left out); the session file does not hold it. */
  hook?: true;
  /** Who registers a tool definition: the user-history extension (extension/index.ts), Prime itself, or another extension. */
  registeredBy?: ToolRegistrar;
  /** When the session got this message (its time in the session file; a block the context hook adds takes the time of the message it rides in); absent before the conversation. */
  at?: string;
};

export type ToolRegistrar = "user-history" | "prime" | "other";

/** The provider API the payload follows, which sets the order it reads in: Anthropic reads tools, system, messages; OpenAI Responses reads instructions, tools, input. */
export type PromptApi = "anthropic-messages" | "openai-responses" | "openai-completions";

/** A subagent the session spawned, opened in the same view by its session id. */
export type PromptSubagent = { sessionId: string; name: string };

/** What the Prompt view opens: a session by its id, or the brief a duty's next run sends while none of its runs has a job yet. */
export type PromptTarget = string | { chat: string; duty: string };

/** The label of a duty job's first message, the brief its run sent; the view lists it before everything else. */
export const DUTY_BRIEF = "Duty brief";

export type PromptOrigin =
  | { kind: "exact"; capturedAt: string; provider: string; model: string }
  | { kind: "rebuild"; reason: string };

export type PromptView = {
  threadId: string;
  /** The session's name, when the server knows one. */
  title?: string;
  sessionFile: string;
  origin: PromptOrigin;
  /** Absent when the payload's shape is unknown, or a rebuild found no reply that names its API. */
  api?: PromptApi;
  totalTokens: number;
  measuredInputTokens?: number;
  /** The subagents it spawned, oldest first; absent when none. */
  subagents?: PromptSubagent[];
  parts: PromptPart[];
};

/**
 * The two lines of the streamed `GET api/threads/<id>/prompt` answer: first the view whose conversation parts carry only what the first screen
 * draws (`firstScreen`), then the whole text of each part it cut, by part id (`withTexts` joins them). The chat dialog draws the first line
 * while the second is on the wire: on 10-22 the AI harness chat's view was 280 KB gzipped, 0.75 s from the Mac, and its first screen 80 KB.
 */
export type PromptFrame = { view: PromptView } | { texts: Record<string, string> };

/** How much of a text a row's one-line preview reads (client/prompt-parts.ts `preview`). */
export const PREVIEW_CHARS = 960;

/**
 * The view for the first screen and the texts it leaves out. The parts before the conversation keep their text, since the ordered view lists
 * the skills from it. An incoming block keeps the opening its row's preview reads, since each incoming message is a row of the ordered view,
 * and the model's blocks and the tool results, which show only inside an opened row, keep none.
 */
export function firstScreen(view: PromptView): { view: PromptView; texts: Record<string, string> } {
  const texts: Record<string, string> = {};
  const parts = view.parts.map(part => {
    const keep = !part.role ? Infinity : part.role === "user" ? PREVIEW_CHARS : 0;
    if (part.text.length <= keep) return part;
    texts[part.id] = part.text;
    return { ...part, text: part.text.slice(0, keep) };
  });
  return { view: { ...view, parts }, texts };
}

export const withTexts = (view: PromptView, texts: Record<string, string>): PromptView =>
  ({ ...view, parts: view.parts.map(part => Object.hasOwn(texts, part.id) ? { ...part, text: texts[part.id]! } : part) });
