/**
 * How one message hit reads, in the Cmd K rows and on the full results page alike: who said it (You, an agent with an AGENT badge, a
 * system note), where (# channel, a chat, a DM, a job under its parent agent, archived), what kind of text holds the match (tool output,
 * a tool call), and when.
 */
export type HitConversation = {
  id: string;
  kind: "solo" | "channel" | "dm" | "job";
  name: string;
  parent?: { id: string; name: string } | undefined;
  archived?: boolean | undefined;
};
export type Hit = {
  id: string;
  conversation: HitConversation;
  messageId: string;
  author: { id: string; name: string; kind: "owner" | "agent" | "system" };
  at: number;
  kind: "message" | "turn" | "tool" | "post";
  role?: "owner" | "agent" | "tool" | "system" | undefined;
  tool?: string | undefined;
  inCall?: boolean | undefined;
  threadRoot?: string | undefined;
  snippet: string;
  text?: string | undefined;
};

export type Location = {
  /** An icon name from lib/ui/icons.ts. */
  icon: string;
  /** The parent agent of a job or a DM with a job, shown before a › */
  parent?: string | undefined;
  name: string;
  /** What kind of place it is, for screen readers and the tooltip. */
  kind: string;
  archived: boolean;
};

export function location(conversation: HitConversation): Location {
  const archived = !!conversation.archived;
  switch (conversation.kind) {
    case "channel":
      return { icon: "hash", name: conversation.name.replace(/^#/, ""), kind: "Channel", archived };
    case "solo":
      return { icon: "chat", name: conversation.name, kind: "Chat", archived };
    case "dm":
      return conversation.parent
        ? { icon: "robot", parent: conversation.parent.name, name: conversation.name, kind: "Job", archived }
        : { icon: "lock", name: conversation.name, kind: "Direct message", archived };
    case "job":
      return { icon: "robot", parent: conversation.parent?.name, name: conversation.name, kind: "Job", archived };
  }
}

/** "# pi-cutover", "vent › Vent integrations duty", with "(archived)" after an archived place. */
export function locationText(conversation: HitConversation): string {
  const where = location(conversation);
  const name = conversation.kind === "channel" ? `#${where.name}` : where.name;
  return `${where.parent ? `${where.parent} › ` : ""}${name}${where.archived ? " (archived)" : ""}`;
}

export type Author = { name: string; badge?: "AGENT" | "SYSTEM" | undefined; avatar: "person" | "agent" | "system"; seed: string };

export function author(hit: Hit): Author {
  if (hit.author.kind === "owner") return { name: "You", avatar: "person", seed: "owner" };
  if (hit.author.kind === "system") return { name: hit.author.name, badge: "SYSTEM", avatar: "system", seed: "system" };
  return { name: hit.author.name, badge: "AGENT", avatar: "agent", seed: hit.author.id };
}

/** "in tool output · bash", "in a tool call · ipython", "reply in thread", or nothing for a plain message. */
export function what(hit: Hit): string | undefined {
  const role = hit.role ?? (hit.kind === "tool" ? "tool" : undefined);
  if (role === "tool") return `${hit.inCall ? "in a tool call" : "in tool output"}${hit.tool ? ` · ${hit.tool}` : ""}`;
  if (hit.threadRoot) return "reply in thread";
  return undefined;
}

const ordinal = (n: number): string => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
};

const startOfDay = (t: number): number => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Slack's result stamp: "Today at 3:34 PM", "Yesterday at 9:02 AM", "Oct 12th at 3:34 PM", "Oct 12th, 2025 at 3:34 PM". */
export function longStamp(at: number, now: Date): string {
  const time = new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const days = Math.round((startOfDay(now.getTime()) - startOfDay(at)) / 86_400_000);
  if (days === 0) return `Today at ${time}`;
  if (days === 1) return `Yesterday at ${time}`;
  const date = new Date(at);
  const month = date.toLocaleDateString("en-US", { month: "short" });
  const year = date.getFullYear() === now.getFullYear() ? "" : `, ${date.getFullYear()}`;
  return `${month} ${ordinal(date.getDate())}${year} at ${time}`;
}

/** A short age for a one-line row: "now", "5m", "3h", "Yesterday", a weekday, "Oct 12", "Oct 12, 2025". */
export function shortAge(at: number, now: Date): string {
  const seconds = Math.max(0, Math.round((now.getTime() - at) / 1000));
  if (seconds < 45) return "now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const days = Math.round((startOfDay(now.getTime()) - startOfDay(at)) / 86_400_000);
  if (days === 0) return `${Math.round(seconds / 3600)}h`;
  if (days === 1) return "Yesterday";
  const date = new Date(at);
  if (days < 7) return date.toLocaleDateString("en-US", { weekday: "short" });
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
}
