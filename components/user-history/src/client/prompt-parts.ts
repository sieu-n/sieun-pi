import type { PromptPart, PromptView } from "../shared/prompt-view.ts";

export type Speaker = "prompt" | "owner" | "injected" | "model" | "tool";

export function speakerOf(part: PromptPart): Speaker {
  if (!part.role) return "prompt";
  if (part.role === "assistant") return "model";
  if (part.role === "toolResult") return "tool";
  return part.source.startsWith("the owner") || part.label === "Image" ? "owner" : "injected";
}

const GROUP_CUT = /: | from | for /;
export const groupName = (label: string): string => label.split(GROUP_CUT)[0] || label;

/** What a part's label adds to its group's name: the tool of a tool result, the sender of an agent message. */
export function labelDetail(label: string): string {
  const match = GROUP_CUT.exec(label);
  return match ? label.slice(match.index + match[0].length) : "";
}

/**
 * One row of the summary table, which opens in place: a part before the conversation (a run of tool definitions is one row), or one source kind
 * of the conversation with its parts in payload order, which is time order.
 */
export type PromptRow = { key: string; label: string; source: string; speaker: Speaker; tokens: number; parts: PromptPart[] };

export type Outline = { rows: PromptRow[]; groups: PromptRow[]; headParts: number; messageParts: number; headTokens: number; messageTokens: number };

function headRows(head: readonly PromptPart[]): PromptRow[] {
  const rows: PromptRow[] = [];
  for (const part of head) {
    const last = rows.at(-1);
    if (part.kind === "tools" && last?.parts[0]?.kind === "tools") {
      last.parts.push(part);
      last.tokens += part.tokens;
      last.label = `Tools, ${last.parts.length} definitions`;
    } else rows.push({ key: "h:" + part.id, label: part.label, source: part.source, speaker: "prompt", tokens: part.tokens, parts: [part] });
  }
  return rows;
}

export function outline(view: PromptView): Outline {
  const head = view.parts.filter(part => !part.role);
  const messages = view.parts.filter(part => part.role);
  const groups = new Map<string, PromptRow>();
  for (const part of messages) {
    const name = groupName(part.label);
    const group = groups.get(name);
    if (group) { group.parts.push(part); group.tokens += part.tokens; }
    else groups.set(name, { key: "g:" + name, label: name, source: "", speaker: speakerOf(part), tokens: part.tokens, parts: [part] });
  }
  for (const group of groups.values()) group.source = `${group.parts.length} ${group.parts.length === 1 ? "part" : "parts"}`;
  const sum = (parts: PromptPart[]) => parts.reduce((total, part) => total + part.tokens, 0);
  return { rows: headRows(head), groups: [...groups.values()].sort((a, b) => b.tokens - a.tokens), headParts: head.length, messageParts: messages.length,
    headTokens: sum(head), messageTokens: sum(messages) };
}

export function share(tokens: number, total: number): string {
  if (total <= 0 || tokens <= 0) return "0%";
  const percent = tokens / total * 100;
  if (percent < 0.1) return "<0.1%";
  return (percent < 10 ? percent.toFixed(1) : Math.round(percent).toString()) + "%";
}

/** A part's text on one line, for its row in an open group. */
export function preview(text: string, length = 240): string {
  return text.slice(0, length * 4).replace(/\s+/g, " ").trim().slice(0, length);
}

/**
 * The first lines of a long text, for an open part before its "Show all": at most `lines` lines and `chars` characters. `more` counts the lines
 * left out (a line cut by `chars` counts), 0 when the whole text shows.
 */
export function clip(text: string, lines = 40, chars = 6000): { text: string; more: number } {
  let end = 0;
  for (let line = 0; line < lines && end < text.length; line++) {
    const next = text.indexOf("\n", end);
    end = next < 0 ? text.length : next + 1;
  }
  end = Math.min(end, chars);
  if (end >= text.length) return { text, more: 0 };
  return { text: text.slice(0, end).replace(/\n$/, ""), more: text.slice(end).replace(/\n$/, "").split("\n").length };
}
