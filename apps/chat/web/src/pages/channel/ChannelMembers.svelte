<script lang="ts">
  import { tick } from "svelte";
  import { agents, type Member, type RoomId, type RunStatus } from "$lib/api";
  import Avatar from "$lib/ui/Avatar.svelte";
  import AvatarStack from "$lib/ui/AvatarStack.svelte";
  import Button from "$lib/ui/Button.svelte";
  import Icon from "$lib/ui/Icon.svelte";
  import IconButton from "$lib/ui/IconButton.svelte";
  import Popover from "$lib/ui/Popover.svelte";
  import SearchField from "$lib/ui/SearchField.svelte";
  import type { Status } from "$lib/ui/types";
  import MemberPicker from "./MemberPicker.svelte";
  import { removeMembership, setWakeOn } from "./membership";
  import { avatarKind, avatarOf } from "./present";

  type Props = {
    room: RoomId;
    /** Every member of the room, the owner included, as Slack counts them. */
    members: Member[];
    /** The channel's name, without the #. */
    channel: string;
    /** A walk's test room, whose add picker lists only test agents. */
    test?: boolean;
    statusOf: (agentId: string) => Status | null;
    /** A picked agent opens its DM. */
    onopen: (agentId: string) => void;
    /** Reads the room's header again after an add or a remove. */
    refresh: () => Promise<void>;
  };
  let { room, members, channel, test = false, statusOf, onopen, refresh }: Props = $props();

  let open = $state(false);
  let adding = $state(false);
  /** The add picker opened from the member list goes back to it after a pick. */
  let addFromList = false;
  let anchor = $state<HTMLElement>();
  let listEl = $state<HTMLElement>();
  let query = $state("");
  let active = $state(0);
  /** Members removed here whose header refresh has not landed yet, so the row goes at once. */
  let leaving = $state<string[]>([]);
  /** Mentions only switches whose header refresh has not landed yet, so the row shows the new setting at once. */
  let switching = $state<Record<string, Member["wakeOn"]>>({});

  const statusText: Record<RunStatus, string> = { working: "Working now", idle: "Idle", sleeping: "Waiting for a model slot", failed: "Last run failed" };
  const isOwner = (m: Member) => m.principal.id === "owner";
  const present = $derived(members.filter((m) => !leaving.includes(m.principal.id)));
  const agentsFirst = $derived([...present].sort((a, b) => Number(isOwner(a)) - Number(isOwner(b))));
  const stack = $derived(agentsFirst.map((m) => avatarOf(m.principal)));
  const label = $derived(`${present.length} ${present.length === 1 ? "member" : "members"}`);
  const searchable = $derived(present.length > 7);
  const shown = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return q ? agentsFirst.filter((m) => m.principal.name.toLowerCase().includes(q)) : agentsFirst;
  });
  /** Arrow keys walk the Add people row and then each member row that opens a DM; the owner's row is not a stop. */
  const stops = $derived(["add", ...shown.filter((m) => !isOwner(m)).map((m) => m.principal.id)]);
  const target = $derived({ kind: "room" as const, room, name: channel, members: present.map((m) => m.principal.id), test });

  const wakeOf = (m: Member): Member["wakeOn"] => switching[m.principal.id] ?? m.wakeOn;

  function detailOf(m: Member): string {
    if (isOwner(m)) return "";
    const status = agents.byId(m.principal.id)?.status ?? m.status;
    return [status ? statusText[status] : "", wakeOf(m) === "none" ? "Mentions only" : ""].filter(Boolean).join(" · ");
  }

  $effect(() => {
    if (!open) return;
    query = "";
    active = 0;
  });
  $effect(() => {
    if (active >= stops.length) active = Math.max(0, stops.length - 1);
  });
  // A refresh that holds the removed member again (an undo) or drops it ends its pending hide.
  $effect(() => {
    const ids = new Set(members.map((m) => m.principal.id));
    if (leaving.some((id) => !ids.has(id))) leaving = leaving.filter((id) => ids.has(id));
  });
  // A refresh that carries a switched setting ends its pending show.
  $effect(() => {
    const landed = Object.keys(switching).filter((id) => members.find((m) => m.principal.id === id)?.wakeOn === switching[id]);
    if (landed.length) switching = Object.fromEntries(Object.entries(switching).filter(([id]) => !landed.includes(id)));
  });

  /** Add people in the channel menu opens the picker here. */
  export function openAdd(): void {
    open = false;
    addFromList = false;
    adding = true;
  }

  function startAdd() {
    open = false;
    addFromList = true;
    adding = true;
  }

  async function remove(m: Member) {
    const id = m.principal.id;
    const at = stops.indexOf(id);
    leaving = [...leaving, id];
    active = Math.min(Math.max(0, at), stops.length - 1);
    void tick().then(() => focusStop(active));
    const done = await removeMembership({ room, roomName: channel, agent: id, agentName: m.principal.name }, { wakeOn: m.wakeOn, refresh });
    if (!done) leaving = leaving.filter((x) => x !== id);
  }

  async function switchWake(m: Member) {
    const id = m.principal.id;
    const next = wakeOf(m) === "none" ? "all" : "none";
    switching = { ...switching, [id]: next };
    const done = await setWakeOn({ room, roomName: channel, agent: id, agentName: m.principal.name }, next, { refresh });
    if (!done) switching = Object.fromEntries(Object.entries(switching).filter(([x]) => x !== id));
  }

  function focusStop(index: number) {
    listEl?.querySelector<HTMLElement>(`[data-stop="${stops[index]}"]`)?.focus();
  }

  function onkeydown(e: KeyboardEvent) {
    const fromSearch = e.target instanceof HTMLInputElement;
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
      if (fromSearch && (e.key === "Home" || e.key === "End")) return;
      e.preventDefault();
      const n = stops.length;
      active = e.key === "Home" ? 0 : e.key === "End" ? n - 1 : fromSearch ? (e.key === "ArrowDown" ? 0 : n - 1) : (active + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      focusStop(active);
    } else if ((e.key === "Delete" || e.key === "Backspace") && !fromSearch) {
      const m = shown.find((x) => x.principal.id === stops[active]);
      if (m) {
        e.preventDefault();
        void remove(m);
      }
    } else if (fromSearch && e.key === "Enter") {
      e.preventDefault();
      const first = shown.find((m) => !isOwner(m));
      if (first) onopen(first.principal.id);
    }
  }
</script>

<Button variant="outline" size="sm" bind:element={anchor} onclick={() => (open = !open)} aria-label="Members, {label}" aria-expanded={open} data-testid="channel-members">
  <span class="members"><AvatarStack members={stack.slice(0, 3)} size={20} max={3} label="" /><span class="count">{present.length}</span></span>
</Button>

<Popover bind:open {anchor} placement="bottom-end" width={340} role="dialog" label="Members of #{channel}" padding={6}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="pop" {onkeydown} data-testid="channel-members-list">
    <h2 class="head t-label-sm">{label}</h2>
    {#if searchable}
      <div class="search"><SearchField bind:value={query} placeholder="Find members" label="Find members" oninput={() => (active = 0)} data-autofocus /></div>
    {/if}
    <ul class="rows" bind:this={listEl} aria-label="Members of #{channel}">
      <li class="row">
        <button type="button" class="main" data-stop="add" tabindex={active === 0 ? 0 : -1} onfocus={() => (active = 0)} onclick={startAdd} data-autofocus={searchable ? undefined : true} data-testid="members-add">
          <span class="add-icon"><Icon name="plus" size={16} /></span>
          <span class="text"><span class="name">Add people</span></span>
        </button>
      </li>
      {#each shown as m (m.principal.id)}
        {@const owner = isOwner(m)}
        {@const index = stops.indexOf(m.principal.id)}
        {@const detail = detailOf(m)}
        {@const mentionsOnly = !owner && wakeOf(m) === "none"}
        <li class="row" class:self={owner} data-member={m.principal.id}>
          {#if owner}
            <div class="main">
              <span class="face" aria-hidden="true"><Avatar name={m.principal.name} kind={avatarKind(m.principal)} seed={m.principal.id} size={28} /></span>
              <span class="text"><span class="name">{m.principal.name}{#if m.principal.name !== "You"} <span class="you">(you)</span>{/if}</span></span>
            </div>
          {:else}
            <button type="button" class="main" data-stop={m.principal.id} tabindex={index === active ? 0 : -1} onfocus={() => (active = index)} onclick={() => onopen(m.principal.id)} title="Open DM with {m.principal.name}">
              <span class="face" aria-hidden="true"><Avatar name={m.principal.name} kind={avatarKind(m.principal)} seed={m.principal.id} size={28} status={statusOf(m.principal.id)} /></span>
              <span class="text">
                <span class="name">{m.principal.name}</span>
                {#if detail}<span class="detail">{detail}</span>{/if}
              </span>
            </button>
            <span class="mute" class:on={mentionsOnly}>
              <IconButton
                icon={mentionsOnly ? "bell-off" : "bell"}
                size="sm"
                label="Mentions only for {m.principal.name}"
                pressed={mentionsOnly}
                tabindex={index === active ? 0 : -1}
                onclick={() => void switchWake(m)}
              />
            </span>
            <span class="remove">
              <Button variant="ghost" size="sm" tabindex={index === active ? 0 : -1} aria-label="Remove {m.principal.name} from #{channel}" onclick={() => void remove(m)}>Remove</Button>
            </span>
          {/if}
        </li>
      {:else}
        <li class="empty">No member matches "{query}"</li>
      {/each}
    </ul>
  </div>
</Popover>

<MemberPicker bind:open={adding} {anchor} {target} {refresh} onpick={() => {
    if (addFromList) void tick().then(() => (open = true));
  }} />

<style>
  .members {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .count {
    font-variant-numeric: tabular-nums;
  }
  .pop {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: min(480px, var(--popover-available-height, 480px));
  }
  .head {
    margin: 0;
    padding: 6px 10px 2px;
    color: var(--text-standard);
  }
  .search {
    padding: 2px 2px 4px;
  }
  .rows {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-height: 0;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    list-style: none;
  }
  .row {
    position: relative;
    display: flex;
    flex: none;
    align-items: center;
    border-radius: 12px;
  }
  .row:hover:not(.self),
  .row:has(:focus-visible) {
    background: var(--affordance-ghost-hover);
  }
  .main {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 10px;
    min-width: 0;
    min-height: 40px;
    padding: 6px 10px;
    border: 0;
    border-radius: 12px;
    background: transparent;
    text-align: left;
    font: var(--text-body-sm);
    color: var(--text-standard);
  }
  button.main {
    cursor: pointer;
  }
  .main:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: -2px;
  }
  .face {
    display: inline-flex;
    flex: none;
  }
  .add-icon {
    display: inline-grid;
    flex: none;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: 9px;
    background: var(--affordance-ghost-hover);
    color: var(--text-subtle);
  }
  .text {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
  }
  .name,
  .detail {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .detail {
    font: var(--text-caption);
    color: var(--text-metadata);
  }
  .you {
    color: var(--text-metadata);
  }
  .mute,
  .remove {
    flex: none;
    opacity: 0;
  }
  .remove {
    padding-right: 6px;
  }
  .mute.on,
  .row:hover :is(.mute, .remove),
  .row:has(:focus-visible) :is(.mute, .remove) {
    opacity: 1;
  }
  @media (hover: none) {
    .mute,
    .remove {
      opacity: 1;
    }
  }
  .empty {
    padding: 12px 10px;
    font: var(--text-caption);
    color: var(--text-metadata);
  }
</style>
