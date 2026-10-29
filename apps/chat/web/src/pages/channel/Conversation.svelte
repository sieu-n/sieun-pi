<script lang="ts">
  import { onDestroy } from "svelte";
  import { agents, api, boardStore, conversations, isSoloRoom, jobs, me, timeline, type Item } from "$lib/api";
  import { openTarget } from "$pages/agents/agents-model";
  import BoardPanel from "$pages/board/BoardPanel.svelte";
  import { boardHref, boardTitles, rememberTitles } from "$pages/board/chips";
  import { conversationHref, router } from "$lib/router.svelte";
  import { search } from "$lib/shell/search.svelte";
  import { sidePanel } from "$lib/shell/side-panel.svelte";
  import Avatar from "$lib/ui/Avatar.svelte";
  import AvatarStack from "$lib/ui/AvatarStack.svelte";
  import Button from "$lib/ui/Button.svelte";
  import Chip from "$lib/ui/Chip.svelte";
  import Icon from "$lib/ui/Icon.svelte";
  import IconButton from "$lib/ui/IconButton.svelte";
  import Picker from "$lib/ui/Picker.svelte";
  import Tabs from "$lib/ui/Tabs.svelte";
  import { stampLabel } from "$lib/ui/datetime";
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
  import { agentPickerItems, avatarKind, mentionContext, placeText, type Outgoing } from "./present";

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
  const isDm = $derived(kind === "dm");
  /** A Solo room (`so_<id>`): its agenda is pinned on top, its members are edited here, and the owner closes it when the agenda is done. */
  const isSolo = $derived(isSoloRoom(id));
  const closedAt = $derived(header?.closedAt ?? null);
  /** A DM's agent works in its work thread, which `Open work thread` shows as today's transcript. */
  const workThread = $derived(header?.workThread ?? null);
  const name = $derived(summary?.name ?? "");
  const agent = $derived(header?.agent ?? null);
  const items = $derived(store.items);
  const waiting = $derived(store.status === "sleeping");
  const waitText = $derived(placeText(store.queue));
  const liveLabel = $derived(waiting ? "Waiting for a model slot" : null);
  const others = $derived(header?.members.filter((m) => m.principal.id !== "owner") ?? []);
  const working = $derived(store.status === "working");
  /** The agent's live card: its work thread's own status and its comm threads. */
  const liveAgent = $derived(agent ? (agents.byId(agent.id) ?? agent) : null);
  /** A split agent's comm thread for this DM answers the owner here; absent while the work thread still answers him itself. */
  const commStatus = $derived(isDm ? (liveAgent?.comm?.find((c) => c.room === id)?.status ?? conversations.byId(id)?.commStatus ?? summary?.commStatus) : undefined);
  /** The Work pill shows while the agent's work thread or one of its jobs runs. */
  const workRunning = $derived(
    isDm && !!workThread && !!liveAgent && (liveAgent.status === "working" || jobs.of(liveAgent.id).some((job) => job.status === "working")),
  );
  /** In a DM the dots show only while the agent answers the owner's turn: the thread that answers him runs, and the newest post is his. */
  const ownerTurn = $derived(items.findLast((item) => item.kind !== "system")?.author.id === "owner");
  const answering = $derived(commStatus === undefined ? working : commStatus === "working");
  const workingNames = $derived(
    isDm
      ? answering && ownerTurn && agent ? [agent.name] : []
      : summary?.working.length ? summary.working.map((w) => w.name) : working && agent ? [agent.name] : working && others.length === 1 ? [others[0]!.principal.name] : [],
  );
  const boardChat = $derived(isChannel ? (header?.homeChat ?? null) : agent?.kind === "chat" ? agent.id : null);
  /** A Solo room's side panel shows the board of one invited agent at a time, picked by a tab. */
  const soloBoards = $derived(isSolo ? (header?.boards ?? []) : []);
  let soloBoardPick = $state<string | null>(null);
  const soloBoard = $derived(soloBoardPick && soloBoards.includes(soloBoardPick) ? soloBoardPick : (soloBoards[0] ?? null));
  /** The board the side pane and the Board button open: the Solo room's picked agent, or the chat's own board. */
  const paneBoard = $derived(isSolo ? soloBoard : boardChat);
  const memberName = (agentId: string): string => others.find((m) => m.principal.id === agentId)?.principal.name ?? agents.byId(agentId)?.name ?? agentId;

  const jobsOf = (item: Item) => (item.kind === "turn" ? item.jobs : item.kind === "message" ? (item.jobs ?? []) : []);

  function statusOf(principal: string): Status | null {
    const status = (agents.byId(principal) ?? jobs.byId(principal))?.status;
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
    for (const item of store.items) for (const job of jobsOf(item)) if (job.conversation === threadParam) return job.name;
    return jobs.byId(threadParam)?.name ?? "Thread";
  });

  /** `?board=<id>` opens the chat's board in the side pane focused on that id, and `?board=1` opens it unfocused. */
  const boardParam = $derived(router.route.params.board ?? null);
  const boardFocus = $derived(boardParam && boardParam !== "1" ? boardParam : null);

  $effect(() => {
    const key = threadParam;
    const title = threadTitle;
    const board = boardParam && paneBoard ? paneBoard : null;
    if (!key && !board) {
      if (paneKey) sidePanel.close(paneKey);
      paneKey = null;
      return;
    }
    if (key) {
      paneKey = `thread:${key}`;
      sidePanel.open({ key: paneKey, title, icon: isChannel ? "thread" : "robot", body: pane, onclose: () => {
        if (!leaving) router.setParams({ thread: null });
      } });
    } else if (board) {
      paneKey = `board:${board}`;
      sidePanel.open({ key: paneKey, title: isSolo ? `Board of ${memberName(board)}` : "Board", icon: "board", body: boardPane, actions: boardActions, onclose: () => {
        if (!leaving) router.setParams({ board: null });
      } });
    }
  });

  function openBoard(focus?: string) {
    router.setParams({ board: focus ?? "1", thread: null });
  }

  const boardView = $derived(boardChat ? boardStore(boardChat) : null);
  $effect(() => {
    const current = boardView;
    return () => current?.close();
  });
  let dutyTitles = $state<{ id: string; name: string }[]>([]);
  $effect(() => {
    const chat = boardChat;
    dutyTitles = [];
    if (chat) void api.duties(chat).then((body) => (dutyTitles = body.duties.map((d) => d.duty))).catch(() => undefined);
  });
  const boardContext = $derived(boardChat && boardView?.view?.board ? { chatId: boardChat, titles: boardTitles(boardView.view.board, dutyTitles) } : null);
  $effect(() => {
    if (boardContext) rememberTitles(boardContext.chatId, boardContext.titles);
  });
  const context = $derived({ mentions: mentionContext(directory.agents, directory.channels, me.value?.owner.name ?? ""), board: boardContext, plain: true });

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
    router.setParams({ thread: key, board: null });
  }

  function onmention(target: string, mentionKind: string) {
    if (target === "owner") return;
    if (mentionKind === "channel") router.openConversation(target);
    else if (mentionKind === "agent") router.openConversation(agents.room(target));
  }

  function onartifact(target: string, e: MouseEvent) {
    const [scheme, ...restParts] = target.split(":");
    const value = restParts.join(":");
    if (scheme === "job") {
      for (const item of store.items) for (const job of jobsOf(item)) if (job.name === value || job.conversation.endsWith(`:${value}`)) return openThread(job.conversation);
      const byName = jobs.list.find((job) => job.name === value);
      const place = byName && openTarget(byName, (agent) => agents.room(agent));
      if (place) router.openConversation(place.id, place.thread ? { thread: place.thread } : {});
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
    if (!chatId || chatId === boardChat) openBoard(boardId);
    else router.navigate(boardHref(chatId, boardId));
  }

  function send(out: Outgoing): Promise<void> {
    return store.send(out.text, { images: out.images, mentions: out.mentions });
  }

  const fail = (error: unknown) => toast.error(error instanceof Error ? error.message : "That did not work");

  async function setClosed(closed: boolean) {
    try {
      await api.updateRoom(id, { closed });
      await store.refreshHeader();
      toast.show(closed ? "Room closed" : "Room reopened");
    } catch (error) {
      fail(error);
    }
  }

  let inviteOpen = $state(false);
  let inviteAnchor = $state<HTMLElement>();
  const inviteItems = $derived(agentPickerItems(agents.list).filter((item) => !others.some((m) => m.principal.id === item.id)));

  async function addMember(agentId: string) {
    try {
      await api.addMembers(id, [agentId]);
      await store.refreshHeader();
    } catch (error) {
      fail(error);
    }
  }

  async function removeMember(agentId: string) {
    try {
      await api.removeMember(id, agentId);
      await store.refreshHeader();
    } catch (error) {
      fail(error);
    }
  }

  let agendaOpen = $state(false);

  function stop() {
    void store.stop().then(
      () => toast.show("Stopping"),
      (error: unknown) => toast.error(error instanceof Error ? error.message : "Could not stop"),
    );
  }

  const menuItems = $derived<MenuEntry[]>([
    { id: "search", label: "Search in this conversation", icon: "search", shortcut: "⌘F", onselect: () => search.open({ kind: "conversation", id }) },
    { id: "link", label: "Copy link", icon: "link", onselect: () => void navigator.clipboard.writeText(`${location.origin}${location.pathname}${conversationHref(id)}`).then(() => toast.show("Link copied")) },
    ...(paneBoard
      ? [
          { id: "board", label: isSolo ? "Show boards" : "Show board", icon: "board", onselect: () => openBoard() },
          { id: "board-page", label: "Open board page", icon: "external", onselect: () => router.navigate(boardHref(paneBoard)) },
        ]
      : []),
    ...(isSolo && header
      ? [closedAt
          ? { id: "reopen", label: "Reopen room", icon: "refresh", onselect: () => void setClosed(false) }
          : { id: "close", label: "Close room", icon: "check", onselect: () => void setClosed(true) }]
      : []),
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

{#snippet boardPane()}
  {#if paneBoard}
    {#if soloBoards.length > 1}
      <div class="board-tabs">
        <Tabs items={soloBoards.map((agentId) => ({ id: agentId, label: memberName(agentId) }))} value={paneBoard} variant="underline" size="sm" label="Boards" onchange={(agentId) => (soloBoardPick = agentId)} />
      </div>
    {/if}
    {#key `${paneBoard}|${boardFocus ?? ""}`}
      <div class="board-pane" data-testid="board-pane" data-board-chat={paneBoard}><BoardPanel chatId={paneBoard} where="panel" focus={boardFocus} onboardid={(boardId) => openBoard(boardId)} /></div>
    {/key}
  {/if}
{/snippet}

{#snippet boardActions()}
  {#if paneBoard}<IconButton icon="external" label="Open board page" size="sm" onclick={() => router.navigate(boardHref(paneBoard, boardFocus ?? undefined))} />{/if}
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
  {#if workThread}
    <Button variant="ghost" size="sm" icon="robot" href={conversationHref(workThread)}>Open work thread</Button>
  {/if}
  {#if working}
    <IconButton icon="stop" label="Stop" size="sm" onclick={stop} data-testid="header-stop" />
  {/if}
  {#if isSolo && header && !closedAt}
    <Button variant="ghost" size="sm" icon="check" onclick={() => void setClosed(true)} data-testid="solo-close">Close</Button>
  {/if}
  {#if paneBoard}
    <IconButton icon="board" label={isSolo ? "Boards" : "Board"} size="sm" pressed={!!boardParam} onclick={() => (boardParam ? router.setParams({ board: null }) : openBoard())} data-testid="board-button" />
  {/if}
  <IconButton icon="more" label={isChannel ? "Channel actions" : isSolo ? "Room actions" : isDm ? "Conversation actions" : "Chat actions"} size="sm" bind:element={menuAnchor} onclick={() => (menuOpen = !menuOpen)} />
{/snippet}

<section class="conversation" data-conversation={id} data-kind={kind}>
  <PanelHeader icon={isChannel ? "hash" : isSolo ? "users" : kind === "solo" ? "chat" : "robot"} {titleContent} {actions} />
  {#if isSolo && header}
    <div class="solo-bar" data-testid="solo-agenda">
      <div class="agenda">
        <Icon name="pin" size={14} />
        <p class="agenda-text" class:open={agendaOpen} data-testid="solo-agenda-text">{header.agenda ?? ""}</p>
        {#if (header.agenda ?? "").length > 140 || (header.agenda ?? "").includes("\n")}
          <button type="button" class="agenda-more t-caption" aria-expanded={agendaOpen} onclick={() => (agendaOpen = !agendaOpen)}>{agendaOpen ? "Less" : "More"}</button>
        {/if}
      </div>
      <div class="roster" data-testid="solo-members" aria-label="Members">
        {#each others as member (member.principal.id)}
          <Chip size="sm" label={member.principal.name} removeLabel="Remove {member.principal.name}" onremove={() => void removeMember(member.principal.id)}>
            {#snippet leading()}<Avatar name={member.principal.name} kind="agent" seed={member.principal.id} size={16} status={statusOf(member.principal.id)} />{/snippet}
          </Chip>
        {/each}
        <Button variant="ghost" size="sm" icon="plus" bind:element={inviteAnchor} onclick={() => (inviteOpen = true)}>Add agents</Button>
      </div>
    </div>
  {/if}
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
    queue={store.queue}
    openThread={threadParam}
    canReply={isChannel}
    {statusOf}
    onretry={() => location.reload()}
    onretrysend={(item) => store.retrySend(item.id)}
    ondiscardsend={(item) => store.discardSend(item.id)}
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
      <span>{commStatus === undefined ? `${workingNames.length > 2 ? "Agents" : workingNames.join(" and ")} working now` : `${workingNames[0]} is answering`}</span>
    {:else if waitText && agent}
      <TypingDots mode="waiting" />
      <span>{agent.name} {waitText}</span>
    {:else if waiting && agent}
      <TypingDots mode="waiting" />
      <span>{agent.name} waits for a model slot</span>
    {/if}
    {#if workRunning && workThread}
      <a class="work-pill" href={conversationHref(workThread)} title="Open the work thread" data-testid="work-pill"><TypingDots mode="working" size={3} />Work</a>
    {/if}
  </div>
  {#if closedAt}
    <div class="closed" role="status" data-testid="closed-banner">
      <Icon name="lock" size={16} />
      <span title="Closed {stampLabel(closedAt)}">You closed this room. Agents get no posts until you reopen it.</span>
      <Button variant="outline" size="sm" onclick={() => void setClosed(false)} data-testid="solo-reopen">Reopen</Button>
    </div>
  {:else}
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
  {/if}
</section>

<Menu bind:open={menuOpen} anchor={menuAnchor} items={menuItems} placement="bottom-end" />
{#if isSolo}
  <Picker bind:open={inviteOpen} anchor={inviteAnchor} items={inviteItems} searchable label="Add agents" emptyText="Every agent is in this room" onselect={(agentId) => void addMember(agentId)} />
{/if}

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
  .solo-bar {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--border-standard);
    background: var(--surface-inset);
  }
  .agenda {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    color: var(--text-standard);
  }
  .agenda :global(.icon) {
    flex: none;
    margin-top: 3px;
    color: var(--text-subtle);
  }
  .agenda-text {
    flex: 1;
    min-width: 0;
    margin: 0;
    font: var(--text-body-sm);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
  }
  .agenda-text.open {
    display: block;
  }
  .agenda-more {
    flex: none;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--text-subtle);
    cursor: pointer;
  }
  .agenda-more:hover {
    color: var(--text-standard);
  }
  .roster {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .closed {
    display: flex;
    align-items: center;
    gap: 10px;
    width: min(calc(100% - 32px), 52rem);
    margin: 0 auto 16px;
    padding: 12px 16px;
    border: 1px solid var(--border-standard);
    border-radius: var(--radius-container);
    color: var(--text-subtle);
    font: var(--text-body-sm);
  }
  .closed span {
    flex: 1;
  }
  .board-tabs {
    padding: 0 12px;
    border-bottom: 1px solid var(--border-standard);
  }
  .board-pane {
    height: 100%;
    overflow-y: auto;
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
  .work-pill {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 6px;
    height: 20px;
    margin-left: auto;
    padding: 0 8px;
    border: 1px solid var(--border-standard);
    border-radius: var(--radius-pill);
    color: var(--text-subtle);
    text-decoration: none;
    transition: background var(--duration-fast) var(--ease-standard);
  }
  .work-pill:hover {
    background: var(--affordance-ghost-hover);
    color: var(--text-standard);
  }
</style>
