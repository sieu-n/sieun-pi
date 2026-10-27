import type { IconName } from "./icons.ts";

/** The Settings dialog's tabs, in nav order: the id `store.drawer` opens, the nav label and icon, and the line under the tab's title. */
export const SETTINGS_SECTIONS = [
  { id: "accounts", label: "Accounts", icon: "users", description: "The Claude and Codex accounts your chats share, and which one serves the next request." },
  { id: "usage", label: "Usage", icon: "chart", description: "Tokens and cost for every agent on this box." },
  { id: "new-chats", label: "New chats", icon: "message", description: "The model, effort and start skill every new chat begins with." },
  { id: "appearance", label: "Appearance", icon: "palette", description: "Theme and accent color. Saved in this browser and applied at once." },
  { id: "remote", label: "Phone access", icon: "phone", description: "Open the chat from your phone, and keep it running on this Mac." },
  { id: "slack", label: "Slack", icon: "hash", description: "Mirror chats to Slack channels and reply from there." },
  { id: "hosts", label: "Hosts", icon: "server", description: "Every box that runs agents, with its CPU, memory and agent queue." },
  { id: "tools", label: "Tools and skills", icon: "wrench", description: "Whether the browser, web search and computer use work for agents, and every installed skill." },
  { id: "updates", label: "Updates", icon: "download", description: "The app version, and the rules version each chat runs." },
  { id: "how", label: "How it works", icon: "book", description: "How chats and the account pool work, with the values they use now." },
] as const satisfies readonly { id: string; label: string; icon: IconName; description: string }[];

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"];
