import { router } from "$lib/router.svelte";

/**
 * Settings: one row each in the Settings sidebar, each at #/settings/<id>. The first group is this browser's own settings, kept in
 * localStorage; the second is the admin pages over the boxes and accounts. The Settings button and Cmd+, open Usage.
 */
export const SETTINGS_SECTIONS = [
  { id: "preferences", label: "Preferences", icon: "sun", group: "device" },
  { id: "notifications", label: "Notifications", icon: "bell", group: "device" },
  { id: "keyboard", label: "Keyboard", icon: "command", group: "device" },
  { id: "usage", label: "Usage", icon: "chart-bar", group: "admin" },
  { id: "hosts", label: "Hosts", icon: "server", group: "admin" },
  { id: "accounts", label: "Accounts", icon: "users", group: "admin" },
  { id: "skills", label: "Skills", icon: "spark", group: "admin" },
  { id: "consoles", label: "Consoles", icon: "external", group: "admin" },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];
export type SettingsGroup = (typeof SETTINGS_SECTIONS)[number]["group"];

export const SETTINGS_GROUPS: readonly SettingsGroup[] = ["device", "admin"];

/** The open section, Usage when the address names none or an unknown one. */
export function openSection(): SettingsSectionId {
  return SETTINGS_SECTIONS.find((s) => s.id === router.route.rest[0])?.id ?? "usage";
}
