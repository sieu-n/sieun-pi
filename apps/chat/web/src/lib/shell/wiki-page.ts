/**
 * What the wiki pane does to a page beyond showing it: edit it in place, create a page a link names, and list the posts that share it.
 * Each call goes through this server's `/wiki/<path>` routes (server/wiki/routes.ts), so the wiki engine's checks and revision log run on
 * every write, and the frame keeps the wiki's own look while a page is edited.
 */
import type { WikiShare } from "$lib/api/types";
import { router } from "$lib/router.svelte";
import { toast } from "$lib/ui/toast.svelte";

/** A content path as a `/wiki` URL, each segment encoded. */
export const wikiHref = (path: string, query = ""): string => `/wiki/${path.split("/").map(encodeURIComponent).join("/")}${query}`;

/**
 * A page as the engine stores it: its whole text, the `<!--wiki {...}-->` header as written, the HTML after it and the version a save builds
 * on.
 */
export type StoredPage = { path: string; raw: string; header: string; body: string; version: number | null };

const HEADER = /^\s*<!--wiki\s*([\s\S]*?)\s*-->\s*/;

/** The version in the YAML head of `?format=md`, which the routes put first. */
async function versionOf(path: string): Promise<number | null> {
  const res = await fetch(wikiHref(path, "?format=md&lines=1-1"));
  if (!res.ok) return null;
  const match = /^version: (\d+)$/m.exec(await res.text());
  return match ? Number(match[1]) : null;
}

/**
 * Whether stored HTML carries script, an event handler or an embedded frame. Stored HTML goes into the page unsanitized while it is edited,
 * so such a page opens in the wiki's own editor instead.
 */
export const runsScript = (html: string): boolean => /<(?:script|iframe|object|embed)\b|\son[a-z]+\s*=|javascript:/i.test(html);

/** Only an HTML page, or a folder's index.html, edits in place; `@code/` mirrors repo files and is read-only. */
export function editable(path: string): boolean {
  return !path.startsWith("@code/") && (/\.html?$/i.test(path) || !/\.[^/]+$/.test(path));
}

/** The stored page at `path`, or at its folder's index.html; null when neither is a page. */
export async function loadStored(path: string): Promise<StoredPage | null> {
  for (const candidate of [path, `${path.replace(/\/+$/, "")}/index.html`, `${path}.html`]) {
    if (!/\.html?$/i.test(candidate)) continue;
    const res = await fetch(wikiHref(candidate, "?format=html"));
    if (!res.ok) continue;
    const text = await res.text();
    const header = HEADER.exec(text)?.[0] ?? "";
    return { path: candidate, raw: text, header, body: text.slice(header.length).trim(), version: await versionOf(candidate) };
  }
  return null;
}

/** The header with its title set to `title`; a header that is not JSON stays as it was. */
function retitled(header: string, title: string): string {
  const json = HEADER.exec(header)?.[1];
  if (!json || !title) return header;
  try {
    const meta = JSON.parse(json) as Record<string, unknown>;
    if (meta.title === title) return header;
    return `<!--wiki\n${JSON.stringify({ ...meta, title })}\n-->\n`;
  } catch {
    return header;
  }
}

export type SaveResult = { ok: true; version: number | null } | { ok: false; status: number; error: string };

/** Write `content` over the page, as the version `baseVersion`; a stale base answers 409 and a write the prose lint refuses 422. */
export async function writePage(path: string, content: string, baseVersion: number | null, method: "PUT" | "POST" = "PUT"): Promise<SaveResult> {
  const res = await fetch(wikiHref(path), {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content, summary: method === "POST" ? "created in sw factory" : "edited in sw factory", allowTruncate: true, ...(baseVersion === null ? {} : { baseVersion }) }),
  });
  const body = (await res.json().catch(() => ({}))) as { version?: number; error?: string; message?: string };
  if (res.ok) return { ok: true, version: typeof body.version === "number" ? body.version : null };
  return { ok: false, status: res.status, error: body.error ?? body.message ?? `The wiki answered ${res.status}.` };
}

/** The first sentence of an engine error, which can run to a list of lint findings. */
export const shortError = (error: string): string => /^[^\n]*?[.!?](?=\s|$)/.exec(error.trim())?.[0] ?? error.trim().split("\n")[0]!;

/** A new page's title from its path: `release-notes.html` reads "Release notes". */
export function titleFromPath(path: string): string {
  const name = path.replace(/\/+$/, "").split("/").at(-1)?.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim() ?? "";
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : "Untitled";
}

/** Create the page a link names: an HTML path as it is, an extensionless one as `<path>.html`, which the wiki serves at both. */
export async function createPage(path: string): Promise<SaveResult & { path: string }> {
  const target = /\.html?$/i.test(path) ? path : `${path.replace(/\/+$/, "")}.html`;
  const title = titleFromPath(target);
  const content = `<!--wiki\n${JSON.stringify({ title })}\n-->\n<h1>${title.replace(/[&<>]/g, (c) => `&${({ "&": "amp", "<": "lt", ">": "gt" } as Record<string, string>)[c]};`)}</h1>\n<p><br></p>\n`;
  return { ...(await writePage(target, content, null, "POST")), path: target };
}

export type Editing = {
  page: StoredPage;
  /** Whether the text differs from the stored page. */
  dirty: () => boolean;
  /** The page to store: the header, retitled when the first heading changed, and the edited HTML. */
  content: () => string;
};

/**
 * Turn the frame's page into its stored HTML, editable in place with the wiki's own look, as a Slack canvas edits where it is read. Cmd S
 * and Cmd Enter save, Esc leaves an unchanged page, and a paste comes in as plain text so another page's styles stay out. Reloading the
 * frame ends the edit.
 */
export function startEditing(doc: Document, page: StoredPage, on: { save: () => void; cancel: () => void; change: () => void }, caret: "start" | "end" = "start"): Editing | null {
  const prose = doc.querySelector<HTMLElement>(".page-grid .prose, .prose");
  if (!prose) return null;
  prose.innerHTML = page.body;
  const baseline = prose.innerHTML;
  prose.contentEditable = "true";
  // Enter starts a <p>, as the stored pages write paragraphs, where Chrome would start a <div>.
  doc.execCommand("defaultParagraphSeparator", false, "p");
  prose.spellcheck = true;
  doc.documentElement.dataset.chatEditing = "";
  const dirty = () => prose.innerHTML !== baseline;
  prose.addEventListener("input", on.change);
  prose.addEventListener("paste", (event) => {
    const text = event.clipboardData?.getData("text/plain");
    if (text === undefined) return;
    event.preventDefault();
    doc.execCommand("insertText", false, text);
  });
  prose.addEventListener("keydown", (event) => {
    const mod = event.metaKey || event.ctrlKey;
    if (mod && !event.altKey && (event.key.toLowerCase() === "s" || event.key === "Enter")) {
      event.preventDefault();
      on.save();
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (!dirty()) on.cancel();
    }
  });
  prose.focus();
  // A new page opens with the caret in its empty first paragraph, under the title.
  if (caret === "end") doc.getSelection()?.selectAllChildren(prose.lastElementChild ?? prose);
  if (caret === "end") doc.getSelection()?.collapseToEnd();
  return {
    page,
    dirty,
    content: () => {
      const title = prose.querySelector("h1")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
      return `${retitled(page.header, title)}${prose.innerHTML.trim()}\n`;
    },
  };
}

/** The posts that link the page, newest first; none when the server cannot say. */
export async function sharesOf(path: string): Promise<WikiShare[]> {
  const res = await fetch(`/api/pages/shared?path=${encodeURIComponent(path)}`).catch(() => null);
  return res?.ok ? ((await res.json()) as WikiShare[]) : [];
}

export type ShareRow = { href: string; place: string; detail: string };

/**
 * A "Shared in" card under the page's Backlinks card in the wiki's side rail, drawn with the rail's own classes, so the posts that shared
 * the page sit beside the pages that link it. Each row's link is this app's address of the post, which the frame's link handler opens.
 */
export function showShares(doc: Document, rows: ShareRow[]): void {
  const key = JSON.stringify(rows);
  const drawn = doc.querySelector<HTMLElement>("[data-chat-shared]");
  if (drawn?.dataset.chatShared === key) return;
  drawn?.remove();
  const rail = doc.querySelector(".rail");
  if (!rail) return;
  const card = doc.createElement("section");
  card.className = "rail-card";
  card.dataset.chatShared = key;
  const heading = doc.createElement("h2");
  heading.append("Shared in ");
  const badge = doc.createElement("span");
  badge.className = "badge";
  badge.textContent = String(rows.length);
  heading.append(badge);
  card.append(heading);
  if (!rows.length) {
    const none = doc.createElement("p");
    none.className = "muted small";
    none.textContent = "No conversation has shared this page yet.";
    card.append(none);
  } else {
    const list = doc.createElement("div");
    list.className = "backlinks";
    for (const row of rows) {
      const link = doc.createElement("a");
      link.href = row.href;
      const place = doc.createElement("span");
      place.className = "bl-title";
      place.textContent = row.place;
      const detail = doc.createElement("span");
      detail.className = "bl-path";
      detail.textContent = row.detail;
      link.append(place, detail);
      list.append(link);
    }
    card.append(list);
  }
  rail.append(card);
}


/** A call to the wiki engine's agent API through this server's /wiki, as the owner. */
async function agentCall(method: "POST" | "DELETE", verb: string, body: Record<string, unknown>): Promise<SaveResult> {
  const query = method === "DELETE" ? `?${new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)]))}` : "";
  const res = await fetch(`/wiki/api/agent/${verb}${query}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(method === "DELETE" ? {} : { body: JSON.stringify(body) }),
  });
  const answer = (await res.json().catch(() => ({}))) as { version?: number; error?: string };
  return res.ok ? { ok: true, version: typeof answer.version === "number" ? answer.version : null } : { ok: false, status: res.status, error: answer.error ?? `The wiki answered ${res.status}.` };
}

/** Delete a page as the version the pane read; the engine keeps its bytes, so `restorePage` undoes it. */
export const deletePage = (page: StoredPage): Promise<SaveResult> =>
  agentCall("DELETE", "page", { path: page.path, author: "owner", ...(page.version === null ? {} : { baseVersion: page.version }) });

export const restorePage = (path: string): Promise<SaveResult> => agentCall("POST", "restore", { path, author: "owner" });

/** A typed move target as a page path: `notes/plan` reads `notes/plan.html`. */
export const pagePathOf = (typed: string): string => {
  const clean = typed.trim().replace(/^\/+/, "").replace(/^wiki:/, "");
  return /\.html?$/i.test(clean) ? clean : `${clean.replace(/\/+$/, "")}.html`;
};

/** Move a page; the old path redirects to the new one, and a move back undoes it. */
export const movePage = (from: string, to: string): Promise<SaveResult> => agentCall("POST", "move", { path: from, to, author: "owner" });


/**
 * Move the page the pane shows and follow it to its new path, with Undo in the toast that moves it back. Throws the engine's reason, which
 * the move dialog shows under its field.
 */
export async function moveAndFollow(from: string, typed: string): Promise<string> {
  const to = pagePathOf(typed);
  const moved = await movePage(from, to);
  if (!moved.ok) throw new Error(shortError(moved.error));
  const follow = (path: string) => {
    if (router.route.params.view?.startsWith("wiki:")) router.setParams({ view: `wiki:${path}` }, { replace: true });
  };
  follow(to);
  toast.success(`Moved to ${to}`, {
    duration: 10_000,
    action: {
      label: "Undo",
      run: () => void movePage(to, from).then((back) => {
        if (!back.ok) return void toast.error(`Could not move it back. ${shortError(back.error)}`);
        follow(from);
        toast.show("Move undone");
      }),
    },
  });
  return to;
}
