/**
 * This tab's place in its history, so Back and Forward grey out at the ends and the History button lists recent places, as in Slack.
 *
 * Each history entry carries its position in `history.state.navIndex`, which the browser keeps across Back, Forward and reload. A hash
 * change onto an entry with no position is a new visit, which drops the entries ahead of it. sessionStorage `chat.navHistory` keeps the
 * stack of hashes and the recent places for this tab.
 */
import { agents, conversations } from "$lib/api";
import { parseHash, PAGES, type Route } from "$lib/router.svelte";

export type Place = { hash: string; at: number };
type Saved = { stack: string[]; recent: Place[] };

const KEY = "chat.navHistory";
const RECENT_MAX = 15;

/** One conversation or view is one place: `?thread=` and `?m=` on the same room do not add a second row to History. */
const placeKey = (hash: string): string => hash.split("?")[0] ?? hash;

function load(): Saved {
  try {
    const raw = JSON.parse(sessionStorage.getItem(KEY) ?? "null") as Partial<Saved> | null;
    return {
      stack: Array.isArray(raw?.stack) ? raw.stack.filter((h): h is string => typeof h === "string") : [],
      recent: Array.isArray(raw?.recent) ? raw.recent.filter((p): p is Place => typeof p?.hash === "string" && typeof p?.at === "number") : [],
    };
  } catch {
    return { stack: [], recent: [] };
  }
}

const positionOf = (state: unknown): number | null => {
  const at = (state as { navIndex?: unknown } | null)?.navIndex;
  return typeof at === "number" && at >= 0 ? at : null;
};

class NavHistory {
  index = $state(0);
  private stack = $state<string[]>([]);
  /** Places this tab visited, newest first, one row per place. */
  recent = $state<Place[]>([]);

  get canBack(): boolean {
    return this.index > 0;
  }
  get canForward(): boolean {
    return this.index < this.stack.length - 1;
  }

  constructor() {
    if (typeof window === "undefined") return;
    const saved = load();
    this.recent = saved.recent;
    const at = positionOf(history.state);
    if (at === null) {
      this.stack = [location.hash];
      this.mark(0);
    } else {
      this.stack = saved.stack.slice(0, Math.max(at + 1, saved.stack.length));
      this.index = at;
    }
    this.visit();
    window.addEventListener("hashchange", () => this.sync());
  }

  back(): void {
    if (this.canBack) history.back();
  }
  forward(): void {
    if (this.canForward) history.forward();
  }

  private mark(index: number): void {
    history.replaceState({ ...(history.state as object | null), navIndex: index }, "");
  }

  private sync(): void {
    const at = positionOf(history.state);
    if (at === null) {
      this.index += 1;
      this.stack = [...this.stack.slice(0, this.index), location.hash];
      this.mark(this.index);
    } else {
      this.index = at;
      const stack = [...this.stack];
      stack[at] = location.hash;
      this.stack = stack;
    }
    this.visit();
  }

  private visit(): void {
    const hash = location.hash || "#/c";
    this.recent = [{ hash, at: Date.now() }, ...this.recent.filter((p) => placeKey(p.hash) !== placeKey(hash))].slice(0, RECENT_MAX);
    try {
      sessionStorage.setItem(KEY, JSON.stringify({ stack: $state.snapshot(this.stack), recent: $state.snapshot(this.recent) }));
    } catch {}
  }
}

export const navHistory = new NavHistory();

const VIEW_LABELS: Record<string, { label: string; icon: string }> = {
  new: { label: "New message", icon: "edit" },
  "for-you": { label: "For you", icon: "inbox" },
  saved: { label: "Saved", icon: "bookmark" },
  wiki: { label: "Wiki", icon: "file" },
  unreads: { label: "All unreads", icon: "messages" },
  drafts: { label: "Drafts", icon: "edit" },
};

/** The name and icon a History row shows for a place, from the live conversation list. */
export function describePlace(hash: string): { label: string; icon: string } {
  const route: Route = parseHash(hash);
  const head = route.rest[0];
  if (route.page === "messages") {
    if (!head) return { label: "Messages", icon: "messages" };
    const view = VIEW_LABELS[head];
    if (view) return view;
    const row = conversations.byId(head);
    if (!row) return { label: "Conversation", icon: "messages" };
    if (row.kind === "channel") return { label: `#${row.name}`, icon: "hash" };
    if (row.kind === "dm") return { label: row.name, icon: "robot" };
    return { label: row.name || "Untitled", icon: "messages" };
  }
  if (route.page === "search") return { label: route.params.q ? `Search "${route.params.q}"` : "Search", icon: "search" };
  if (route.page === "agents" && head) return { label: agents.byId(head)?.name ?? "Agents", icon: "robot" };
  if (route.page === "settings") return { label: `Settings${head ? `, ${head}` : ""}`, icon: "settings" };
  const page = PAGES.find((p) => p.id === route.page);
  return { label: page ? `${page.label}${head ? `, ${head}` : ""}` : "Page", icon: page?.icon ?? "file" };
}
