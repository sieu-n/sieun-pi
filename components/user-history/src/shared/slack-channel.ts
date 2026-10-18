/**
 * Slack channel names as Slack checks them: lowercase letters, digits, hyphens and underscores, no spaces, at most 80 characters.
 * Shared by the setup dialog (the rule shown inline) and the bridge (the same check before the API call).
 */
export const CHANNEL_NAME_MAX = 80;
export const CHANNEL_NAME_RULE = "Lowercase letters, numbers, hyphens and underscores, no spaces, at most 80 characters.";

/** The reason a name is refused, or null when Slack would accept it. */
export function channelNameError(name: string): string | null {
  if (!name) return "Enter a channel name.";
  if (name.length > CHANNEL_NAME_MAX) return `At most ${CHANNEL_NAME_MAX} characters.`;
  if (/\s/.test(name)) return "No spaces.";
  if (/[A-Z]/.test(name)) return "Lowercase only.";
  if (!/^[a-z0-9_-]+$/.test(name)) return "Only lowercase letters, numbers, hyphens and underscores.";
  return null;
}

/** `vp-<slug>` in Slack's channel alphabet; the id stands in for a name with no ASCII. */
export function channelName(chatName: string, id: string): string {
  const slug = chatName.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^[-_]+|[-_]+$/g, "");
  return ("vp-" + (slug || id.slice(0, 8))).slice(0, CHANNEL_NAME_MAX).replace(/[-_]+$/, "");
}

/** The name the new-chat screen prefills: the chat's name slugged, or `vp-chat-<date>` while the chat has no name yet. */
export function defaultChannelName(chatName: string, now: Date = new Date()): string {
  const trimmed = chatName.trim();
  if (trimmed) return channelName(trimmed, "chat");
  return `vp-chat-${now.toISOString().slice(0, 10)}`;
}

/** A channel id (C or G, then letters and digits). */
export const isChannelId = (value: string): boolean => /^[CG][A-Z0-9]{5,20}$/.test(value);

/** What the owner typed for an existing channel: an id, or a `#name` / `name`; null for an empty field. */
export function parseChannelRef(text: string): { id: string } | { name: string } | null {
  const value = text.trim();
  if (!value) return null;
  if (isChannelId(value)) return { id: value };
  return { name: value.replace(/^#/, "").toLowerCase() };
}

/** The channel in the Slack web client; the desktop app takes over when it is installed. */
export const slackChannelUrl = (teamId: string, channel: string): string => `https://app.slack.com/client/${teamId}/${channel}`;
