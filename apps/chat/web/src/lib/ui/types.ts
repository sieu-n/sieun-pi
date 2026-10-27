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
