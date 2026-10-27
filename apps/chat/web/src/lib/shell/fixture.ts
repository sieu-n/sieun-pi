import type { SidebarData } from "./sidebar-types";

const now = Date.now();
const min = 60_000;

/** Sample sidebar rows for fixture mode, used until the chat server answers. */
export const SIDEBAR_FIXTURE: SidebarData = {
  forYou: 3,
  solo: [
    { kind: "solo", id: "t-vent", title: "Vent", unread: 0, working: ["Vent"], updatedAt: now - 2 * min },
    { kind: "solo", id: "t-frontend", title: "frontend bro", unread: 4, working: [], updatedAt: now - 9 * min },
    { kind: "solo", id: "t-crawler", title: "Crawler VP", unread: 0, working: [], updatedAt: now - 40 * min },
    { kind: "solo", id: "t-wiki", title: "wiki dream", unread: 1, working: [], updatedAt: now - 120 * min },
    { kind: "solo", id: "t-slack", title: "slack green guy", unread: 0, working: [], updatedAt: now - 300 * min },
  ],
  channels: [
    { kind: "channel", id: "c-general", name: "general", unread: 2, working: [], updatedAt: now - 5 * min },
    { kind: "channel", id: "c-launch", name: "launch", unread: 0, working: ["chat server", "chat shell"], updatedAt: now - 1 * min },
    { kind: "channel", id: "c-ops", name: "ops", private: true, unread: 0, working: [], updatedAt: now - 60 * min },
  ],
  dms: [
    { kind: "dm", id: "t-intern", agentId: "a-intern", name: "intern", status: "online", unread: 1, working: [], updatedAt: now - 3 * min },
    { kind: "dm", id: "t-honey", agentId: "a-honey", name: "Honey", status: "away", unread: 0, working: ["Honey"], updatedAt: now - 15 * min },
  ],
};
