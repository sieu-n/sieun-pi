import { parseSkillBlock, type SessionEntry, type SessionMessageEntry } from "prime-agent";

type SavedUser = Extract<SessionMessageEntry["message"], { role: "user" }>;
type SavedAssistant = Extract<SessionMessageEntry["message"], { role: "assistant" }>;
type ResponsePhase = "final_answer" | "commentary" | "unmarked";

export type QuestionPart =
  | { kind: "text"; text: string }
  | { kind: "skill"; name: string; instructions: string; arguments: string }
  | { kind: "attachment"; label: string };

export interface SavedQuestion {
  parts: QuestionPart[];
}

export interface FinalReply {
  texts: string[];
}

export interface QuestionGroup {
  questions: SavedQuestion[];
  finals: FinalReply[];
  lastUnmarkedReply?: { texts: string[] };
}

export interface HistorySnapshot {
  groups: QuestionGroup[];
  orphanFinalCount: number;
}

function responsePhase(signature: string | undefined, api: string): ResponsePhase {
  if (!signature || !["openai-responses", "openai-codex-responses", "azure-openai-responses"].includes(api)) {
    return "unmarked";
  }
  let value: unknown;
  try {
    value = JSON.parse(signature);
  } catch {
    return "unmarked";
  }
  if (typeof value !== "object" || value === null || !("v" in value) || value.v !== 1 ||
      !("id" in value) || typeof value.id !== "string" || !("phase" in value)) {
    return "unmarked";
  }
  return value.phase === "final_answer" || value.phase === "commentary" ? value.phase : "unmarked";
}

function questionText(text: string): QuestionPart {
  const skill = parseSkillBlock(text);
  return skill
    ? { kind: "skill", name: skill.name, instructions: skill.content, arguments: skill.userMessage ?? "" }
    : { kind: "text", text };
}

function savedQuestion(message: SavedUser): SavedQuestion {
  if (typeof message.content === "string") return { parts: [questionText(message.content)] };
  return {
    parts: message.content.map((part): QuestionPart => {
      switch (part.type) {
        case "text": return questionText(part.text);
        case "image": return { kind: "attachment", label: `Saved image (${part.mimeType}). Image not displayed.` };
        default: {
          const unsupported: never = part;
          return unsupported;
        }
      }
    }),
  };
}

function savedReply(message: SavedAssistant):
  | { kind: "final"; texts: string[] }
  | { kind: "unmarked"; texts: string[] }
  | { kind: "omitted" } {
  if (message.stopReason !== "stop" || message.content.some((part) => part.type === "toolCall")) {
    return { kind: "omitted" };
  }
  const finals: string[] = [];
  const unmarked: string[] = [];
  for (const part of message.content) {
    if (part.type !== "text" || !part.text.trim()) continue;
    const phase = responsePhase(part.textSignature, message.api);
    if (phase === "final_answer") finals.push(part.text);
    if (phase === "unmarked") unmarked.push(part.text);
  }
  if (finals.length) return { kind: "final", texts: finals };
  return unmarked.length ? { kind: "unmarked", texts: unmarked } : { kind: "omitted" };
}

export function collectHistory(entries: readonly SessionEntry[]): HistorySnapshot {
  const snapshot: HistorySnapshot = { groups: [], orphanFinalCount: 0 };
  let current: QuestionGroup | undefined;
  let adjacentQuestionGroup: QuestionGroup | undefined;
  for (const entry of entries) {
    if (entry.type === "custom_message") adjacentQuestionGroup = undefined;
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "user") {
      if (adjacentQuestionGroup) {
        adjacentQuestionGroup.questions.push(savedQuestion(message));
      } else {
        current = { questions: [savedQuestion(message)], finals: [] };
        snapshot.groups.push(current);
        adjacentQuestionGroup = current;
      }
      continue;
    }
    adjacentQuestionGroup = undefined;
    if (message.role !== "assistant") continue;
    const reply = savedReply(message);
    if (reply.kind === "final") {
      if (current) {
        current.finals.push({ texts: reply.texts });
        delete current.lastUnmarkedReply;
      } else {
        snapshot.orphanFinalCount++;
      }
    } else if (reply.kind === "unmarked" && current && !current.finals.length) {
      current.lastUnmarkedReply = { texts: reply.texts };
    }
  }
  return snapshot;
}
