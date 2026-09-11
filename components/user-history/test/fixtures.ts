import type { SessionEntry, SessionMessageEntry } from "prime-agent";

export type Assistant = Extract<SessionMessageEntry["message"], { role: "assistant" }>;
export type User = Extract<SessionMessageEntry["message"], { role: "user" }>;

export const text = (value: string) => ({ type: "text", text: value } satisfies Assistant["content"][number]);

export function markedText(value: string, phase = "final_answer") {
  return { type: "text", text: value, textSignature: JSON.stringify({ v: 1, id: "synthetic-item", phase }) } satisfies Assistant["content"][number];
}

export function assistant(content: Assistant["content"], overrides: Partial<Assistant> = {}): Assistant {
  return {
    role: "assistant", content, api: "openai-codex-responses", provider: "history-test", model: "synthetic",
    stopReason: "stop", timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    ...overrides,
  };
}

export function user(content: User["content"]): User {
  return { role: "user", content, timestamp: 1 };
}

export function entries(messages: SessionMessageEntry["message"][]): SessionEntry[] {
  return messages.map((message, i) => ({ type: "message", id: `m${i}`, parentId: i ? `m${i - 1}` : null,
    timestamp: new Date(i).toISOString(), message }));
}
