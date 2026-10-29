import type { AgentSummary, Delivery, ImageUpload, Item, Principal, Room, Step, TurnPlace } from "$lib/api";
import type { MarkdownContext } from "$lib/ui/markdown";
import type { PickerItem } from "$lib/ui/types";

export type TurnItem = Extract<Item, { kind: "turn" }>;
export type MessageItem = Extract<Item, { kind: "message" }>;

/** The line a step disclosure shows while folded: "Thought, ran bash, read", "Notes" when it holds only private notes, or "3 steps". */
export function stepsSummary(steps: readonly Step[]): string {
  const tools = steps.filter((step): step is Extract<Step, { kind: "tool" }> => step.kind === "tool");
  const thought = steps.some(step => step.kind === "thinking");
  const names = [...new Set(tools.map(tool => tool.name))];
  const ran = names.length === 0 ? "" : names.length <= 3 ? `ran ${names.join(", ")}` : `ran ${tools.length} tools`;
  const parts = [thought ? "Thought" : "", ran].filter(Boolean);
  if (!parts.length && steps.length && steps.every(step => step.kind === "note")) return "Notes";
  const text = parts.join(", ");
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : `${steps.length} steps`;
}

/** A finished turn of an agent that talks through send_message and sent nothing: its fold is all it shows. */
export const QUIET_TURN = "Worked quietly";

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
    case "queued": return `${delivery.name} was mentioned and ${placeText(delivery.queue ?? null) ?? "waits for a working slot"}.`;
    case "read": return `${delivery.name} is reading.`;
    case "no_reply": return `${delivery.name} read it and ended its turn with no reply.`;
    case "stopped": return "Stopped after 6 agent-to-agent hops with no post from you. Post or mention to continue.";
    case "failed": return `Could not reach ${delivery.name}${delivery.error ? `: ${delivery.error}` : "."}`;
    default: return null;
  }
}

/** Mention targets for Markdown: every agent and channel by lower-case name, and the owner as the lime self chip. */
export function mentionContext(agents: readonly AgentSummary[], channels: readonly Room[], ownerName: string): MarkdownContext["mentions"] {
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

/** A waiting run's place in pi-pool's turn queue as words, or null when it does not wait. */
export function placeText(place: TurnPlace | null | undefined): string | null {
  if (place?.state === "queued") return `waits at place ${place.position} of ${place.total}`;
  if (place?.state === "marked") return "starts next as your turn";
  return null;
}

/** The owner's newest message with no answer after it, which is the send a queue place belongs to. */
export function waitingSend(items: readonly Item[]): string | null {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (!item || item.kind === "system") continue;
    if (item.kind === "turn" && (item.text || item.steps.length)) return null;
    if (item.kind === "message" && item.author.id === "owner") return item.id;
  }
  return null;
}

/**
 * The rows of every agent picker (channel and Solo members, a DM's To): registered agents (`ag_<slug>`) that are not archived. A job, a work
 * thread or a comm thread is never an agent, so none of them is ever a row; the owner's 10-29 complaint was a picker that listed them.
 */
export function agentPickerItems(agents: readonly AgentSummary[]): PickerItem[] {
  return agents
    .filter((a) => a.id.startsWith("ag_") && !a.archived)
    .map((a) => ({ id: a.id, label: a.name, ...(a.status === "working" ? { detail: "working now" } : {}), avatar: { name: a.name, kind: "agent" as const, seed: a.id } }));
}
