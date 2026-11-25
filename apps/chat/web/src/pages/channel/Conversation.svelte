<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import { agents, api, boardStore, conversations, expectCall, isSoloRoom, jobs, me, prefetchThread, reads, timeline, view, type Item } from "$lib/api";
  import BoardPanel from "$pages/board/BoardPanel.svelte";
  import { boardHref, boardTitles, rememberTitles } from "$pages/board/chips";
  import { conversationHref, hrefFor, router } from "$lib/router.svelte";
  import { profileCard } from "$lib/shell/profile-card.svelte";
  import { roomActions, roomRow } from "$lib/shell/room-actions.svelte";
  import { renameDialog } from "$lib/shell/rename-dialog.svelte";
  import { channelDetails } from "$lib/shell/channel-details.svelte";
  import { archiveChannel as archiveRoom, setSoloClosed, unarchiveChannel as unarchiveRoom } from "$lib/shell/room-actions.svelte";
  import { search } from "$lib/shell/search.svelte";
  import { sidePanel } from "$lib/shell/side-panel.svelte";
  import { openArtifactTarget, openView } from "$lib/shell/viewer.svelte";
  import Avatar from "$lib/ui/Avatar.svelte";
  import AvatarStack from "$lib/ui/AvatarStack.svelte";
  import Button from "$lib/ui/Button.svelte";
  import Chip from "$lib/ui/Chip.svelte";
  import Icon from "$lib/ui/Icon.svelte";
  import IconButton from "$lib/ui/IconButton.svelte";
  import Tabs from "$lib/ui/Tabs.svelte";
  import TextArea from "$lib/ui/TextArea.svelte";
  import { stampLabel } from "$lib/ui/datetime";
  import Menu from "$lib/ui/Menu.svelte";
  import PanelHeader from "$lib/ui/PanelHeader.svelte";
  import TypingDots from "$lib/ui/TypingDots.svelte";
  import { composing, modKey } from "$lib/ui/keyboard";
  import type { MenuEntry } from "$lib/ui/menu";
  import { toast } from "$lib/ui/toast.svelte";
  import type { Status } from "$lib/ui/types";
  import AccountChip from "$pages/accounts/AccountChip.svelte";
  import HostBadge from "$pages/agents/HostBadge.svelte";
  import Composer from "./Composer.svelte";
  import ChannelMembers from "./ChannelMembers.svelte";
  import ChannelDetailsDialog from "./ChannelDetailsDialog.svelte";
  import MemberPicker from "./MemberPicker.svelte";
  import { addMemberships, removeMembership } from "./membership";
  import ThreadPane from "./ThreadPane.svelte";
  import PinnedButton from "./PinnedButton.svelte";
  import { roomDraftKey, threadDraftKey } from "$lib/drafts.svelte";
  import Timeline from "./Timeline.svelte";
  import { directory } from "./directory.svelte";
  import type { SlashCommand } from "./typeahead";
  import { parseRemind } from "./remind-command";
  import { later as laterStore } from "$lib/later.svelte";
  import { AuthorBoards } from "./author-boards.svelte";
  import { avatarOf, mentionContext, placeText, type Outgoing } from "./present";
  import { unarchiveAgent } from "$pages/agents/agent-actions.svelte";

  type Props = { id: string; around?: string };
  let { id, around }: Props = $props();

  // svelte-ignore state_referenced_locally
  const store = timeline(id, around ? { around, ...(router.route.params.thread ? { root: router.route.params.thread } : {}) } : {});
  let leaving = false;
  onDestroy(() => {
    leaving = true;
    readExpected?.();
    readExpected = undefined;
    store.close();
    if (paneKey) sidePanel.close(paneKey);
    if (channelDetails.target?.id === id) channelDetails.close();
  });

  const header = $derived(store.header);
  const summary = $derived(header?.summary ?? null);
  /** The sidebar's row names the kind and a DM's agent before the header is in, so the header's menu does not change when it lands. */
  const listed = $derived(conversations.byId(id));
  const kind = $derived(summary?.kind ?? listed?.kind ?? (id.startsWith("ch_") ? "channel" : id.startsWith("dm_") ? "dm" : "solo"));
  const isChannel = $derived(kind === "channel");
  const isDm = $derived(kind === "dm");
  /** A Solo room (`so_<id>`): its agenda is pinned on top, its members are edited here, and the owner closes it when the agenda is done. */
  const isSolo = $derived(isSoloRoom(id));
  /** Channels and Solo rooms read like Slack; DMs and other chats keep the bubbles. */
  const layout = $derived<"bubble" | "slack">(isChannel || isSolo ? "slack" : "bubble");
  const closedAt = $derived(header?.closedAt ?? null);
  /** An archived channel opens read-only, with Unarchive in its banner, as in Slack. */
  const archived = $derived(isChannel && summary?.archived === true);
  /** An archived agent's DM opens read-only too: the server refuses a post to it until Unarchive brings the agent back. */
  const agentArchived = $derived(isDm && summary?.archived === true);
  /** A DM's agent works in its work thread, which `Open work thread` shows as today's transcript. */
  const workThread = $derived(header?.workThread ?? null);
  const name = $derived(summary?.name ?? "");
  /** A channel's icon from its sidebar row first, so a pick in the sidebar shows here at once, a walk's open test room too. */
  const iconRow = $derived(roomRow(id) ?? listed);
  const emoji = $derived(iconRow ? iconRow.emoji : summary?.emoji);
  const agent = $derived(header?.agent ?? null);
  const dmAgent = $derived(agent?.id ?? listed?.agent ?? (id.startsWith("dm_") ? `ag_${id.slice(3)}` : undefined));
  const items = $derived(store.items);
  const waiting = $derived(store.status === "sleeping");
  const waitText = $derived(placeText(store.queue));
  const liveLabel = $derived(waiting ? "Waiting for a model slot" : null);
  const others = $derived(header?.members.filter((m) => m.principal.id !== "owner") ?? []);
  /** A turn in flight: running, or waiting for a working slot or an account (pi-host's sleep, pi-pool's queue place). Stop ends either. */
  const working = $derived(store.status === "working" || waiting || !!store.queue);
  /** The agent's live card: its work thread's own status and its comm threads. */
  const liveAgent = $derived(agent ? (agents.byId(agent.id) ?? agent) : null);
  /** pi-host's "retrying since HH:MM: <kind>" of the agent's comm thread for this room, else of its own turn, which the working line shows. */
  const retrying = $derived(liveAgent?.comm?.find((c) => c.room === id)?.retrying ?? (isDm ? liveAgent?.retrying : undefined) ?? null);
  /** The Work pill shows while the agent's work thread or one of its jobs runs. */
  const workRunning = $derived(
    isDm && !!workThread && !!liveAgent && (liveAgent.status === "working" || jobs.of(liveAgent.id).some((job) => job.status === "working")),
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
  /** A thread key that names a root post (`p<seq>`) in a channel, a DM or a Solo room; in a DM or a Solo room any other key is a job's conversation. */
  const isPostThread = (key: string): boolean => isChannel || ((isDm || isSolo) && /^p\d+$/.test(key));
  const postThread = $derived(!!threadParam && isPostThread(threadParam));
  /** `?thread=<root>&m=<reply>` names a reply: the thread pane flashes it, and the room only scrolls to its root, as in Slack. */
  const replyFocus = $derived(postThread && threadParam && around && around !== threadParam ? around : undefined);
  let paneKey: string | null = null;
  const threadTitle = $derived.by(() => {
    if (!threadParam) return "";
    if (postThread) return "Thread";
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
      sidePanel.open({ key: paneKey, title, icon: postThread ? "thread" : "robot", body: pane, header: layout === "slack" || postThread ? threadHeader : undefined, onclose: () => {
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
  const dutyRows = view(() => (boardChat ? reads.duties(boardChat) : null));
  const dutyTitles = $derived(dutyRows.value?.duties.map((d) => d.duty) ?? []);
  const boardContext = $derived(boardChat && boardView?.view?.board ? { chatId: boardChat, titles: boardTitles(boardView.view.board, dutyTitles) } : null);
  $effect(() => {
    if (boardContext) rememberTitles(boardContext.chatId, boardContext.titles);
  });
  /** The room's agents, each with its own board and jobs, so the board ids and job names in its posts link to its own (MessageRow's withAuthor). */
  const memberAgents = $derived(others.filter((m) => m.principal.kind === "chat").map((m) => m.principal.id));
  const authorBoards = new AuthorBoards();
  /** The agent whose board is the room's own (a DM's agent, a channel's home chat), whose posts keep the room's board context. */
  const isHome = (agentId: string): boolean => agentId === boardChat || (!!boardChat && agents.byId(agentId)?.thread === boardChat);
  $effect(() => authorBoards.sync(memberAgents.filter((agentId) => !isHome(agentId))));
  $effect(() => () => authorBoards.close());
  const jobNames = (agentId: string): string[] => jobs.of(agentId).map((job) => job.name);
  const authors = $derived(new Map(memberAgents.map((agentId) => [agentId, { board: isHome(agentId) ? boardContext : authorBoards.board(agentId), jobs: jobNames(agentId) }])));
  const context = $derived({
    mentions: mentionContext(directory.agents, directory.channels, me.value?.owner.name ?? ""),
    board: boardContext,
    jobs: memberAgents.flatMap(jobNames),
    authors,
    plain: true,
  });

  let composer = $state<Composer>();
  let menuOpen = $state(false);
  let menuAnchor = $state<HTMLButtonElement>();
  let readTimer: ReturnType<typeof setTimeout> | undefined;
  let readByUser = false;
  /** The read mark about to go holds the page's reads ahead until it went (client.ts `expectCall`). */
  let readExpected: (() => void) | undefined;

  /** `byUser` when the owner himself scrolled to the bottom, which reads past a post he marked unread. */
  function markRead(byUser: boolean) {
    clearTimeout(readTimer);
    readByUser ||= byUser;
    readExpected ??= expectCall();
    readTimer = setTimeout(() => {
      const user = readByUser;
      readByUser = false;
      const went = readExpected;
      readExpected = undefined;
      if (document.visibilityState === "visible") void store.markRead(user).catch(() => undefined).finally(went);
      else went?.();
    }, 400);
  }

  function linkFor(item: Item, conversation = id): string {
    const thread = item.kind === "message" && item.threadRoot && conversation === id ? item.threadRoot : null;
    return `${location.origin}${location.pathname}${conversationHref(conversation, { thread, messageId: item.id })}`;
  }
  function copyLink(item: Item, conversation = id) {
    void navigator.clipboard.writeText(linkFor(item, conversation)).then(
      () => toast.show("Link copied"),
      () => toast.error("Could not copy the link"),
    );
  }

  function openThread(key: string) {
    if (key !== threadParam) prefetchThread(isPostThread(key) ? id : null, key, store.items.find((item) => item.id === key));
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
      if (byName) openView({ kind: "thread", id: byName.id });
      else toast.show(`No job named ${value} in this chat`);
    } else if (scheme === "file") {
      e.preventDefault();
      void navigator.clipboard.writeText(value).then(() => toast.show("Path copied"));
    } else {
      openArtifactTarget(target);
    }
  }

  function onboardid(boardId: string, chatId: string) {
    if (!chatId || chatId === boardChat) openBoard(boardId);
    else openView({ kind: "board", chatId, focus: boardId });
  }

  function send(out: Outgoing): Promise<void> {
    return store.send(out.text, { images: out.images, mentions: out.mentions });
  }

  const fail = (error: unknown) => toast.error(error instanceof Error ? error.message : "That did not work");

  async function setClosed(closed: boolean) {
    if (await setSoloClosed(id, name, closed)) await store.refreshHeader();
  }

  /** The agenda bar's in-place edit, as Slack edits a topic: Enter saves, Shift+Enter adds a line, and Esc or a click away drops it. */
  let agendaDraft = $state<string | null>(null);
  let agendaSaving = $state(false);
  let agendaField = $state<HTMLTextAreaElement>();

  async function editAgenda() {
    agendaDraft = header?.agenda ?? "";
    await tick();
    agendaField?.focus();
    agendaField?.setSelectionRange(agendaDraft.length, agendaDraft.length);
  }

  async function saveAgenda() {
    if (agendaDraft === null || agendaSaving) return;
    const text = agendaDraft.trim();
    if (!text || text === (header?.agenda ?? "").trim()) {
      agendaDraft = null;
      return;
    }
    agendaSaving = true;
    try {
      await api.updateRoom(id, { agenda: text });
      await store.refreshHeader();
      agendaDraft = null;
      toast.show("Agenda updated");
    } catch (error) {
      fail(error);
    } finally {
      agendaSaving = false;
    }
  }

  function agendaKey(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey && !composing(e)) {
      e.preventDefault();
      void saveAgenda();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      agendaDraft = null;
    }
  }

  let channelMembers = $state<ChannelMembers>();
  let inviteOpen = $state(false);
  let inviteAnchor = $state<HTMLElement>();
  /**
   * A test room sends no live room event, so a member change reads the header again itself. Its system line comes on the socket, which
   * the room's watchers get from group-rooms.ts `memberChanged`; a read of the newest items beside it counted as his wait for the room, 3
   * of his 17 on 11-23 (work/p278-thread-open/census.md).
   */
  const refreshHeader = () => store.refreshHeader();

  let agendaOpen = $state(false);

  /** Saves the description from channel details; resolves false after the error's toast, so the field stays open. */
  async function savePurpose(text: string): Promise<boolean> {
    try {
      await api.updateRoom(id, { agenda: text });
      await store.refreshHeader();
      toast.success(text ? "Channel description updated" : "Channel description removed");
      return true;
    } catch (error) {
      fail(error);
      return false;
    }
  }

  /** Brings an archived channel back; the header is read again because a test room sends no live room event. */
  const unarchive = () => void unarchiveRoom(id, name).then(() => store.refreshHeader());

  const details = $derived(isChannel && header && channelDetails.target?.id === id ? channelDetails.target : null);
  /** A rename started from channel details reads the header again when its dialog closes, since a test room sends no live room event. */
  let renamingFromDetails = false;
  $effect(() => {
    if (renameDialog.target || !renamingFromDetails) return;
    renamingFromDetails = false;
    void store.refreshHeader();
  });

  function stop() {
    void store.stop().then(
      () => toast.show("Stopping"),
      (error: unknown) => toast.error(error instanceof Error ? error.message : "Could not stop"),
    );
  }

  const menuItems = $derived<MenuEntry[]>([
    ...(isDm && dmAgent
      ? [
          { id: "agent", label: "Open agent", icon: "robot", onselect: () => router.navigate(hrefFor("agents", [dmAgent])) },
          { id: "threads", label: "Threads and jobs", icon: "terminal", onselect: () => router.navigate(hrefFor("agents", [dmAgent], { section: "threads" })) },
          { type: "separator" as const },
        ]
      : []),
    // Channel details opens before the header is in, as the title does, so no row lands above Search under the pointer once it loads.
    ...(isChannel ? [{ id: "details", label: "Channel details", icon: "info", onselect: () => channelDetails.open(id) }] : []),
    { id: "search", label: "Search in this conversation", icon: "search", onselect: () => search.open({ kind: "conversation", id }) },
    { id: "link", label: "Copy link", icon: "link", onselect: () => void navigator.clipboard.writeText(`${location.origin}${location.pathname}${conversationHref(id)}`).then(() => toast.show("Link copied")) },
    ...(paneBoard
      ? [
          { id: "board", label: isSolo ? "Show boards" : "Show board", icon: "board", onselect: () => openBoard() },
          { id: "board-page", label: "Open board page", icon: "external", onselect: () => router.navigate(boardHref(paneBoard)) },
        ]
      : []),
    ...(isChannel && header
      ? archived
        ? [{ id: "unarchive", label: "Unarchive channel", icon: "refresh", onselect: unarchive }]
        : [
            { id: "add-people", label: "Add people", icon: "plus", onselect: () => channelMembers?.openAdd() },
            { id: "rename", label: "Rename channel", icon: "edit", onselect: () => renameDialog.open(id, name) },
            ...(roomActions(id).length ? [{ type: "separator" as const }, ...roomActions(id)] : []),
          ]
      : []),
    ...(isSolo && header
      ? [
          { type: "separator" as const },
          { id: "rename", label: "Rename room", icon: "edit", disabled: !!closedAt, onselect: () => renameDialog.open(id, name, "solo") },
          { id: "agenda", label: "Edit agenda", icon: "pin", disabled: !!closedAt, onselect: () => void editAgenda() },
          closedAt
            ? { id: "reopen", label: "Reopen room", icon: "refresh", onselect: () => void setClosed(false) }
            : { id: "close", label: "Close room", icon: "check", onselect: () => void setClosed(true) },
        ]
      : []),
    ...(isDm && roomActions(id).length ? [{ type: "separator" as const }, ...roomActions(id)] : []),
    ...(working ? [{ type: "separator" as const }, { id: "stop", label: "Stop", icon: "stop", onselect: stop }] : []),
  ]);

  /** The New messages bar's Mark as read, and Esc in the room, as in Slack: the room reads to its newest post and its New line goes. */
  function readNow() {
    void store.readNow().catch(() => toast.error(`Could not mark ${isChannel ? `#${name}` : name} as read`));
  }

  /** What `/` lists in this room's composer. Each throws on a missing argument, which keeps the draft and shows the message. */
  async function setTopic(text: string) {
    if (!text) throw new Error(`Type the new ${isSolo ? "agenda" : "description"} after /topic`);
    await api.updateRoom(id, { agenda: text });
    await store.refreshHeader();
    toast.success(isSolo ? "Agenda updated" : "Channel description updated");
  }
  async function renameRoom(text: string) {
    if (!text) throw new Error("Type the new name after /rename");
    const room = await api.updateRoom(id, { name: text.replace(/^#/, "") });
    await store.refreshHeader();
    toast.success(`Renamed to #${room.name}`);
  }
  const commands = $derived<SlashCommand[]>([
    ...(isChannel || isSolo
      ? [{ name: "topic", args: "[text]", description: isSolo ? "Set this room's agenda" : "Set the channel description", run: ({ args }: { args: string }) => setTopic(args) }]
      : []),
    ...(isChannel ? [{ name: "rename", args: "[name]", description: "Rename this channel", run: ({ args }: { args: string }) => renameRoom(args) }] : []),
    ...(isSolo && header
      ? [closedAt
          ? { name: "reopen", description: "Reopen this room", run: () => setClosed(false) }
          : { name: "close", description: "Close this room, as its agenda is done", run: () => setClosed(true) }]
      : []),
    ...((isChannel && !archived) || (isSolo && !closedAt)
      ? [
          { name: "invite", args: "[@agent]", description: "Add agents to this room", run: ({ mentions }: { mentions: string[] }) => inviteAgents(mentions) },
          { name: "remove", args: "[@agent]", description: "Remove an agent from this room", run: ({ args, mentions }: { args: string; mentions: string[] }) => removeAgents(args, mentions) },
        ]
      : []),
    ...(isChannel && header && !archived ? [{ name: "archive", description: "Archive this channel", run: () => archiveRoom(id, name) }] : []),
    { name: "remind", args: "me [what] [when]", description: "Set a reminder, such as /remind me call the bank in 20 min", run: ({ args }) => remindMe(args) },
    { name: "search", args: "[words]", description: "Search in this conversation", run: ({ args }) => search.open({ kind: "conversation", id }, args) },
    ...(working ? [{ name: "stop", description: "Stop the answer the agent is writing", run: stop }] : []),
  ]);

  /** Slack's /remind me <what> <when>: a Later reminder of his own text; a line it cannot read keeps the draft and says how to write it. */
  async function remindMe(args: string) {
    const parsed = parseRemind(args);
    if (!parsed.ok) throw new Error(parsed.error);
    await laterStore.remindMe(parsed.text, parsed.at);
  }

  /** Slack's /invite @agent: with no agent named it opens the room's add picker. */
  async function inviteAgents(mentions: string[]) {
    if (!mentions.length) {
      if (isChannel) channelMembers?.openAdd();
      else inviteOpen = true;
      return;
    }
    const fresh = mentions.filter((m) => !others.some((o) => o.principal.id === m));
    await addMemberships(fresh.map((agentId) => ({ room: id, roomName: name, agent: agentId, agentName: memberName(agentId) })), { refresh: refreshHeader });
  }

  /** A member named by its chip, or by its name typed after /remove when the @ list was skipped. */
  async function removeAgents(args: string, mentions: string[]) {
    const typed = args.replace(/^@/, "").trim().toLowerCase();
    const members = others.filter((m) => mentions.includes(m.principal.id) || (!mentions.length && typed && m.principal.name.toLowerCase() === typed));
    if (!members.length) throw new Error(mentions.length || typed ? "That agent is not in this room" : "Name the agent after /remove, such as /remove @Vent");
    for (const m of members)
      await removeMembership({ room: id, roomName: name, agent: m.principal.id, agentName: m.principal.name }, { wakeOn: m.wakeOn, refresh: refreshHeader });
  }

  function onkeydown(e: KeyboardEvent) {
    if (modKey(e) && !e.shiftKey && e.key.toLowerCase() === "l") {
      e.preventDefault();
      composer?.focus();
    } else if (e.key === "Escape" && !e.shiftKey && !modKey(e) && !e.altKey && !e.defaultPrevented && store.newLine && !threadParam && !document.querySelector("dialog[open], [role=menu], [role=listbox]")) {
      e.preventDefault();
      readNow();
    }
  }
</script>

<svelte:window {onkeydown} />

{#snippet pane()}
  {#if threadParam}
    {#key threadParam}
      <ThreadPane
        channel={postThread ? id : null}
        channelName={isChannel ? name : null}
        threadKey={threadParam}
        draftKey={threadDraftKey(id, threadParam)}
        focus={replyFocus}
        {layout}
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

{#snippet threadHeader()}
  <PanelHeader icon={postThread ? "thread" : "robot"} closeLabel="Close {threadTitle.toLowerCase()}" onclose={() => sidePanel.close()}>
    {#snippet titleContent()}
      <h2 class="t-label-sm">{threadTitle}</h2>
      <span class="thread-room" data-testid="thread-room">{isChannel ? `#${name}` : name}</span>
    {/snippet}
  </PanelHeader>
{/snippet}

{#snippet channelIntroActions()}
  {#if !header?.purpose}<Button variant="outline" size="sm" icon="edit" onclick={() => channelDetails.open(id, { editDescription: true })}>Add description</Button>{/if}
  <Button variant="outline" size="sm" icon="plus" onclick={() => channelMembers?.openAdd()}>Add people</Button>
{/snippet}

{#snippet titleContent()}
  {#if isChannel && header}
    <h1 class="title t-label-sm" data-testid="conversation-title">
      <button type="button" class="title-button" aria-haspopup="dialog" title="Channel details" onclick={() => channelDetails.open(id)} data-testid="channel-title-button">
        {#if emoji}<span class="title-emoji" aria-hidden="true">{emoji}</span>{/if}<span class="title-name">{name}</span><Icon name="chevron-down" size={12} />
      </button>
    </h1>
  {:else if isDm && agent}
    <h1 class="title t-label-sm" data-testid="conversation-title">
      <button type="button" class="title-button" aria-haspopup="dialog" onclick={(e) => profileCard.toggle(agent.id, name, e.currentTarget)} onpointerenter={() => profileCard.warm(agent.id)} data-testid="dm-title-button">
        <Avatar {name} kind="agent" seed={agent.id} size={20} status={statusOf(agent.id)} decorative /><span class="title-name">{name}</span><Icon name="chevron-down" size={12} />
      </button>
    </h1>
  {:else}
  <h1 class="title t-label-sm" data-testid="conversation-title">{name}</h1>
  {/if}
  {#if isDm && liveAgent}<span class="host"><HostBadge agent={liveAgent} self={me.value?.host} /></span>{/if}
  {#if isChannel && header && !archived}
    <button type="button" class="purpose" title={header.purpose || undefined} onclick={() => channelDetails.open(id, { editDescription: true })} data-testid="channel-purpose">{header.purpose || "Add a description"}</button>
  {:else if header?.purpose}<span class="purpose" title={header.purpose} data-testid="channel-purpose">{header.purpose}</span>{/if}
{/snippet}

{#snippet actions()}
  {#if header && (isDm || kind === "job" || (kind === "solo" && !isSolo))}
    <AccountChip thread={id} model={header.model} />
  {:else if header && (isChannel || isSolo)}
    {#each memberAgents as agentId (agentId)}
      <AccountChip thread={agentId} model={agents.byId(agentId)?.model ?? null} agent={{ id: agentId, name: memberName(agentId) }} />
    {/each}
  {/if}
  {#if isChannel && header}
    <ChannelMembers
      bind:this={channelMembers}
      room={id}
      members={header.members}
      channel={name}
      test={header.test === true}
      {statusOf}
      onopen={(agentId) => router.openConversation(agents.room(agentId))}
      refresh={refreshHeader}
    />
  {:else if others.length}
    <span class="members" title={others.map((m) => m.principal.name).join(", ")}>
      <AvatarStack members={others.map((m) => avatarOf(m.principal))} size={20} max={3} />
    </span>
  {/if}
  {#if workThread}
    <span class="work-thread" data-work-thread title="Open main thread"><Button variant="ghost" size="sm" icon="robot" href={conversationHref(workThread)}>Open main thread</Button></span>
  {/if}
  {#if header?.pins}
    <PinnedButton room={id} pins={header.pins} {items} refresh={() => void store.refreshHeader()} />
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

<section class="conversation" class:slack={layout === "slack"} data-conversation={id} data-kind={kind}>
  <PanelHeader icon={isChannel ? (emoji ? undefined : "hash") : isSolo ? "users" : kind === "solo" ? "chat" : isDm && agent ? undefined : "robot"} {titleContent} {actions} />
  {#if isSolo && header}
    <div class="solo-bar" data-testid="solo-agenda">
      <div class="agenda">
        <Icon name="pin" size={14} />
        {#if agendaDraft !== null}
          <div class="agenda-edit">
            <TextArea
              bind:element={agendaField}
              bind:value={agendaDraft}
              rows={1}
              maxRows={8}
              aria-label="Agenda"
              placeholder="What should this room get done?"
              disabled={agendaSaving}
              onkeydown={agendaKey}
              onblur={() => {
                if (!agendaSaving) agendaDraft = null;
              }}
              data-testid="solo-agenda-field"
            />
            <span class="agenda-hint t-caption">Enter to save, Shift+Enter for a new line, Esc to cancel</span>
          </div>
        {:else}
          <p class="agenda-text" class:open={agendaOpen} data-testid="solo-agenda-text">{header.agenda ?? ""}</p>
          {#if (header.agenda ?? "").length > 140 || (header.agenda ?? "").includes("\n")}
            <button type="button" class="agenda-more t-caption" aria-expanded={agendaOpen} onclick={() => (agendaOpen = !agendaOpen)}>{agendaOpen ? "Less" : "More"}</button>
          {/if}
          {#if !closedAt}<span class="agenda-pen"><IconButton icon="edit" label="Edit agenda" size="xs" onclick={() => void editAgenda()} /></span>{/if}
        {/if}
      </div>
      <div class="roster" data-testid="solo-members" aria-label="Members">
        {#each others as member (member.principal.id)}
          <Chip
            size="sm"
            label={member.principal.name}
            removeLabel="Remove {member.principal.name}"
            onremove={() => void removeMembership({ room: id, roomName: name, agent: member.principal.id, agentName: member.principal.name }, { wakeOn: member.wakeOn, refresh: refreshHeader })}
          >
            {#snippet leading()}<Avatar name={member.principal.name} kind="agent" seed={member.principal.id} size={16} status={statusOf(member.principal.id)} />{/snippet}
          </Chip>
        {/each}
        <Button variant="ghost" size="sm" icon="plus" bind:element={inviteAnchor} onclick={() => (inviteOpen = true)}>Add agents</Button>
      </div>
    </div>
  {/if}
  <Timeline
    {items}
    {layout}
    beginning={layout === "slack" && header ? { name, purpose: header.purpose ?? null, kind: isSolo ? "solo" : "channel" } : isDm && agent ? { kind: "dm", name, agent: agent.id } : null}
    introActions={isChannel && header && !archived ? channelIntroActions : undefined}
    loading={store.loading}
    error={store.error}
    hasOlder={!!store.older}
    loadingOlder={store.loadingOlder}
    loadOlder={(wait) => store.loadOlder(wait)}
    focus={store.focus}
    flashFocus={!replyFocus}
    {context}
    {liveLabel}
    queue={store.queue}
    openThread={threadParam}
    canReply={isChannel || isDm || isSolo}
    {statusOf}
    onretry={() => location.reload()}
    onretrysend={(item) => store.retrySend(item.id)}
    ondiscardsend={(item) => store.discardSend(item.id)}
    onthread={openThread}
    oncopylink={(item) => copyLink(item)}
    {onmention}
    {onboardid}
    {onartifact}
    newLine={store.newLine}
    onbottom={markRead}
    onmarkread={readNow}
  />
  <div class="typing" aria-live="polite">
    {#if retrying && agent}
      <TypingDots mode="waiting" />
      <span data-testid="retrying-line">{agent.name}: {retrying}</span>
    {:else if waitText && agent}
      <TypingDots mode="waiting" />
      <span>{agent.name} {waitText}</span>
    {:else if waiting && agent}
      <TypingDots mode="waiting" />
      <span>{agent.name} waits for a model slot</span>
    {/if}
    {#if workRunning && workThread}
      <a class="work-pill" href={conversationHref(workThread)} title="Open the main thread" data-testid="work-pill"><TypingDots mode="working" size={3} />Main thread</a>
    {/if}
  </div>
  {#if closedAt}
    <div class="closed" role="status" data-testid="closed-banner">
      <Icon name="lock" size={16} />
      <span title="Closed {stampLabel(closedAt)}">You closed this room. Agents get no posts until you reopen it.</span>
      <Button variant="outline" size="sm" onclick={() => void setClosed(false)} data-testid="solo-reopen">Reopen</Button>
    </div>
  {:else if archived}
    <div class="closed" role="status" data-testid="archived-banner">
      <Icon name="archive" size={16} />
      <span>You are viewing <strong>#{name}</strong>, an archived channel. Agents get no posts here until you unarchive it.</span>
      <Button variant="outline" size="sm" onclick={unarchive} data-testid="unarchive">Unarchive</Button>
    </div>
  {:else if agentArchived && agent}
    <div class="closed" role="status" data-testid="archived-agent-banner">
      <Icon name="archive" size={16} />
      <span><strong>{name}</strong> is archived and gets no messages, posts or mentions until you unarchive it.</span>
      <Button variant="outline" size="sm" onclick={() => void unarchiveAgent({ id: agent.id, name }).then(() => store.refreshHeader())}>Unarchive</Button>
    </div>
  {:else}
  <Composer
    bind:this={composer}
    placeholder={isChannel ? `Message #${name}` : name ? `Message ${name}` : "Message"}
    agents={directory.agents}
    channels={directory.channels}
    room={isChannel || isSolo ? { label: isChannel ? `#${name}` : "this room", members: others.map((m) => m.principal.id) } : null}
    {working}
    draftKey={roomDraftKey(id)}
    autofocus
    onsend={send}
    onstop={stop}
    {commands}
  />
  {/if}
</section>

<Menu bind:open={menuOpen} anchor={menuAnchor} items={menuItems} placement="bottom-end" />
{#if details && header}
  {#key details}
    <ChannelDetailsDialog
      {id}
      {name}
      purpose={header.purpose ?? ""}
      createdAt={header.createdAt ?? null}
      {archived}
      members={header.members}
      tab={details.tab}
      editDescription={details.editDescription}
      onsavepurpose={savePurpose}
      onrename={() => {
        renamingFromDetails = true;
        renameDialog.open(id, name);
      }}
      onaddpeople={() => {
        channelDetails.close();
        channelMembers?.openAdd();
      }}
      onarchive={() => {
        channelDetails.close();
        void archiveRoom(id, name);
      }}
      onunarchive={unarchive}
      onclose={() => channelDetails.close()}
    />
  {/key}
{/if}
{#if isSolo}
  <MemberPicker
    bind:open={inviteOpen}
    anchor={inviteAnchor}
    target={{ kind: "room", room: id, name, members: others.map((m) => m.principal.id), test: header?.test === true }}
    refresh={refreshHeader}
    placement="bottom-start"
  />
{/if}

<style>
  .conversation {
    container: conversation / inline-size;
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
  }
  .work-thread {
    display: inline-flex;
  }
  .conversation > :global(.panel-header .title) {
    min-width: min(40%, 12rem);
  }
  @container conversation (max-width: 640px) {
    .conversation > :global(.panel-header [data-work-thread] .label) {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
  }
  .conversation.slack {
    --timeline-measure: 100%;
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
  .title-button {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    max-width: 100%;
    margin-left: -6px;
    padding: 2px 6px;
    border: 0;
    border-radius: var(--radius-control, 6px);
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .title-button:hover {
    background: var(--affordance-ghost-hover);
  }
  .title-button :global(.avatar) {
    flex: none;
    margin-right: 2px;
  }
  .title-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .title-emoji {
    margin-right: 6px;
    font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif;
    font-size: 16px;
    line-height: 1;
  }
  .host {
    display: inline-flex;
    margin-left: 8px;
  }
  .host:empty {
    display: none;
  }
  .purpose {
    flex: 1 1 0;
    min-width: 0;
    margin-left: 10px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-subtle);
    font: var(--text-caption);
  }
  button.purpose {
    flex: 0 1 auto;
    margin-left: 4px;
    padding: 2px 6px;
    border: 0;
    border-radius: var(--radius-control);
    background: transparent;
    text-align: left;
    cursor: pointer;
  }
  button.purpose:hover {
    background: var(--affordance-ghost-hover);
    color: var(--text-standard);
  }
  .thread-room {
    margin-left: 8px;
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
  .agenda-pen {
    flex: none;
    margin: -3px 0;
    opacity: 0;
  }
  .agenda:hover .agenda-pen,
  .agenda-pen:focus-within {
    opacity: 1;
  }
  .agenda-edit {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .agenda-hint {
    color: var(--text-subtle);
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
    width: min(calc(100% - 32px), var(--timeline-measure, 52rem));
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
    width: min(calc(100% - 32px), var(--timeline-measure, 52rem));
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
