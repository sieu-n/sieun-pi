import type { PromptPart, PromptView } from "../shared/prompt-view.ts";

export type Speaker = "prompt" | "owner" | "injected" | "model" | "tool";

export function speakerOf(part: PromptPart): Speaker {
  if (!part.role) return "prompt";
  if (part.role === "assistant") return "model";
  if (part.role === "toolResult") return "tool";
  return part.source.startsWith("the owner") || part.label === "Image" ? "owner" : "injected";
}

export const groupName = (label: string): string => label.split(/: | from | for /)[0] || label;

export type PartGroup = { name: string; speaker: Speaker; count: number; tokens: number };

export type Outline = { head: PromptPart[]; messages: PromptPart[]; groups: PartGroup[]; headTokens: number; messageTokens: number };

export function outline(view: PromptView): Outline {
  const head = view.parts.filter(part => !part.role);
  const messages = view.parts.filter(part => part.role);
  const groups = new Map<string, PartGroup>();
  for (const part of messages) {
    const name = groupName(part.label);
    const group = groups.get(name);
    if (group) { group.count += 1; group.tokens += part.tokens; }
    else groups.set(name, { name, speaker: speakerOf(part), count: 1, tokens: part.tokens });
  }
  const sum = (parts: PromptPart[]) => parts.reduce((total, part) => total + part.tokens, 0);
  return { head, messages, groups: [...groups.values()].sort((a, b) => b.tokens - a.tokens), headTokens: sum(head), messageTokens: sum(messages) };
}

export function share(tokens: number, total: number): string {
  if (total <= 0 || tokens <= 0) return "0%";
  const percent = tokens / total * 100;
  if (percent < 0.1) return "<0.1%";
  return (percent < 10 ? percent.toFixed(1) : Math.round(percent).toString()) + "%";
}

/** The height a part's text takes before it is drawn, for `contain-intrinsic-size`, so a jump far down lands close to its target. */
export function textHeight(text: string, columns = 110, lineHeight = 18): number {
  let lines = 0;
  for (const line of text.split("\n")) lines += Math.max(1, Math.ceil(line.length / columns));
  return Math.min(lines, 200_000) * lineHeight;
}
