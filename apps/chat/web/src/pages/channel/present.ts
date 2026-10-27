import type { AgentSummary, Channel, Delivery, ImageUpload, Item, LivePartial, Principal, Step } from "$lib/api";
import type { MarkdownContext } from "$lib/ui/markdown";

export type TurnItem = Extract<Item, { kind: "turn" }>;
export type MessageItem = Extract<Item, { kind: "message" }>;

/** Folds the streaming partial into the live turn it belongs to, or adds a live turn when the item has not landed yet. */
export function withPartial(items: readonly Item[], partial: LivePartial | null, author: Principal | null): Item[] {
  if (!partial) return [...items];
  const index = items.findIndex(item => item.id === partial.itemId);
  const found = index >= 0 ? items[index] : undefined;
  if (found?.kind === "turn") {
    if (!found.live) return [...items];
    const next = [...items];
    next[index] = { ...found, text: partial.text.length >= found.text.length ? partial.text : found.text };
    return next;
  }
  if (found || !author) return [...items];
  const input = items.find(item => item.id === `e${partial.itemId.slice(1)}`);
  const at = input ? input.at + 1 : Date.now();
  return [...items, { kind: "turn", id: partial.itemId, at, author, text: partial.text, live: true, steps: [], images: [], jobs: [] }];
}

/** The line a step disclosure shows while folded: "Thought, ran bash and read" or "3 steps". */
export function stepsSummary(steps: readonly Step[]): string {
  const tools = steps.filter((step): step is Extract<Step, { kind: "tool" }> => step.kind === "tool");
  const thought = steps.some(step => step.kind === "thinking");
  const names = [...new Set(tools.map(tool => tool.name))];
  const ran = names.length === 0 ? "" : names.length <= 3 ? `ran ${names.join(", ")}` : `ran ${tools.length} tools`;
  const parts = [thought ? "Thought" : "", ran].filter(Boolean);
  const text = parts.join(", ");
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : `${steps.length} steps`;
}

export function runningTool(steps: readonly Step[]): string | null {
  for (let index = steps.length - 1; index >= 0; index--) {
    const step = steps[index];
    if (step?.kind === "tool" && step.status === "running") return step.name;
  }
  return null;
}

/** What a channel post's delivery shows under it; delivered and answered show nothing, since the reply shows itself. */
export function deliveryText(delivery: Delivery): string | null {
  switch (delivery.state) {
    case "queued": return `${delivery.name} was mentioned and waits for a working slot.`;
    case "read": return `${delivery.name} is reading.`;
    case "no_reply": return `${delivery.name} read it and ended its turn with no reply.`;
    case "stopped": return "Stopped after 6 agent-to-agent hops with no post from you. Post or mention to continue.";
    case "failed": return `Could not reach ${delivery.name}${delivery.error ? `: ${delivery.error}` : "."}`;
    default: return null;
  }
}

/** Mention targets for Markdown: every agent and channel by lower-case name, and the owner as the lime self chip. */
export function mentionContext(agents: readonly AgentSummary[], channels: readonly Channel[], ownerName: string): MarkdownContext["mentions"] {
  const map = new Map<string, { id: string; kind: "person" | "agent" | "channel"; self?: boolean }>();
  for (const channel of channels) map.set(channel.name.toLowerCase(), { id: channel.id, kind: "channel" });
  for (const agent of agents) map.set(agent.name.toLowerCase(), { id: agent.id, kind: "agent" });
  map.set("owner", { id: "owner", kind: "person", self: true });
  if (ownerName) map.set(ownerName.toLowerCase(), { id: "owner", kind: "person", self: true });
  return map;
}

export const isOwn = (item: Item): boolean => item.kind !== "system" && item.author.id === "owner";

export const avatarKind = (principal: Principal): "person" | "agent" => (principal.kind === "owner" ? "person" : "agent");

/** What a composer hands its page on send. */
export type Outgoing = { text: string; mentions: string[]; images: ImageUpload[] };
