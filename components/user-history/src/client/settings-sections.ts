import type { IconName } from "./icons.ts";

/** The Settings dialog's tabs, in nav order: the id `store.drawer` opens, the nav label and icon, and the line under the tab's title. */
export const SETTINGS_SECTIONS = [
  { id: "accounts", label: "Accounts", icon: "users", description: "The Claude and Codex accounts your chats share, and which one serves the next request." },
  { id: "usage", label: "Usage", icon: "chart", description: "Tokens and cost for every agent on this Mac." },
  { id: "new-chats", label: "New chats", icon: "message", description: "The model, effort and start skill every new chat begins with." },
  { id: "appearance", label: "Appearance", icon: "palette", description: "Theme, accent color, text size and spacing. Saved in this browser and applied at once." },
  { id: "remote", label: "Phone access", icon: "phone", description: "Open the chat from your phone, and keep it running on this Mac." },
  { id: "slack", label: "Slack", icon: "hash", description: "Mirror chats to Slack channels and reply from there." },
  { id: "updates", label: "Updates", icon: "download", description: "The app version, and the rules version each chat runs." },
  { id: "how", label: "How it works", icon: "book", description: "How chats and the account pool work, with the values they use now." },
] as const satisfies readonly { id: string; label: string; icon: IconName; description: string }[];

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"];
export type SettingsSectionInfo = (typeof SETTINGS_SECTIONS)[number];

export function settingsSection(id: SettingsSection): SettingsSectionInfo {
  return SETTINGS_SECTIONS.find(entry => entry.id === id)!;
}
