import { parseArtifactTarget, type ArtifactTarget } from "$lib/api/shared/artifact-link";
import { wikiUrl } from "$lib/ui/markdown";
import { router } from "$lib/router.svelte";

export interface LinkView { label: string; icon: string; target: ArtifactTarget | null; raw: string }

const ICONS: Record<ArtifactTarget["kind"] | "broken", string> = { job: "robot", thread: "messages", wiki: "file", file: "folder", url: "external", broken: "warning" };

function labelOf(target: ArtifactTarget | null, raw: string): string {
  if (!target) return raw;
  switch (target.kind) {
    case "job": return target.name;
    case "thread": return `thread ${target.sessionId.slice(0, 8)}`;
    case "wiki":
    case "file": return target.path.split("/").filter(Boolean).at(-1) ?? target.path;
    case "url": {
      const url = new URL(target.url);
      return url.hostname.replace(/^www\./, "") + (url.pathname.length > 1 && url.pathname.length <= 40 ? url.pathname.replace(/\/+$/, "") : "");
    }
  }
}

/** A todo's link as a chip: its label, an icon for its kind, and the parsed target (null when the page cannot open it). */
export function linkView(link: { label: string; target: string }): LinkView {
  const target = parseArtifactTarget(link.target);
  return { label: link.label.trim() || labelOf(target, link.target), icon: ICONS[target?.kind ?? "broken"], target, raw: link.target };
}

/** Open a link: a wiki page or URL in a new tab, a thread or a chat's job in Messages. A file path has no page to open. */
export function openTarget(target: ArtifactTarget, chatId: string): void {
  switch (target.kind) {
    case "wiki": window.open(wikiUrl(target.path), "_blank", "noopener"); return;
    case "url": window.open(target.url, "_blank", "noopener"); return;
    case "thread": router.openConversation(target.sessionId, {}); return;
    case "job": router.openConversation(chatId, { thread: target.name }); return;
    case "file": return;
  }
}
