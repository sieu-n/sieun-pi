<script lang="ts">
  import { agents, jobs, me, type Item } from "$lib/api";
  import { conversationHref, hrefFor, router } from "$lib/router.svelte";
  import Button from "$lib/ui/Button.svelte";
  import Dialog from "$lib/ui/Dialog.svelte";
  import IconButton from "$lib/ui/IconButton.svelte";
  import { later } from "$lib/later.svelte";
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
  import { createPage, deletePage, editable, loadStored, restorePage, type StoredPage, runsScript, sharesOf, shortError, showShares, startEditing, titleFromPath, wikiHref, writePage, type Editing } from "./wiki-page";
  import EmptyState from "$lib/ui/EmptyState.svelte";
  import Menu from "$lib/ui/Menu.svelte";
  import type { MenuEntry } from "$lib/ui/menu";
  import { renameDialog } from "./rename-dialog.svelte";
  import { stampLabel } from "$lib/ui/datetime";
  import type { WikiShare } from "$lib/api/types";
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
  /** The wiki has no page at the pane's path, so the pane offers a search and a new page instead of the wiki's 404. */
  let frameMissing = $state(false);
  /** The frame shows only once the app's look is in it, so a dark app never flashes the wiki's white page. */
  let frameStyled = $state(false);
  let unstyle: (() => void) | null = null;
  const lastSegment = (path: string): string => path.split("/").filter(Boolean).filter((part) => part !== "index.html").at(-1) ?? path;
  const wikiPath = $derived(view?.kind === "wiki" ? view.path : null);
  later.start();
  /** A canvas's Share: the dialog that posts the page on screen into a channel or a DM. */
  let sharing = $state(false);
  const wikiTitle = $derived(wikiPath ? (frameMissing ? "" : frameTitle) || lastSegment(wikiPath) : "");
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
      if (untrack(() => editing?.dirty())) void untrack(() => saveEdit({ reload: false }));
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

  /**
   * The in-place edit of the page on screen (wiki-page.ts), null while the page reads. `editDirty` follows its input. Saving and closing
   * the pane with changes both store them, as a Slack canvas keeps what was typed.
   */
  let editing = $state<Editing | null>(null);
  let editDirty = $state(false);
  let saving = $state(false);
  /** Edit the page once the frame has loaded it, after Create page. */
  let editOnLoad = false;
  let frameDoc: Document | null = null;

  async function startEdit(caret: "start" | "end" = "start") {
    const path = framePath ?? wikiPath;
    if (!path || !frameDoc || editing) return;
    const doc = frameDoc;
    const page = await loadStored(path);
    if (!page) return void toast.error("Could not read this page to edit it");
    if (runsScript(page.body)) {
      toast.show("This page runs scripts, so it edits in the wiki's own editor", { action: { label: "Open editor", run: () => window.open(wikiHref(`edit/${page.path}`), "_blank", "noopener") } });
      return;
    }
    if (doc !== frameDoc) return;
    editing = startEditing(doc, page, { save: () => void saveEdit(), cancel: cancelEdit, change: () => (editDirty = editing?.dirty() ?? false) }, caret);
    editDirty = false;
  }

  function reloadFrame() {
    frame?.contentWindow?.location.replace(frameSrc(framePath ?? wikiPath ?? ""));
  }

  function cancelEdit() {
    const wasDirty = editing?.dirty();
    editing = null;
    editDirty = false;
    if (wasDirty !== undefined) reloadFrame();
  }

  /** Store the edit and show the page as the wiki renders it, with Undo in the toast that writes the page as it was. */
  async function saveEdit(opts: { reload?: boolean } = {}) {
    const edit = editing;
    if (!edit || saving) return;
    if (!edit.dirty()) return cancelEdit();
    const { page } = edit;
    const content = edit.content();
    saving = true;
    const saved = await writePage(page.path, content, page.version);
    saving = false;
    if (!saved.ok) {
      const why = saved.status === 409 ? "Someone changed this page while you edited it" : shortError(saved.error);
      toast.error(`Page not saved. ${why}`, { duration: 0, action: { label: "Copy my text", run: () => void navigator.clipboard.writeText(content) } });
      return;
    }
    if (editing === edit) {
      editing = null;
      editDirty = false;
      if (opts.reload !== false) reloadFrame();
    }
    const before = page.raw;
    toast.success("Page saved", {
      duration: 10_000,
      action: {
        label: "Undo",
        run: () => void writePage(page.path, before, saved.version).then((back) => {
          if (!back.ok) return void toast.error(`Could not undo. ${shortError(back.error)}`);
          toast.show("Edit undone");
          if (currentView()?.kind === "wiki") reloadFrame();
        }),
      },
    });
  }

  let moreOpen = $state(false);
  let moreAnchor = $state<HTMLButtonElement>();
  /** The pane's More menu: move the page to a new path, which its old path keeps redirecting to, or delete it with Undo in the toast. */
  const moreItems: MenuEntry[] = [
    { id: "move", label: "Move…", icon: "folder", onselect: () => void moveCurrent() },
    { type: "separator" },
    { id: "delete", label: "Delete page", icon: "trash", tone: "danger", onselect: () => void deleteCurrent() },
  ];

  async function storedPage(): Promise<StoredPage | null> {
    const path = framePath ?? wikiPath;
    const page = path ? await loadStored(path) : null;
    if (!page) toast.error("Could not read this page");
    return page;
  }

  async function moveCurrent() {
    const page = await storedPage();
    if (page) renameDialog.open(page.path, page.path, "page");
  }

  async function deleteCurrent() {
    const page = await storedPage();
    if (!page) return;
    const name = wikiTitle;
    const gone = await deletePage(page);
    if (!gone.ok) return void toast.error(`Page not deleted. ${shortError(gone.error)}`);
    reloadFrame();
    toast.show(`Deleted ${name}`, {
      duration: 10_000,
      action: {
        label: "Undo",
        run: () => void restorePage(page.path).then((back) => {
          if (!back.ok) return void toast.error(`Could not restore the page. ${shortError(back.error)}`);
          toast.show("Page restored");
          if (currentView()?.kind === "wiki") reloadFrame();
        }),
      },
    });
  }

  async function createMissing() {
    const path = wikiPath;
    if (!path) return;
    const made = await createPage(path);
    if (!made.ok) return void toast.error(`Could not create the page. ${shortError(made.error)}`);
    editOnLoad = true;
    frameTarget = made.path;
    frame?.contentWindow?.location.replace(frameSrc(made.path));
  }

  /** The "Shared in" card in the page's side rail: each post that links the page, with its place, author and time. */
  let shares = $state<{ doc: Document; list: WikiShare[] } | null>(null);
  async function loadShares(doc: Document, path: string) {
    const list = await sharesOf(path);
    if (doc === frameDoc) shares = { doc, list };
  }
  // Drawn again when the room and agent names load, which can come after the shares.
  $effect(() => {
    if (!shares || shares.doc !== frameDoc) return;
    showShares(shares.doc, shares.list.map((share) => ({
      href: appHref(conversationHref(share.room, { thread: share.threadRoot ?? null, messageId: share.post })),
      place: `${placeOf(share.room)} · ${share.author === "owner" ? "You" : (agents.byId(share.author)?.name ?? share.author)} · ${stampLabel(share.at)}`,
      detail: share.snippet,
    })));
  });

  function placeOf(room: string): string {
    const dm = agents.list.find((agent) => agents.room(agent.id) === room);
    if (dm) return dm.name;
    const row = directory.room(room);
    return row ? `${row.kind === "channel" ? "#" : ""}${row.name}` : room;
  }

  /** Close the wiki pane, unless the view already left the address and the pane is closing after it. */
  function closeWiki() {
    if (editing?.dirty()) void saveEdit({ reload: false });
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
    editing = null;
    editDirty = false;
    frameMissing = false;
    frameDoc = doc;
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
    const here = framePath ?? wikiPath;
    if (frameFailed && here) {
      void fetch(wikiHref(here, "?format=md&lines=1-1")).then((res) => {
        if (doc === frameDoc) frameMissing = res.status === 404;
      });
    } else if (here) {
      void loadShares(doc, here);
      if (editOnLoad) void startEdit("end");
    }
    editOnLoad = false;
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
      if (!link || link.isContentEditable || event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
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
  {#if view?.kind === "wiki" && editing}
    <Button size="sm" variant="ghost" onclick={cancelEdit} disabled={saving}>{editDirty ? "Discard" : "Done"}</Button>
    <Button size="sm" variant="primary" onclick={() => void saveEdit()} loading={saving} disabled={!editDirty} title="Save (⌘S)" data-wiki-save>Save</Button>
  {:else}
  {#if view?.kind === "wiki" && !frameFailed && editable(framePath ?? wikiPath ?? "")}<IconButton icon="edit" label="Edit" size="sm" onclick={() => void startEdit()} data-wiki-edit />{/if}
  {#if view?.kind === "wiki"}<IconButton icon="forward" label="Share" size="sm" onclick={() => (sharing = true)} data-share-page />{/if}
  {#if view?.kind === "wiki" && wikiPath}
    {@const pageSaved = !!later.pageRow(framePath ?? wikiPath)}
    <IconButton icon={pageSaved ? "bookmark-filled" : "bookmark"} label={pageSaved ? "Remove from Later" : "Save for later"} size="sm" pressed={pageSaved} onclick={() => wikiPath && void later.togglePage(framePath ?? wikiPath, title)} data-save-page />
  {/if}
  <IconButton icon="link" label="Copy link" size="sm" onclick={copyLink} />
  {#if view?.kind === "wiki"}<IconButton icon="external" label="Open in new tab" size="sm" href={tabHref} target="_blank" />{:else}<Button size="sm" variant="ghost" icon="external" href={tabHref} target="_blank">Open in new tab</Button>{/if}
  {#if view?.kind === "wiki" && !frameFailed && editable(framePath ?? wikiPath ?? "")}<IconButton icon="more" label="More actions" size="sm" bind:element={moreAnchor} onclick={() => (moreOpen = !moreOpen)} data-wiki-more />{/if}
  {/if}
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
    {#if frameMissing && wikiPath}
      {@const name = titleFromPath(wikiPath)}
      <div class="missing" data-wiki-missing>
        <EmptyState icon="file" title="This page doesn't exist" description={`Nothing is at ${wikiPath}. It may have moved, or nobody has written it yet.`}>
          {#snippet action()}
            <Button size="sm" variant="outline" icon="search" onclick={() => search.open({ kind: "global" }, name)}>Search for “{name}”</Button>
            <Button size="sm" variant="primary" icon="edit" onclick={() => void createMissing()}>Create page</Button>
          {/snippet}
        </EmptyState>
      </div>
    {:else if frameFailed}<p class="frame-note t-body-sm">The wiki did not show a page for {wikiPath}. Open in new tab shows what the wiki answered.</p>{/if}
  </div>
{/snippet}

<Menu bind:open={moreOpen} anchor={moreAnchor} items={moreItems} placement="bottom-end" label="Page actions" />
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
  .missing {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
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
