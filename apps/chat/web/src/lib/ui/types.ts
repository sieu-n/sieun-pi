export type TabItem<V extends string = string> = {
  id: V;
  label: string;
  icon?: string;
  /** Count or short text badge after the label. */
  badge?: number | string | null;
  href?: string;
  disabled?: boolean;
};

export type Status = "online" | "away" | "offline" | "busy";

export type StackMember = { id: string; name: string; kind?: "person" | "agent"; src?: string | null };

/** One choice in the shared Picker: a model, an agent, a channel or any other option. */
export type PickerItem = {
  id: string;
  label: string;
  detail?: string;
  /** Rows with the same group sit under one heading, in first-seen order. */
  group?: string;
  icon?: string;
  avatar?: { name: string; kind?: "person" | "agent"; seed?: string; src?: string | null };
  /** Extra words the filter matches. */
  keywords?: string[];
  disabled?: boolean;
};

export type ModelOption = { id: string; label: string; family: string; detail?: string };
