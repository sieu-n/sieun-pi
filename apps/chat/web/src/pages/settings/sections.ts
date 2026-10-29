import { router } from "$lib/router.svelte";

/** Settings: the admin pages behind the avatar menu, one row each in the Settings sidebar, each at #/settings/<id>. */
export const SETTINGS_SECTIONS = [
  { id: "usage", label: "Usage", icon: "chart-bar" },
  { id: "hosts", label: "Hosts", icon: "server" },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

/** The open section, Usage when the address names none or an unknown one. */
export function openSection(): SettingsSectionId {
  return SETTINGS_SECTIONS.find((s) => s.id === router.route.rest[0])?.id ?? "usage";
}
