<script lang="ts">
  import { agents, jobs, me, type Item } from "$lib/api";
  import { conversationHref, router } from "$lib/router.svelte";
  import Button from "$lib/ui/Button.svelte";
  import Dialog from "$lib/ui/Dialog.svelte";
  import IconButton from "$lib/ui/IconButton.svelte";
  import { wikiUrl } from "$lib/ui/markdown";
  import { toast } from "$lib/ui/toast.svelte";
  import BoardPanel from "$pages/board/BoardPanel.svelte";
  import { boardHref } from "$pages/board/chips";
  import ThreadPane from "$pages/channel/ThreadPane.svelte";
  import { directory } from "$pages/channel/directory.svelte";
  import { mentionContext } from "$pages/channel/present";
  import { closeView, currentView, openArtifactTarget, openView, type View } from "./viewer.svelte";

  /**
   * The popup the viewer's `?view=` param opens over any page (viewer.svelte.ts): a wiki page in a frame of this server's /wiki, a
   * conversation's timeline, or a chat's board. Esc, the close button, a click outside and Back close it; Open in new tab takes the same
   * thing to a tab of its own.
   */
  const view = $derived(currentView());

  /** The wiki page on screen: the frame follows links inside the wiki, so its title and path are read back from the frame. */
  let frameTitle = $state("");
  let framePath = $state<string | null>(null);
  let frameFailed = $state(false);
  const wikiPath = $derived(view?.kind === "wiki" ? view.path : null);
  $effect(() => {
    void wikiPath;
    frameTitle = "";
    framePath = null;
    frameFailed = false;
  });

  const appHref = (hash: string): string => `${location.origin}${location.pathname}${hash}`;
  const lastSegment = (path: string): string => path.split("/").filter(Boolean).filter((part) => part !== "index.html").at(-1) ?? path;

  function threadName(id: string): string {
    return jobs.byId(id)?.name ?? agents.list.find((agent) => agents.room(agent.id) === id)?.name ?? directory.room(id)?.name ?? "Conversation";
  }

  const title = $derived.by(() => {
    if (!view) return "";
    switch (view.kind) {
      case "wiki": return frameTitle || lastSegment(view.path);
      case "thread": return threadName(view.id);
      case "board": return `Board of ${agents.byId(view.chatId)?.name ?? view.chatId}`;
    }
  });
  const description = $derived.by(() => {
    if (!view) return "";
    switch (view.kind) {
      case "wiki": return `wiki: ${framePath ?? view.path}`;
      case "thread": return jobs.byId(view.id) ? `Job thread of ${jobs.byId(view.id)?.parent?.name ?? "an agent"}` : view.id;
      case "board": return view.focus ? `Focused on ${view.focus}` : "";
    }
  });
  /** Where Open in new tab goes: the wiki's own page, or this app at the conversation or the board. */
  const tabHref = $derived.by(() => {
    if (!view) return "";
    switch (view.kind) {
      case "wiki": return wikiUrl(framePath ?? view.path);
      case "thread": return appHref(conversationHref(view.id));
      case "board": return appHref(boardHref(view.chatId, view.focus ?? undefined));
    }
  });

  function copyLink() {
    void navigator.clipboard.writeText(tabHref).then(
      () => toast.show("Link copied"),
      () => toast.error("Could not copy the link"),
    );
  }

  /** Go to the conversation or the board itself; the route change drops `?view`, so the popup closes. */
  function goThere() {
    if (view?.kind === "thread") router.openConversation(view.id);
    else if (view?.kind === "board") router.navigate(boardHref(view.chatId, view.focus ?? undefined));
  }

  /** The /wiki path of a page, each segment encoded. */
  const frameSrc = (path: string): string => `/wiki/${path.split("/").map(encodeURIComponent).join("/")}`;

  /** The wiki's own top bar and page tree are hidden in the popup; its page, contents and backlinks stay. */
  const EMBED_CSS = ".topbar, .browse-btn, .rail-tab, .tree-rail { display: none !important; } .body { grid-template-columns: minmax(0, 1fr) !important; }";

  /** The content path of a frame location such as /wiki/page/<path> or /wiki/<path>, or null for a wiki route that is not a page. */
  function pathOf(pathname: string): string | null {
    const match = /^\/wiki\/(?:page\/)?(.+)$/.exec(pathname);
    return match ? decodeURIComponent(match[1]!) : null;
  }

  function onFrameLoad(e: Event) {
    const frame = e.currentTarget as HTMLIFrameElement;
    let doc: Document | null = null;
    try {
      doc = frame.contentDocument;
    } catch {
      doc = null;
    }
    const win = frame.contentWindow;
    if (!doc || !win) return;
    if (!doc.querySelector("style[data-chat-embed]")) {
      const style = doc.createElement("style");
      style.dataset.chatEmbed = "";
      style.textContent = EMBED_CSS;
      doc.head.append(style);
    }
    const read = () => {
      frameTitle = doc.title.replace(/\s*[·|–-]\s*llm-wiki\s*$/i, "").trim();
      framePath = pathOf(win.location.pathname);
      frameFailed = !doc.querySelector(".page, article, main");
    };
    read();
    new MutationObserver(read).observe(doc.head, { childList: true, subtree: true, characterData: true });
    // Keys typed in the frame never reach this document, so Esc is caught in the frame too.
    win.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !event.defaultPrevented) closeView();
    });
    // A wiki link stays in the frame; a link out of the wiki opens in a tab, and a link into this app opens here.
    doc.addEventListener("click", (event) => {
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!link || event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      let url: URL;
      try {
        url = new URL(link.href, win.location.href);
      } catch {
        return;
      }
      if (url.origin === location.origin && url.pathname.startsWith("/wiki/")) return;
      event.preventDefault();
      if (url.origin === location.origin && url.hash.startsWith("#/")) router.navigate(url.hash);
      else window.open(url.href, "_blank", "noopener");
    }, true);
  }

  const context = $derived({ mentions: mentionContext(directory.agents, directory.channels, me.value?.owner.name ?? ""), plain: true });

  function copyItemLink(item: Item, conversation: string) {
    void navigator.clipboard.writeText(appHref(conversationHref(conversation, { messageId: item.id }))).then(() => toast.show("Link copied"));
  }

  function onartifact(target: string) {
    if (target.startsWith("job:")) {
      const job = jobs.list.find((row) => row.name === target.slice(4));
      if (job) openView({ kind: "thread", id: job.id });
      else toast.show(`No job named ${target.slice(4)}`);
      return;
    }
    openArtifactTarget(target);
  }

  function onmention(id: string, kind: string) {
    if (id === "owner") return;
    if (kind === "channel") router.openConversation(id);
    else if (kind === "agent") router.openConversation(agents.room(id));
  }

  const keyOf = (v: View): string => (v.kind === "wiki" ? `wiki:${v.path}` : v.kind === "thread" ? `thread:${v.id}` : `board:${v.chatId}:${v.focus ?? ""}`);
</script>

{#snippet headerActions()}
  {#if view?.kind !== "wiki"}<Button size="sm" variant="ghost" icon="arrow-right" onclick={goThere}>Go to {view?.kind === "board" ? "board" : "conversation"}</Button>{/if}
  <IconButton icon="link" label="Copy link" size="sm" onclick={copyLink} />
  <Button size="sm" variant="ghost" icon="external" href={tabHref} target="_blank">Open in new tab</Button>
{/snippet}

<Dialog open={view !== null} {title} {description} presentation="sheet" {headerActions} onclose={closeView}>
  {#if view}
    {#key keyOf(view)}
      <div class="viewer" data-testid="artifact-viewer" data-view={view.kind}>
        {#if view.kind === "wiki"}
          <iframe class="wiki-frame" src={frameSrc(view.path)} title={title} onload={onFrameLoad}></iframe>
          {#if frameFailed}<p class="frame-note t-body-sm">The wiki did not show a page for {view.path}. Open in new tab shows what the wiki answered.</p>{/if}
        {:else if view.kind === "thread"}
          <ThreadPane threadKey={view.id} {context} oncopylink={copyItemLink} onthread={(key) => openView({ kind: "thread", id: key })} {onmention} onboardid={(id, chatId) => openView({ kind: "board", chatId, focus: id })} {onartifact} />
        {:else}
          {@const chatId = view.chatId}
          <div class="board"><BoardPanel {chatId} focus={view.focus} onboardid={(id) => openView({ kind: "board", chatId, focus: id })} /></div>
        {/if}
      </div>
    {/key}
  {/if}
</Dialog>

<style>
  .viewer {
    position: relative;
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
  }
  .wiki-frame {
    flex: 1;
    width: 100%;
    min-height: 0;
    border: 0;
    background: var(--surface-panel);
  }
  .frame-note {
    position: absolute;
    right: 16px;
    bottom: 16px;
    left: 16px;
    margin: 0;
    padding: 8px 12px;
    border-radius: var(--radius-container);
    background: var(--surface-popover);
    box-shadow: var(--shadow-float);
    color: var(--text-subtle);
  }
  .board {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
</style>
