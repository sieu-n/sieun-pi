/** What one thread's model receives on a call, split into labelled parts in payload order. Served by `GET api/threads/<id>/prompt`. */
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
};

export type PromptOrigin =
  | { kind: "exact"; capturedAt: string; provider: string; model: string }
  | { kind: "rebuild"; reason: string };

export type PromptView = {
  threadId: string;
  sessionFile: string;
  origin: PromptOrigin;
  totalTokens: number;
  measuredInputTokens?: number;
  parts: PromptPart[];
};
