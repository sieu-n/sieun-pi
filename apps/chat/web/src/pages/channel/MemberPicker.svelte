<script lang="ts">
  import { untrack } from "svelte";
  import { agents, reads, view, type ListedRoom, type RunStatus } from "$lib/api";
  import Avatar from "$lib/ui/Avatar.svelte";
  import Button from "$lib/ui/Button.svelte";
  import Chip from "$lib/ui/Chip.svelte";
  import Picker from "$lib/ui/Picker.svelte";
  import type { Anchor, Placement } from "$lib/ui/floating";
  import type { PickerItem } from "$lib/ui/types";
  import { directory } from "./directory.svelte";
  import { addMemberships, type Membership, type MemberTarget } from "./membership";
  import { agentPickerItems } from "./present";

  type Props = {
    open: boolean;
    anchor: Anchor | null | undefined;
    target: MemberTarget;
    /** Reads the page again after an add. */
    refresh: () => Promise<void> | void;
    /** Called on Add, before the add answers, for a list that reopens around the new members. */
    onpick?: () => void;
    placement?: Placement;
  };
  let { open = $bindable(), anchor, target, refresh, onpick, placement = "bottom-end" }: Props = $props();

  const statusText: Record<RunStatus, string> = { working: "Working now", idle: "Idle", sleeping: "Waiting for a model slot", failed: "Last run failed" };
  const testAgents = view(() => (open && target.kind === "room" && target.test ? reads.testAgents() : null));
  const testRooms = view(() => (open && target.kind === "agent" && target.test ? reads.testRooms() : null));
  const where = $derived(target.kind === "room" && target.room.startsWith("ch_") ? `#${target.name}` : target.name);
  /** Picks wait as checked rows and chips until Add, as in Slack's add dialog. */
  let picked = $state<PickerItem[]>([]);

  $effect(() => {
    if (open) untrack(() => (picked = []));
  });

  const roomItem = (room: Pick<ListedRoom, "id" | "kind" | "name" | "agenda" | "members">): PickerItem =>
    room.kind === "solo"
      ? { id: room.id, label: room.name, icon: "users", group: "Solo rooms", detail: room.members.filter((m) => m.principal.id !== "owner").map((m) => m.principal.name).join(", ") }
      : { id: room.id, label: room.name, icon: "hash", group: "Channels", ...(room.agenda ? { detail: room.agenda } : {}) };

  const items = $derived.by((): PickerItem[] => {
    if (target.kind === "room") {
      // A walk's test room lists only test agents, so a walk never adds a real agent.
      const pool = target.test ? (testAgents.value ?? []) : agents.list;
      const members = target.members;
      return agentPickerItems(pool)
        .filter((item) => !members.includes(item.id))
        .map((item) => {
          const status = pool.find((a) => a.id === item.id)?.status;
          return { ...item, ...(status ? { detail: statusText[status] } : {}) };
        });
    }
    const rooms = target.rooms;
    const pool: readonly Pick<ListedRoom, "id" | "kind" | "name" | "agenda" | "members" | "archived" | "closedAt">[] = target.test
      ? (testRooms.value ?? []).filter((room) => room.test)
      : directory.rooms;
    return pool
      .filter((room) => !room.archived && !room.closedAt && !rooms.includes(room.id))
      .sort((a, b) => Number(a.kind === "solo") - Number(b.kind === "solo"))
      .map(roomItem);
  });

  /** A search that matches nothing says so; only an empty list means the agent or the room already has every member it could. */
  const emptyText = $derived.by(() => {
    if (target.kind === "room") return testAgents.loading && !testAgents.value ? "Loading agents" : items.length ? "No agent matches" : `Every agent is in ${where}`;
    if (testRooms.loading && !testRooms.value) return "Loading rooms";
    return items.length ? "No channel or Solo room matches" : `${target.name} is in every open ${target.test ? "test room" : "channel and Solo room"}`;
  });

  function membership(item: PickerItem): Membership {
    return target.kind === "room"
      ? { room: target.room, roomName: target.name, agent: item.id, agentName: item.label }
      : { room: item.id, roomName: item.label, agent: target.agent, agentName: target.name };
  }

  function toggle(item: PickerItem) {
    picked = picked.some((p) => p.id === item.id) ? picked.filter((p) => p.id !== item.id) : [...picked, item];
  }

  function add() {
    if (!picked.length) return;
    const batch = picked.map(membership);
    open = false;
    onpick?.();
    void addMemberships(batch, { refresh });
  }

  /** A chip's x pressed from the keyboard would leave focus on a removed button, so it goes back to the search box. */
  function unpick(item: PickerItem) {
    const from = document.activeElement;
    toggle(item);
    from?.closest("[role=dialog]")?.querySelector<HTMLInputElement>("input")?.focus();
  }
</script>

<Picker
  bind:open
  {anchor}
  {items}
  value={picked.map((p) => p.id)}
  multiple
  searchable
  label={target.kind === "room" ? `Add people to ${where}` : `Add ${target.name} to a channel or Solo room`}
  placeholder={target.kind === "room" ? "Search agents" : "Search channels and Solo rooms"}
  {emptyText}
  {placement}
  width={340}
  onselect={(_id, item) => toggle(item)}
  onsubmit={add}
>
  {#snippet footer()}
    <div class="add">
      <!-- A chip's x keeps focus in the search box, for the next name. -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="picked" onmousedown={(e) => e.preventDefault()}>
        {#each picked as item (item.id)}
          {#if item.avatar}
            {@const avatar = item.avatar}
            <Chip size="sm" label={item.label} removeLabel="Unpick {item.label}" onremove={() => unpick(item)}>
              {#snippet leading()}<Avatar name={avatar.name} kind="agent" seed={avatar.seed ?? item.id} size={16} />{/snippet}
            </Chip>
          {:else}
            <Chip size="sm" label={item.label} icon={item.icon} removeLabel="Unpick {item.label}" onremove={() => unpick(item)} />
          {/if}
        {:else}
          <span class="hint t-caption">Pick one or more, then Add</span>
        {/each}
      </div>
      <Button variant="primary" size="sm" disabled={!picked.length} onclick={add} data-testid="member-picker-add">Add</Button>
    </div>
  {/snippet}
</Picker>

<style>
  .add {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    padding: 4px 4px 2px;
  }
  .picked {
    display: flex;
    flex: 1;
    flex-wrap: wrap;
    gap: 6px;
    min-width: 0;
    max-height: 96px;
    overflow-y: auto;
  }
  .hint {
    align-self: center;
    color: var(--text-metadata);
  }
</style>
