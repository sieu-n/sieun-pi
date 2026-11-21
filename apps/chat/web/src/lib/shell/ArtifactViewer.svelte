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
  import { directory } from "$pages/channel/directory.svelte";
  import { mentionContext } from "$pages/channel/present";
  import { closeView, currentView, openArtifactTarget, openView, viewedBlock, type View } from "./viewer.svelte";
  import { search } from "./search.svelte";
  import { styleWikiFrame } from "./wiki-embed";

  /**
   * The popup the viewer's `?view=` param opens over any page (viewer.svelte.ts): a wiki page in a frame of this server's /wiki, a
   * conversation's timeline, a chat's board, one skill of Settings > Skills, or a post's table or code block at full size. Esc, the close button, a click outside and
   * Back close it; Open in new tab takes the same thing to a tab of its own.
   */
  const view = $derived(currentView());
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
  const wikiPath = $derived(view?.kind === "wiki" ? view.path : null);
  $effect(() => {
    void wikiPath;
    frameTitle = "";
    framePath = null;
    frameFailed = false;
    frameStyled = false;
    return () => {
      unstyle?.();
      unstyle = null;
    };
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
    new MutationObserver(read).observe(doc.head, { childList: true, subtree: true, characterData: true });
    // Keys typed in the frame never reach this document, so Esc is caught in the frame too. Cmd K opens this app's search, before the
    // wiki's own page opener sees it (owner, p124: "llm-wiki opener is super unnatural. Cmd K should be the search").
    win.addEventListener("keydown", (event) => {
      if (modKey(event) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        event.stopImmediatePropagation();
        search.toggle({ kind: "global" });
      }
    }, true);
    win.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !event.defaultPrevented) closeView();
    });
    // A wiki link loads in the frame in place, since an entry the frame pushed would make Back and closeView's history.back() step the
    // frame instead of closing. A link out of the wiki opens in a tab, and a link into this app opens here.
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
      if (url.origin === location.origin && url.pathname.startsWith("/wiki/")) win.location.replace(url.href);
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

  const keyOf = (v: View): string => (v.kind === "board" ? `board:${v.chatId}:${v.focus ?? ""}` : v.kind === "wiki" ? `wiki:${v.path}` : `${v.kind}:${v.id}`);
</script>

{#snippet headerActions()}
  {#if view?.kind === "block"}
    <Button size="sm" variant="ghost" icon="copy" onclick={copyBlock}>Copy</Button>
  {:else}
  {#if view?.kind === "thread" || view?.kind === "board"}<Button size="sm" variant="ghost" icon="arrow-right" onclick={goThere}>Go to {view?.kind === "board" ? "board" : "conversation"}</Button>{/if}
  <IconButton icon="link" label="Copy link" size="sm" onclick={copyLink} />
  <Button size="sm" variant="ghost" icon="external" href={tabHref} target="_blank">Open in new tab</Button>
  {/if}
{/snippet}

<Dialog open={view !== null} {title} {description} presentation="sheet" {headerActions} onclose={closeView}>
  {#if view}
    {#key keyOf(view)}
      <div class="viewer" data-testid="artifact-viewer" data-view={view.kind}>
        {#if view.kind === "wiki"}
          <iframe class="wiki-frame" class:styled={frameStyled} src={frameSrc(view.path)} title={title} onload={onFrameLoad}></iframe>
          {#if frameFailed}<p class="frame-note t-body-sm">The wiki did not show a page for {view.path}. Open in new tab shows what the wiki answered.</p>{/if}
        {:else if view.kind === "block"}
          {#if block}<div class="block-view"><Markdown text={block.markdown} {context} {onartifact} {onmention} /></div>{/if}
        {:else if view.kind === "skill"}
          <SkillPane id={view.id} />
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
    background: var(--surface-popover);
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
