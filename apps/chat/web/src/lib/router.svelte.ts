/**
 * Hash router. Every page reads `router.route` and moves with `navigate` or `hrefFor`.
 *
 * Routes:
 *   #/c/<id>?thread=<jobId>&m=<messageId>   Messages, one conversation, optional side thread and message
 *   #/c                                     Messages with nothing open
 *   #/c/new?kind=chat|channel|dm            Messages, starting a new conversation
 *   #/c/for-you, #/c/for-you/<chat>/<todo>  Messages, For you, optionally with one ask open
 *   #/agents, #/agents/<sub>                Agents
 *   #/board, #/board/<chat>                 Board, the index or one chat's board
 *   #/accounts?thread=<id>                  Accounts, the pi-pool accounts, optionally for one thread
 *   #/settings/<section>                    Settings, one section such as usage or hosts, opened from the avatar menu
 *   #/search?q=&from=&in=&after=&before=&sort=&type=   Full search results, opened with Enter in the Cmd K search
 *   #/ui                                    The lib/ui gallery, not in the top bar
 *
 * Messages, Agents, Board and Accounts are the roots in the top bar; each picks its own left sidebar in lib/shell/Shell.svelte.
 * The old #/usage, #/hosts and #/board/for-you links redirect to #/settings/usage, #/settings/hosts and #/c/for-you with the rest
 * of their path and their query kept.
 */

export type PageId = "messages" | "agents" | "board" | "accounts" | "settings" | "search" | "ui";

export type Route = {
  page: PageId;
  /** Path segments after the page segment, decoded. For Messages, `rest[0]` is the conversation id. */
  rest: string[];
  /** Query parameters after `?` in the hash. */
  params: Record<string, string>;
};

export const PAGES: readonly { id: PageId; label: string; segment: string; icon: string }[] = [
  { id: "messages", label: "Messages", segment: "c", icon: "messages" },
  { id: "agents", label: "Agents", segment: "agents", icon: "robot" },
  { id: "board", label: "Board", segment: "board", icon: "board" },
  { id: "accounts", label: "Accounts", segment: "accounts", icon: "users" },
];

/** Pages reachable by URL but not shown in the top bar. */
const HIDDEN_PAGES: readonly { id: PageId; segment: string }[] = [
  { id: "settings", segment: "settings" },
  { id: "search", segment: "search" },
  { id: "ui", segment: "ui" },
];
const ALL_PAGES = [...PAGES, ...HIDDEN_PAGES];

/** Old path prefixes and where they live now; the rest of the path and the query carry over. */
const MOVED: readonly (readonly [from: string, to: string])[] = [
  ["usage", "settings/usage"],
  ["hosts", "settings/hosts"],
  ["board/for-you", "c/for-you"],
];

/** The new link for an old hash such as `#/usage` or `#/board/for-you/<chat>/<todo>`, or null when the hash did not move. */
export function movedHash(hash: string): string | null {
  const raw = hash.replace(/^#\/?/, "");
  for (const [from, to] of MOVED) {
    const next = raw.charAt(from.length);
    if (raw.startsWith(from) && (next === "" || next === "/" || next === "?")) return `#/${to}${raw.slice(from.length)}`;
  }
  return null;
}

/** First segments under `#/c/` that open a Messages view instead of a conversation. */
export const MESSAGES_VIEWS = ["new", "for-you"] as const;
export type MessagesView = (typeof MESSAGES_VIEWS)[number];

const isMessagesView = (segment: string | undefined): segment is MessagesView => (MESSAGES_VIEWS as readonly (string | undefined)[]).includes(segment);

export function parseHash(hash: string): Route {
  const raw = (movedHash(hash) ?? hash).replace(/^#\/?/, "");
  const q = raw.indexOf("?");
  const path = q === -1 ? raw : raw.slice(0, q);
  const search = q === -1 ? "" : raw.slice(q + 1);
  const segments = path.split("/").filter(Boolean).map(safeDecode);
  const head = segments[0] ?? "";
  const page = ALL_PAGES.find((p) => p.segment === head)?.id ?? "messages";
  const rest = ALL_PAGES.some((p) => p.segment === head) ? segments.slice(1) : [];
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(search)) params[k] = v;
  return { page, rest, params };
}

export function hrefFor(page: PageId, rest: readonly string[] = [], params: Record<string, string | null | undefined> = {}): string {
  const segment = ALL_PAGES.find((p) => p.id === page)?.segment ?? "c";
  const path = [segment, ...rest.map((s) => encodeURIComponent(s))].join("/");
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") qs.set(k, v);
  const query = qs.toString();
  return `#/${path}${query ? `?${query}` : ""}`;
}

/** Link to one conversation, optionally at one message and with one job's thread open in the side pane. */
export function conversationHref(id: string, opts: { thread?: string | null; messageId?: string | null } = {}): string {
  return hrefFor("messages", [id], { thread: opts.thread, m: opts.messageId });
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

class Router {
  route = $state<Route>(parseHash(""));
  /** The last address in each top bar root and the last open conversation, in memory only, for the top bar tabs. */
  private last = $state<Partial<Record<PageId, string>>>({});
  private lastConversation = $state<string | null>(null);

  constructor() {
    if (typeof window === "undefined") return;
    this.redirectMoved();
    this.show(location.hash);
    window.addEventListener("hashchange", () => {
      this.redirectMoved();
      this.show(location.hash);
    });
  }

  /** Rewrites an old address such as `#/usage` or `#/board/for-you` to its new place in place, so back skips the old one. */
  private redirectMoved(): void {
    const moved = movedHash(location.hash);
    if (moved) history.replaceState(history.state, "", moved);
  }

  private show(hash: string): void {
    this.route = parseHash(hash);
    const page = this.route.page;
    if (PAGES.some((p) => p.id === page)) this.last[page] = hash;
    if (this.conversationId) this.lastConversation = this.conversationId;
  }

  /** The open conversation id on Messages, or null on Messages' home and its views such as `new` and `for-you`. */
  get conversationId(): string | null {
    const head = this.route.page === "messages" ? this.route.rest[0] : undefined;
    return head && !isMessagesView(head) ? head : null;
  }

  /** The Messages view open in place of a conversation, such as For you, or null. */
  get messagesView(): MessagesView | null {
    const head = this.route.page === "messages" ? this.route.rest[0] : undefined;
    return isMessagesView(head) ? head : null;
  }

  /** A root's home: Messages opens the last conversation, every other root its first page. */
  homeHref(page: PageId): string {
    return page === "messages" && this.lastConversation ? conversationHref(this.lastConversation) : hrefFor(page);
  }

  /** Where a top bar tab goes: back to the last address in that root, or to the root's home when it is the open one. */
  tabHref(page: PageId): string {
    return page === this.route.page ? this.homeHref(page) : (this.last[page] ?? this.homeHref(page));
  }

  navigate(href: string, opts: { replace?: boolean } = {}): void {
    const hash = href.startsWith("#") ? href : `#${href.startsWith("/") ? href : `/${href}`}`;
    if (hash === location.hash) return;
    if (opts.replace) {
      const target = movedHash(hash) ?? hash;
      history.replaceState(history.state, "", target);
      this.show(target);
    } else {
      location.hash = hash;
    }
  }

  openConversation(id: string, opts: { thread?: string | null; messageId?: string | null } = {}): void {
    this.navigate(conversationHref(id, opts));
  }

  /** Set or clear query params on the current route, for example `setParams({ thread: null })`. */
  setParams(patch: Record<string, string | null>, opts: { replace?: boolean } = {}): void {
    const next = { ...this.route.params };
    for (const [k, v] of Object.entries(patch)) {
      if (v == null) delete next[k];
      else next[k] = v;
    }
    this.navigate(hrefFor(this.route.page, this.route.rest, next), opts);
  }
}

export const router = new Router();
