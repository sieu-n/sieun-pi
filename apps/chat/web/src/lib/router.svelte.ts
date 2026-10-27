/**
 * Hash router. Every page reads `router.route` and moves with `navigate` or `hrefFor`.
 *
 * Routes:
 *   #/c/<id>?thread=<jobId>&m=<messageId>   Messages, one conversation, optional side thread and message
 *   #/c                                     Messages with nothing open
 *   #/agents, #/agents/<sub>                Agents
 *   #/board, #/board/<sub>                  Board and For you
 *   #/usage                                 Usage
 *   #/hosts                                 Hosts
 */

export type PageId = "messages" | "agents" | "board" | "usage" | "hosts";

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
  { id: "usage", label: "Usage", segment: "usage", icon: "chart-bar" },
  { id: "hosts", label: "Hosts", segment: "hosts", icon: "server" },
];

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  const q = raw.indexOf("?");
  const path = q === -1 ? raw : raw.slice(0, q);
  const search = q === -1 ? "" : raw.slice(q + 1);
  const segments = path.split("/").filter(Boolean).map(safeDecode);
  const head = segments[0] ?? "";
  const page = PAGES.find((p) => p.segment === head)?.id ?? "messages";
  const rest = PAGES.some((p) => p.segment === head) ? segments.slice(1) : [];
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(search)) params[k] = v;
  return { page, rest, params };
}

export function hrefFor(page: PageId, rest: readonly string[] = [], params: Record<string, string | null | undefined> = {}): string {
  const segment = PAGES.find((p) => p.id === page)?.segment ?? "c";
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
  route = $state<Route>(parseHash(typeof location === "undefined" ? "" : location.hash));

  constructor() {
    if (typeof window === "undefined") return;
    window.addEventListener("hashchange", () => {
      this.route = parseHash(location.hash);
    });
  }

  /** The open conversation id on Messages, or null. */
  get conversationId(): string | null {
    return this.route.page === "messages" ? (this.route.rest[0] ?? null) : null;
  }

  navigate(href: string, opts: { replace?: boolean } = {}): void {
    const hash = href.startsWith("#") ? href : `#${href.startsWith("/") ? href : `/${href}`}`;
    if (hash === location.hash) return;
    if (opts.replace) {
      history.replaceState(history.state, "", hash);
      this.route = parseHash(hash);
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
