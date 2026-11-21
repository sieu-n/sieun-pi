import { parseArtifactTarget } from "$lib/api/shared/artifact-link";
import { router } from "$lib/router.svelte";
import { setArtifactOpener, setBlockOpener, type BlockContent } from "$lib/ui/artifact-opener";
import { hashString } from "$lib/ui/hash";

/**
 * The artifact viewer: a wiki page in the side panel beside the page, or a popup over it for a conversation, a chat's board, a skill or a
 * post's block, so a link in a message opens here instead of a new tab or another page. What is open lives in the `view` param of the
 * current route, so Back closes it or returns to the wiki page a link left, a reload keeps it, and the page under it keeps its scroll and
 * its draft.
 *
 *   ?view=wiki:<path>            the wiki page at /wiki/<path>, in a frame
 *   ?view=thread:<id>            a conversation's timeline with its composer
 *   ?view=board:<chat>[/<id>]    a chat's board, focused on one step or todo
 *   ?view=skill:<id>             one skill of the Skills section in Settings: its inventory row and its SKILL.md
 *   ?view=block:<id>             a table or code block of a post, large; the block lives in this page's memory, so a reload closes it
 */
export type View =
  | { kind: "wiki"; path: string }
  | { kind: "thread"; id: string }
  | { kind: "board"; chatId: string; focus: string | null }
  | { kind: "skill"; id: string }
  | { kind: "block"; id: string };

export function encodeView(view: View): string {
  switch (view.kind) {
    case "wiki": return `wiki:${view.path}`;
    case "thread": return `thread:${view.id}`;
    case "board": return `board:${view.chatId}${view.focus ? `/${view.focus}` : ""}`;
    case "skill": return `skill:${view.id}`;
    case "block": return `block:${view.id}`;
  }
}

export function parseView(value: string | null | undefined): View | null {
  if (!value) return null;
  const colon = value.indexOf(":");
  const kind = value.slice(0, colon);
  const rest = value.slice(colon + 1);
  if (colon < 1 || !rest) return null;
  if (kind === "wiki") {
    const target = parseArtifactTarget(value);
    return target?.kind === "wiki" ? { kind: "wiki", path: target.path } : null;
  }
  if (kind === "thread") return /^[\w:.-]{1,200}$/.test(rest) ? { kind: "thread", id: rest } : null;
  if (kind === "board") {
    const [chatId = "", focus = null] = rest.split("/");
    return chatId ? { kind: "board", chatId, focus: focus || null } : null;
  }
  if (kind === "skill") return { kind: "skill", id: rest };
  if (kind === "block") return /^[a-z0-9]{1,13}$/.test(rest) ? { kind: "block", id: rest } : null;
  return null;
}

/**
 * The history.state the viewer writes on each entry it pushes. `step` counts the wiki pages followed inside the view before this entry,
 * `opened` says whether the view's first entry was pushed by `openView` (false for a view that came with the address), and `length` is
 * history.length when the entry was pushed. A close steps back past every viewer entry while `length` still holds; once a frame in the
 * view pushed entries of its own, or forward entries remain, Back would land elsewhere, so the close drops the param in place instead.
 */
type ViewerEntry = { viewerStep: number; viewerOpened: boolean; viewerLength: number };

function entryOf(state: unknown): ViewerEntry | null {
  const entry = state as Partial<ViewerEntry> | null;
  return typeof entry?.viewerStep === "number" && typeof entry.viewerLength === "number" ? { viewerStep: entry.viewerStep, viewerOpened: !!entry.viewerOpened, viewerLength: entry.viewerLength } : null;
}

const tag = (step: number, opened: boolean): void =>
  history.replaceState({ ...(history.state as object | null), viewerStep: step, viewerOpened: opened, viewerLength: history.length } satisfies ViewerEntry, "", location.href);

export const currentView = (): View | null => parseView(router.route.params.view);

/** How many pages the open view followed before this one, read again on each route change; Back in the view's header shows above 0. */
export function viewerStep(): number {
  void router.route;
  return entryOf(history.state)?.viewerStep ?? 0;
}

/** Push `view` as a new entry and tag it, unless the address already shows it. */
function push(view: View, step: number, opened: boolean, patch: Record<string, null> = {}): void {
  const before = location.hash;
  router.setParams({ view: encodeView(view), ...patch });
  if (location.hash !== before) tag(step, opened);
}

/**
 * Open a view. A view opened from inside another one replaces it, so one close always returns to the page. A wiki page shows in the side
 * panel, which holds one pane, so opening one drops the conversation's thread or board pane from the address.
 */
export function openView(view: View): void {
  const panes: Record<string, null> = view.kind === "wiki" ? { thread: null, board: null } : {};
  if (currentView() !== null) {
    router.setParams({ view: encodeView(view), ...panes }, { replace: true });
    return;
  }
  push(view, 0, true, panes);
}

/** Follow a link inside an open wiki page to another one: a new entry, so Back and the header's back arrow return to the page before. */
export function followWikiPage(path: string): void {
  if (currentView()?.kind !== "wiki") return openView({ kind: "wiki", path });
  let entry = entryOf(history.state);
  if (!entry) {
    tag(0, false);
    entry = entryOf(history.state)!;
  }
  push({ kind: "wiki", path }, entry.viewerStep + 1, entry.viewerOpened);
}

/** Close the open view: back past the entries the view pushed, or drop the param in place when Back would land elsewhere. */
export function closeView(): void {
  const entry = entryOf(history.state);
  const back = entry && entry.viewerLength === history.length ? entry.viewerStep + (entry.viewerOpened ? 1 : 0) : 0;
  if (back > 0) {
    // A view that came with the address has no entry of its own to go back to, so after stepping back to its first page the param goes.
    if (!entry?.viewerOpened) window.addEventListener("hashchange", () => router.setParams({ view: null }, { replace: true }), { once: true });
    history.go(-back);
    return;
  }
  if (router.route.params.view) router.setParams({ view: null }, { replace: true });
}

/**
 * Open what an artifact link names, a wiki page or a thread, in the viewer. False for any other target, such as a file path. A thread id
 * may be a job's `<thread>:<n>` conversation, which `parseArtifactTarget` does not take, so `thread:` is read here.
 */
export function openArtifactTarget(target: string): boolean {
  const thread = target.startsWith("thread:") ? parseView(target.replace(/@\d+$/, "")) : null;
  if (thread) {
    openView(thread);
    return true;
  }
  const parsed = parseArtifactTarget(target);
  if (parsed?.kind !== "wiki") return false;
  openView({ kind: "wiki", path: parsed.path });
  return true;
}

setArtifactOpener(openArtifactTarget);

/** The blocks opened in this page, by the hash of their markdown, so the same table opens under the same `?view=block:<id>`. */
const blocks = new Map<string, BlockContent>();

export const viewedBlock = (id: string): BlockContent | null => blocks.get(id) ?? null;

export function openBlockView(block: BlockContent): void {
  const id = hashString(block.markdown).toString(36);
  blocks.set(id, block);
  openView({ kind: "block", id });
}

setBlockOpener(openBlockView);
