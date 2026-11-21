<script lang="ts">
  import { agents, jobs, me, type Item } from "$lib/api";
  import { conversationHref, hrefFor, router } from "$lib/router.svelte";
  import Button from "$lib/ui/Button.svelte";
  import Dialog from "$lib/ui/Dialog.svelte";
  import IconButton from "$lib/ui/IconButton.svelte";
  import Markdown from "$lib/ui/Markdown.svelte";
  import { wikiUrl } from "$lib/ui/markdown";
  import { modKey } from "$lib/ui/keyboard";
  import { toast } from "$lib/ui/toast.svelte";
  import BoardPanel from "$pages/board/BoardPanel.svelte";
  import SkillPane from "$pages/skills/SkillPane.svelte";
  import { skillView } from "$pages/skills/skill-view.svelte";
  import { boardHref } from "$pages/board/chips";
  import ThreadPane from "$pages/channel/ThreadPane.svelte";
  import ForwardDialog from "$pages/channel/ForwardDialog.svelte";
  import { directory } from "$pages/channel/directory.svelte";
  import { mentionContext } from "$pages/channel/present";
  import PanelHeader from "$lib/ui/PanelHeader.svelte";
  import { untrack } from "svelte";
  import { closeView, currentView, followWikiPage, openArtifactTarget, openView, parseView, viewedBlock, viewerStep, type View } from "./viewer.svelte";
  import { search } from "./search.svelte";
  import { sidePanel } from "./side-panel.svelte";
  import { styleWikiFrame } from "./wiki-embed";
  import { roomDraftKey } from "$lib/drafts.svelte";

  /**
   * What the viewer's `?view=` param opens (viewer.svelte.ts). A wiki page shows in a frame of this server's /wiki in the side panel beside
   * the page, as a Slack canvas does, so the conversation and its composer stay usable. A conversation's timeline, a chat's board, one skill
   * of Settings > Skills, or a post's table or code block at full size open in a popup over the page. Esc, the close button and Back close
   * either; a click outside closes the popup; Open in new tab takes the same thing to a tab of its own.
   */
  const view = $derived(currentView());
  const dialogView = $derived(view?.kind === "wiki" ? null : view);
  const block = $derived(view?.kind === "block" ? viewedBlock(view.id) : null);
  // A block lives in the page's memory, so after a reload its view has nothing to show and closes.
  $effect(() => {
    if (view?.kind === "block" && !block) closeView();
  });

  /** The wiki page on screen: the frame follows links inside the wiki, so its title and path are read back from the frame. */
  let frameTitle = $state("");
  let framePath = $state<string | null>(null);
  let frameFailed = $state(false);
  /** The frame shows only once the app's look is in it, so a dark app never flashes the wiki's white page. */
  let frameStyled = $state(false);
  let unstyle: (() => void) | null = null;
  const lastSegment = (path: string): string => path.split("/").filter(Boolean).filter((part) => part !== "index.html").at(-1) ?? path;
  const wikiPath = $derived(view?.kind === "wiki" ? view.path : null);
  /** A canvas's Share: the dialog that posts the page on screen into a channel or a DM. */
  let sharing = $state(false);
  const wikiTitle = $derived(wikiPath ? frameTitle || lastSegment(wikiPath) : "");
  let frame = $state<HTMLIFrameElement>();
  /** The frame's first address, set when the pane opens and kept, since a new `src` on a loaded frame would push a history entry. */
  let frameStart = $state("");
  /** The page the frame shows or is loading. A view path that differs moves the frame with location.replace, which adds no entry. */
  let frameTarget: string | null = null;
  /** Whether the wiki pane is the one this viewer put in the side panel. */
  let shown = false;
  const WIKI_PANE = "viewer:wiki";

  $effect(() => {
    if (!wikiPath) {
      if (shown) {
        shown = false;
        sidePanel.close(WIKI_PANE);
      }
      return;
    }
    if (!shown) {
      const path = untrack(() => wikiPath);
      frameTarget = path;
      frameStart = frameSrc(path);
      frameTitle = "";
      framePath = null;
      frameFailed = false;
      frameStyled = false;
    }
    sidePanel.open({ key: WIKI_PANE, title: wikiTitle, size: "wide", body: wikiBody, header: wikiHeader, onclose: closeWiki });
    shown = true;
  });
  // A thread or board pane opened over the wiki page takes the side panel, so the page leaves the address in place and Back brings it again.
  $effect(() => {
    const key = sidePanel.content?.key;
    if (shown && key && key !== WIKI_PANE) {
      shown = false;
      if (untrack(() => wikiPath)) router.setParams({ view: null }, { replace: true });
    }
  });
  $effect(() => {
    const path = wikiPath;
    if (!path || !frame || path === frameTarget) return;
    frameTarget = path;
    frame.contentWindow?.location.replace(frameSrc(path));
  });
  $effect(() => () => {
    unstyle?.();
    unstyle = null;
  });

  /** Close the wiki pane, unless the view already left the address and the pane is closing after it. */
  function closeWiki() {
    if (currentView()?.kind === "wiki") closeView();
  }

  const appHref = (hash: string): string => `${location.origin}${location.pathname}${hash}`;

  function threadName(id: string): string {
    return jobs.byId(id)?.name ?? agents.list.find((agent) => agents.room(agent.id) === id)?.name ?? directory.room(id)?.name ?? "Conversation";
  }

  const title = $derived.by(() => {
    if (!view) return "";
    switch (view.kind) {
      case "wiki": return frameTitle || lastSegment(view.path);
      case "thread": return threadName(view.id);
      case "board": return `Board of ${agents.byId(view.chatId)?.name ?? view.chatId}`;
      case "skill": return skillView.title(view.id);
      case "block": return block?.kind === "table" ? "Table" : "Code";
    }
  });
  const description = $derived.by(() => {
    if (!view) return "";
    switch (view.kind) {
      case "wiki": return "";
      case "thread": return jobs.byId(view.id) ? `Job thread of ${jobs.byId(view.id)?.parent?.name ?? "an agent"}` : "";
      case "board": return view.focus ? `Focused on ${view.focus}` : "";
      case "skill": return skillView.description(view.id);
      case "block": return block?.label ?? "";
    }
  });
  /** Where Open in new tab goes: the wiki's own page, or this app at the conversation or the board. */
  const tabHref = $derived.by(() => {
    if (!view) return "";
    switch (view.kind) {
      case "wiki": return wikiUrl(framePath ?? view.path);
      case "thread": return appHref(conversationHref(view.id));
      case "board": return appHref(boardHref(view.chatId, view.focus ?? undefined));
      case "skill": return appHref(hrefFor("settings", ["skills"], { view: `skill:${view.id}` }));
      case "block": return "";
    }
  });

  function copyBlock() {
    void navigator.clipboard.writeText(block?.markdown ?? "").then(
      () => toast.show(block?.kind === "table" ? "Table copied as markdown" : "Code copied"),
      () => toast.error("Could not copy"),
    );
  }

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
    frameStyled = true;
    if (!doc || !win) return;
    unstyle?.();
    unstyle = styleWikiFrame(doc);
    const read = () => {
      frameTitle = doc.title.replace(/\s*[·|–-]\s*llm-wiki\s*$/i, "").trim();
      framePath = pathOf(win.location.pathname);
      frameFailed = !doc.querySelector(".page, article, main");
    };
    read();
    // A page the frame reached on its own, such as by a redirect, becomes the view's path, so a reload and Copy link keep it.
    frameTarget = framePath ?? frameTarget;
    if (framePath && framePath !== wikiPath && parseView(`wiki:${framePath}`)) router.setParams({ view: `wiki:${framePath}` }, { replace: true });
    new MutationObserver(read).observe(doc.head, { childList: true, subtree: true, characterData: true });
    // Keys typed in the frame never reach this document, so Esc is caught in the frame too. Cmd K opens this app's search, before the
    // wiki's own page opener sees it (owner, p124: "llm-wiki opener is super unnatural. Cmd K should be the search").
    win.addEventListener("keydown", (event) => {
      if (modKey(event) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        event.stopImmediatePropagation();
        search.toggle({ kind: "global" });
      }
      // Cmd [ and Cmd ] step back and forward between the pages followed here, as they do in the app (App.svelte).
      if (modKey(event) && !event.altKey && !event.shiftKey && (event.key === "[" || event.key === "]")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.key === "[") history.back();
        else history.forward();
      }
    }, true);
    win.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !event.defaultPrevented) closeWiki();
    });
    // A link to another wiki page becomes a new entry of this app's address, so Back, the header's back arrow and a reload follow it, and
    // the frame moves in place, since an entry the frame pushed would make Back step the frame. A link out of the wiki opens in a tab, and
    // a link into this app opens here.
    doc.addEventListener("click", (event) => {
      // The frame's nodes belong to its own window, so `instanceof Element` of this window is false for them.
      const { Element: FrameElement } = win as Window & typeof globalThis;
      const link = event.target instanceof FrameElement ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!link || event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      let url: URL;
      try {
        url = new URL(link.href, win.location.href);
      } catch {
        return;
      }
      event.preventDefault();
      if (url.origin === win.location.origin && url.pathname === win.location.pathname && url.hash) {
        doc.getElementById(decodeURIComponent(url.hash.slice(1)))?.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      const next = url.origin === location.origin ? pathOf(url.pathname) : null;
      if (next && parseView(`wiki:${next}`)) {
        frameTarget = next;
        win.location.replace(url.href);
        followWikiPage(next);
      } else if (url.origin === location.origin && url.pathname.startsWith("/wiki/")) win.location.replace(url.href);
      else if (url.origin === location.origin && url.hash.startsWith("#/")) router.navigate(url.hash);
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

  const keyOf = (v: Exclude<View, { kind: "wiki" }>): string => (v.kind === "board" ? `board:${v.chatId}:${v.focus ?? ""}` : `${v.kind}:${v.id}`);
</script>

{#snippet headerActions()}
  {#if view?.kind === "block"}
    <Button size="sm" variant="ghost" icon="copy" onclick={copyBlock}>Copy</Button>
  {:else}
  {#if view?.kind === "thread" || view?.kind === "board"}<Button size="sm" variant="ghost" icon="arrow-right" onclick={goThere}>Go to {view?.kind === "board" ? "board" : "conversation"}</Button>{/if}
  {#if view?.kind === "wiki"}<IconButton icon="forward" label="Share" size="sm" onclick={() => (sharing = true)} data-share-page />{/if}
  <IconButton icon="link" label="Copy link" size="sm" onclick={copyLink} />
  {#if view?.kind === "wiki"}<IconButton icon="external" label="Open in new tab" size="sm" href={tabHref} target="_blank" />{:else}<Button size="sm" variant="ghost" icon="external" href={tabHref} target="_blank">Open in new tab</Button>{/if}
  {/if}
{/snippet}

{#snippet wikiHeader()}
  <PanelHeader closeLabel="Close page" onclose={() => sidePanel.close(WIKI_PANE)}>
    {#snippet titleContent()}
      {#if viewerStep() > 0}<IconButton icon="arrow-left" label="Back" shortcut="⌘[" size="sm" onclick={() => history.back()} />{/if}
      <h2 class="t-label-sm wiki-title">{wikiTitle}</h2>
    {/snippet}
    {#snippet actions()}{@render headerActions()}{/snippet}
  </PanelHeader>
{/snippet}

{#snippet wikiBody()}
  <div class="viewer in-panel" data-testid="artifact-viewer" data-view="wiki">
    <iframe bind:this={frame} class="wiki-frame" class:styled={frameStyled} src={frameStart} title={wikiTitle} onload={onFrameLoad}></iframe>
    {#if frameFailed}<p class="frame-note t-body-sm">The wiki did not show a page for {wikiPath}. Open in new tab shows what the wiki answered.</p>{/if}
  </div>
{/snippet}

{#if sharing && wikiPath}<ForwardDialog subject={{ kind: "wiki", path: framePath ?? wikiPath, title }} onclose={() => (sharing = false)} />{/if}

<Dialog open={dialogView !== null} {title} {description} presentation="sheet" {headerActions} onclose={closeView}>
  {#if dialogView}
    {#key keyOf(dialogView)}
      <div class="viewer" data-testid="artifact-viewer" data-view={dialogView.kind}>
        {#if dialogView.kind === "block"}
          {#if block}<div class="block-view"><Markdown text={block.markdown} {context} {onartifact} {onmention} /></div>{/if}
        {:else if dialogView.kind === "skill"}
          <SkillPane id={dialogView.id} />
        {:else if dialogView.kind === "thread"}
          <ThreadPane threadKey={dialogView.id} draftKey={roomDraftKey(dialogView.id)} {context} oncopylink={copyItemLink} onthread={(key) => openView({ kind: "thread", id: key })} {onmention} onboardid={(id, chatId) => openView({ kind: "board", chatId, focus: id })} {onartifact} />
        {:else if dialogView.kind === "board"}
          {@const chatId = dialogView.chatId}
          <div class="board"><BoardPanel {chatId} focus={dialogView.focus} onboardid={(id) => openView({ kind: "board", chatId, focus: id })} /></div>
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
  .in-panel {
    height: 100%;
  }
  .wiki-title {
    margin: 0 0 0 4px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .wiki-frame {
    flex: 1;
    width: 100%;
    min-height: 0;
    border: 0;
    background: var(--surface-panel);
    opacity: 0;
    /* The page in the frame takes the interface size on its own root (wiki-embed.ts), so the frame element undoes the app's. */
    zoom: calc(1 / var(--interface-scale, 1));
  }
  .wiki-frame.styled {
    opacity: 1;
    transition: opacity var(--duration-base) var(--ease-standard);
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
  /* A post's table or code block at full size: every row and line shows, and only a table wider than the sheet scrolls sideways. */
  .block-view {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 16px 24px 24px;
  }
  .block-view :global(.table-open),
  .block-view :global(.code-head),
  .block-view :global(.code-more) {
    display: none;
  }
  /* The sheet shows every character of a code block, so its long lines wrap here. */
  .block-view :global(pre) {
    padding-top: 12px;
  }
  .block-view :global(pre code) {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .block-view :global(table) {
    font-size: 14px;
    line-height: 20px;
  }
  .block-view :global(.code-block.folded pre) {
    --fold-mask: linear-gradient(#000, #000);
    max-height: none;
  }
  .board {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
</style>
