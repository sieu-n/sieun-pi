/** What the left sidebar lists. The chat server's GET /api/sidebar returns this shape. */
export type SoloRow = {
  kind: "solo";
  id: string;
  title: string;
  unread: number;
  /** Names of agents working in this thread now. Empty when idle. */
  working: string[];
  updatedAt: number;
};

export type ChannelRow = {
  kind: "channel";
  id: string;
  name: string;
  private?: boolean;
  unread: number;
  working: string[];
  updatedAt: number;
};

export type DmRow = {
  kind: "dm";
  /** The DM's conversation id, which is the agent's thread id. */
  id: string;
  agentId: string;
  name: string;
  status?: "online" | "away" | "offline" | null;
  unread: number;
  working: string[];
  updatedAt: number;
};

export type SidebarRow = SoloRow | ChannelRow | DmRow;

export type SidebarData = {
  solo: SoloRow[];
  channels: ChannelRow[];
  dms: DmRow[];
  /** Open For you items, for the badge on the For you row. */
  forYou?: number;
};

export type SidebarFilter = "all" | "solo" | "team";
