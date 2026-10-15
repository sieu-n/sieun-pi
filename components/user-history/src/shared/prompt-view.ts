/** What one session's model receives on a call, split into labelled parts in payload order. Served by `GET api/threads/<id>/prompt` for any session id: a thread, a chat, a duty or check-in job, a subagent. */
export type PromptPartKind =
  | "system"
  | "instructions"
  | "skills"
  | "harness"
  | "tools"
  | "message";

export type PromptPart = {
  id: string;
  kind: PromptPartKind;
  label: string;
  source: string;
  role?: "user" | "assistant" | "toolResult";
  text: string;
  tokens: number;
  /** When the session got this message (its time in the session file; a block the context hook adds takes the time of the message it rides in); absent before the conversation. */
  at?: string;
};

/** A subagent the session spawned, opened in the same view by its session id. */
export type PromptSubagent = { sessionId: string; name: string };

export type PromptOrigin =
  | { kind: "exact"; capturedAt: string; provider: string; model: string }
  | { kind: "rebuild"; reason: string };

export type PromptView = {
  threadId: string;
  /** The session's name, when the server knows one. */
  title?: string;
  sessionFile: string;
  origin: PromptOrigin;
  totalTokens: number;
  measuredInputTokens?: number;
  /** The subagents it spawned, oldest first; absent when none. */
  subagents?: PromptSubagent[];
  parts: PromptPart[];
};
