export type MenuAction = {
  type?: "item";
  id: string;
  label: string;
  icon?: string;
  /** Second line or trailing text in subtle ink. */
  detail?: string;
  shortcut?: string;
  tone?: "danger";
  disabled?: boolean;
  /** Keep the menu open after the pick. */
  keepOpen?: boolean;
  onselect?: () => void;
};
export type MenuRadio = {
  type: "radio";
  id: string;
  label: string;
  /** Radios with the same group are one choice. */
  group: string;
  checked: boolean;
  detail?: string;
  disabled?: boolean;
  keepOpen?: boolean;
  onselect?: () => void;
};
export type MenuCheckbox = {
  type: "checkbox";
  id: string;
  label: string;
  checked: boolean;
  detail?: string;
  disabled?: boolean;
  /** Checkboxes keep the menu open unless this is false. */
  keepOpen?: boolean;
  onselect?: (checked: boolean) => void;
};
export type MenuSubmenu = { type: "submenu"; id: string; label: string; icon?: string; detail?: string; disabled?: boolean; items: MenuEntry[] };
export type MenuSeparator = { type: "separator" };
export type MenuLabel = { type: "label"; label: string };

export type MenuEntry = MenuAction | MenuRadio | MenuCheckbox | MenuSubmenu | MenuSeparator | MenuLabel;

export type Pickable = MenuAction | MenuRadio | MenuCheckbox | MenuSubmenu;

export function isPickable(e: MenuEntry): e is Pickable {
  return e.type !== "separator" && e.type !== "label" && !e.disabled;
}
