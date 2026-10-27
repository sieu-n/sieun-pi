<script lang="ts">
  import { onDestroy } from "svelte";
  import { agents, me, timeline, type Item } from "$lib/api";
  import { conversationHref, router } from "$lib/router.svelte";
  import { search } from "$lib/shell/search.svelte";
  import { sidePanel } from "$lib/shell/side-panel.svelte";
  import AvatarStack from "$lib/ui/AvatarStack.svelte";
  import IconButton from "$lib/ui/IconButton.svelte";
  import Menu from "$lib/ui/Menu.svelte";
  import PanelHeader from "$lib/ui/PanelHeader.svelte";
  import TypingDots from "$lib/ui/TypingDots.svelte";
  import { modKey } from "$lib/ui/keyboard";
  import { wikiUrl } from "$lib/ui/markdown";
  import type { MenuEntry } from "$lib/ui/menu";
  import { toast } from "$lib/ui/toast.svelte";
  import type { Status } from "$lib/ui/types";
  import Composer from "./Composer.svelte";
  import ThreadPane from "./ThreadPane.svelte";
  import Timeline from "./Timeline.svelte";
  import { directory } from "./directory.svelte";
  import { avatarKind, mentionContext, withPartial, type Outgoing } from "./present";

  type Props = { id: string; around?: string };
  let { id, around }: Props = $props();

  // svelte-ignore state_referenced_locally
  const store = timeline(id, around ? { around } : {});
  let leaving = false;
  onDestroy(() => {
    leaving = true;
    store.close();
    if (paneKey) sidePanel.close(paneKey);
  });

  const header = $derived(store.header);
  const summary = $derived(header?.summary ?? null);
  const kind = $derived(summary?.kind ?? (id.startsWith("ch_") ? "channel" : "solo"));
  const isChannel = $derived(kind === "channel");
  const name = $derived(summary?.name ?? "");
  const agent = $derived(header?.agent ?? null);
  const author = $derived(agent ? { id: agent.id, kind: agent.kind, name: agent.name, avatar: agent.avatar } : null);
  const items = $derived(withPartial(store.items, store.partial, author));
  const waiting = $derived(store.status === "sleeping");
  const liveLabel = $derived(
    store.partial?.tool ? `Running ${store.partial.tool}` : store.partial?.thinking && !store.partial.text ? "Thinking" : waiting ? "Waiting for a model slot" : null,
  );
  const others = $derived(header?.members.filter((m) => m.principal.id !== "owner") ?? []);
  const working = $derived(store.status === "working");
  const workingNames = $derived(
    summary?.working.length ? summary.working.map((w) => w.name) : working && agent ? [agent.name] : working && others.length === 1 ? [others[0]!.principal.name] : [],
  );
  const context = $derived({ mentions: mentionContext(directory.agents, directory.channels, me.value?.owner.name ?? ""), plain: true });
  const boardChat = $derived(isChannel ? (header?.homeChat ?? null) : agent?.kind === "chat" ? agent.id : null);

  function statusOf(principal: string): Status | null {
    const status = agents.byId(principal)?.status;
    return status === "working" ? "online" : status === "sleeping" ? "away" : status === "failed" ? "busy" : null;
  }

  const threadParam = $derived(router.route.params.thread ?? null);
  let paneKey: string | null = null;
  const threadTitle = $derived.by(() => {
    if (!threadParam) return "";
    if (isChannel) {
      const root = store.items.find((item) => item.id === threadParam);
      const text = root && root.kind !== "system" ? root.text.replace(/\s+/g, " ").trim() : "";
      return text ? (text.length > 40 ? `${text.slice(0, 39)}…` : text) : "Thread";
    }
    for (const item of store.items) if (item.kind === "turn") for (const job of item.jobs) if (job.conversation === threadParam) return job.name;
    return agents.byId(threadParam)?.name ?? "Thread";
  });

  $effect(() => {
    const key = threadParam;
    const title = threadTitle;
    if (!key) {
      if (paneKey) sidePanel.close(paneKey);
      paneKey = null;
      return;
    }
    paneKey = `thread:${key}`;
    sidePanel.open({ key: paneKey, title, icon: isChannel ? "thread" : "robot", body: pane, onclose: () => {
      if (!leaving) router.setParams({ thread: null });
    } });
  });

  let composer = $state<Composer>();
  let menuOpen = $state(false);
  let menuAnchor = $state<HTMLButtonElement>();
  let readTimer: ReturnType<typeof setTimeout> | undefined;

  function markRead() {
    clearTimeout(readTimer);
    readTimer = setTimeout(() => {
      if (document.visibilityState === "visible") void store.markRead().catch(() => undefined);
    }, 400);
  }

  function linkFor(item: Item, conversation = id): string {
    return `${location.origin}${location.pathname}${conversationHref(conversation, { messageId: item.id })}`;
  }
  function copyLink(item: Item, conversation = id) {
    void navigator.clipboard.writeText(linkFor(item, conversation)).then(
      () => toast.show("Link copied"),
      () => toast.error("Could not copy the link"),
    );
  }

  function openThread(key: string) {
    router.setParams({ thread: key });
  }

  function onmention(target: string, mentionKind: string) {
    if (target === "owner") return;
    if (mentionKind === "channel" || mentionKind === "agent") router.openConversation(target);
  }

  function onartifact(target: string, e: MouseEvent) {
    const [scheme, ...restParts] = target.split(":");
    const value = restParts.join(":");
    if (scheme === "job") {
      for (const item of store.items) if (item.kind === "turn") for (const job of item.jobs) if (job.name === value || job.conversation.endsWith(`:${value}`)) return openThread(job.conversation);
      const byName = agents.list.find((a) => a.kind === "job" && a.name === value);
      if (byName) router.openConversation(byName.id);
      else toast.show(`No job named ${value} in this chat`);
    } else if (scheme === "thread") {
      router.openConversation(value);
    } else if (scheme === "wiki") {
      window.open(wikiUrl(value), "_blank", "noopener");
    } else {
      e.preventDefault();
      void navigator.clipboard.writeText(value).then(() => toast.show("Path copied"));
    }
  }

  function onboardid(boardId: string, chatId: string) {
    router.navigate(`#/board/${encodeURIComponent(chatId || boardChat || "")}?focus=${encodeURIComponent(boardId)}`);
  }

  async function send(out: Outgoing) {
    await store.send(out.text, { images: out.images, mentions: out.mentions });
  }

  function stop() {
    void store.stop().then(
      () => toast.show("Stopping"),
      (error: unknown) => toast.error(error instanceof Error ? error.message : "Could not stop"),
    );
  }

  const menuItems = $derived<MenuEntry[]>([
    { id: "search", label: "Search in this conversation", icon: "search", shortcut: "⌘F", onselect: () => search.open({ kind: "conversation", id }) },
    { id: "link", label: "Copy link", icon: "link", onselect: () => void navigator.clipboard.writeText(`${location.origin}${location.pathname}${conversationHref(id)}`).then(() => toast.show("Link copied")) },
    ...(boardChat ? [{ id: "board", label: "Open board", icon: "board", onselect: () => router.navigate(`#/board/${encodeURIComponent(boardChat)}`) }] : []),
    ...(working ? [{ type: "separator" as const }, { id: "stop", label: "Stop", icon: "stop", onselect: stop }] : []),
  ]);

  function onkeydown(e: KeyboardEvent) {
    if (modKey(e) && !e.shiftKey && e.key.toLowerCase() === "l") {
      e.preventDefault();
      composer?.focus();
    }
  }
</script>

<svelte:window {onkeydown} />

{#snippet pane()}
  {#if threadParam}
    {#key threadParam}
      <ThreadPane
        channel={isChannel ? id : null}
        threadKey={threadParam}
        {context}
        {statusOf}
        oncopylink={copyLink}
        onthread={openThread}
        {onmention}
        {onboardid}
        {onartifact}
      />
    {/key}
  {/if}
{/snippet}

{#snippet titleContent()}
  <h1 class="title t-label-sm" data-testid="conversation-title">{name}</h1>
  {#if header?.purpose}<span class="purpose">{header.purpose}</span>{/if}
{/snippet}

{#snippet actions()}
  {#if others.length}
    <span class="members" title={others.map((m) => m.principal.name).join(", ")}>
      <AvatarStack members={others.map((m) => ({ id: m.principal.id, name: m.principal.name, kind: avatarKind(m.principal) }))} size={20} max={3} />
    </span>
  {/if}
  {#if working}
    <IconButton icon="stop" label="Stop" size="sm" onclick={stop} data-testid="header-stop" />
  {/if}
  {#if boardChat}
    <IconButton icon="board" label="Board" size="sm" onclick={() => router.navigate(`#/board/${encodeURIComponent(boardChat)}`)} />
  {/if}
  <IconButton icon="more" label={isChannel ? "Channel actions" : "Chat actions"} size="sm" bind:element={menuAnchor} onclick={() => (menuOpen = !menuOpen)} />
{/snippet}

<section class="conversation" data-conversation={id} data-kind={kind}>
  <PanelHeader icon={isChannel ? "hash" : kind === "solo" ? "chat" : "robot"} {titleContent} {actions} />
  <Timeline
    {items}
    loading={store.loading}
    error={store.error}
    hasOlder={!!store.older}
    loadingOlder={store.loadingOlder}
    loadOlder={() => store.loadOlder()}
    focus={store.focus}
    {context}
    {liveLabel}
    openThread={threadParam}
    canReply={isChannel}
    {statusOf}
    onretry={() => location.reload()}
    onthread={openThread}
    oncopylink={(item) => copyLink(item)}
    {onmention}
    {onboardid}
    {onartifact}
    onbottom={markRead}
  />
  <div class="typing" aria-live="polite">
    {#if workingNames.length}
      <TypingDots mode="working" />
      <span>{workingNames.length > 2 ? "Agents" : workingNames.join(" and ")} working now</span>
    {:else if waiting && agent}
      <TypingDots mode="waiting" />
      <span>{agent.name} waits for a model slot</span>
    {/if}
  </div>
  <Composer
    bind:this={composer}
    placeholder={isChannel ? `Message #${name}` : name ? `Message ${name}` : "Message"}
    agents={directory.agents}
    channels={directory.channels}
    {working}
    draftKey={id}
    autofocus
    onsend={send}
    onstop={stop}
  />
</section>

<Menu bind:open={menuOpen} anchor={menuAnchor} items={menuItems} placement="bottom-end" />

<style>
  .conversation {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
  }
  .conversation > :global(.panel-header) {
    border-bottom: 1px solid var(--border-standard);
  }
  .title {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .purpose {
    margin-left: 10px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-subtle);
    font: var(--text-caption);
  }
  .members {
    display: inline-flex;
    margin-right: 4px;
  }
  .typing {
    display: flex;
    align-items: center;
    gap: 6px;
    width: min(calc(100% - 32px), 52rem);
    height: 20px;
    margin: 0 auto 4px;
    padding: 0 12px;
    overflow: hidden;
    color: var(--text-subtle);
    font: var(--text-caption);
    letter-spacing: var(--tracking-caption);
    white-space: nowrap;
  }
</style>
