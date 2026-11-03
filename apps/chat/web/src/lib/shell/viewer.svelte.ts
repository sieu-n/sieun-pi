import { parseArtifactTarget } from "$lib/api/shared/artifact-link";
import { router } from "$lib/router.svelte";
import { setArtifactOpener } from "$lib/ui/artifact-opener";

/**
 * The artifact viewer: one popup over any page that shows a wiki page, a conversation or a chat's board, so a link in a message opens
 * here instead of a new tab or another page. What is open lives in the `view` param of the current route, so Back closes it, a reload
 * keeps it, and the page under it keeps its scroll and its draft.
 *
 *   ?view=wiki:<path>            the wiki page at /wiki/<path>, in a frame
 *   ?view=thread:<id>            a conversation's timeline with its composer
 *   ?view=board:<chat>[/<id>]    a chat's board, focused on one step or todo
 */
export type View =
  | { kind: "wiki"; path: string }
  | { kind: "thread"; id: string }
  | { kind: "board"; chatId: string; focus: string | null };

export function encodeView(view: View): string {
  switch (view.kind) {
    case "wiki": return `wiki:${view.path}`;
    case "thread": return `thread:${view.id}`;
    case "board": return `board:${view.chatId}${view.focus ? `/${view.focus}` : ""}`;
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
  return null;
}

/**
 * The entry `openView` pushed: its hash and the history length then. Closing goes back to the page while both still hold; once a frame
 * in the view has pushed entries of its own, Back would step the frame, so the close drops the param in place instead.
 */
let openedFrom: { at: string; length: number } | null = null;

export const currentView = (): View | null => parseView(router.route.params.view);

/** Open a view. A view opened from inside another one replaces it, so one close always returns to the page. */
export function openView(view: View): void {
  const replace = currentView() !== null;
  router.setParams({ view: encodeView(view) }, { replace });
  if (!replace) openedFrom = { at: location.hash, length: history.length };
  else if (openedFrom) openedFrom.at = location.hash;
}

/** Close the open view: back to the entry it was opened from, or drop the param in place for a view that came with the address. */
export function closeView(): void {
  if (openedFrom && openedFrom.at === location.hash && openedFrom.length === history.length) {
    openedFrom = null;
    history.back();
    return;
  }
  openedFrom = null;
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
