<script lang="ts">
  import { agents, reads, view, type RunStatus } from "$lib/api";
  import Picker from "$lib/ui/Picker.svelte";
  import type { Anchor, Placement } from "$lib/ui/floating";
  import type { PickerItem } from "$lib/ui/types";
  import { directory } from "./directory.svelte";
  import { addMembership, type Membership, type MemberTarget } from "./membership";
  import { agentPickerItems } from "./present";

  type Props = {
    open: boolean;
    anchor: Anchor | null | undefined;
    target: MemberTarget;
    /** Reads the page again after an add. */
    refresh: () => Promise<void> | void;
    /** Called on a pick, before the add answers, for a list that reopens around the new member. */
    onpick?: () => void;
    placement?: Placement;
  };
  let { open = $bindable(), anchor, target, refresh, onpick, placement = "bottom-end" }: Props = $props();

  const statusText: Record<RunStatus, string> = { working: "Working now", idle: "Idle", sleeping: "Waiting for a model slot", failed: "Last run failed" };
  const testAgents = view(() => (open && target.kind === "room" && target.test ? reads.agents({ test: true }) : null));
  const testRooms = view(() => (open && target.kind === "agent" && target.test ? reads.testRooms() : null));
  const where = $derived(target.kind === "room" && target.room.startsWith("ch_") ? `#${target.name}` : target.name);

  const items = $derived.by((): PickerItem[] => {
    if (target.kind === "room") {
      const pool = target.test ? (testAgents.value ?? agents.list) : agents.list;
      const members = target.members;
      return agentPickerItems(pool)
        .filter((item) => !members.includes(item.id))
        .map((item) => {
          const status = pool.find((a) => a.id === item.id)?.status;
          return { ...item, ...(status ? { detail: statusText[status] } : {}) };
        });
    }
    const rooms = target.rooms;
    const channels = target.test ? (testRooms.value ?? []).filter((room) => room.kind === "channel" && room.test) : directory.channels;
    return channels
      .filter((room) => !room.archived && !rooms.includes(room.id))
      .map((room) => ({ id: room.id, label: room.name, icon: "hash", ...(room.agenda ? { detail: room.agenda } : {}) }));
  });

  /** A search that matches nothing says so; only an empty list means the agent or the room already has every member it could. */
  const emptyText = $derived.by(() => {
    if (target.kind === "room") return testAgents.loading && !testAgents.value ? "Loading agents" : items.length ? "No agent matches" : `Every agent is in ${where}`;
    if (testRooms.loading && !testRooms.value) return "Loading channels";
    return items.length ? "No channel matches" : `${target.name} is in every ${target.test ? "test channel" : "channel"}`;
  });

  function membership(id: string, item: PickerItem): Membership {
    return target.kind === "room"
      ? { room: target.room, roomName: target.name, agent: id, agentName: item.label }
      : { room: id, roomName: item.label, agent: target.agent, agentName: target.name };
  }
</script>

<Picker
  bind:open
  {anchor}
  {items}
  searchable
  label={target.kind === "room" ? `Add people to ${where}` : `Add ${target.name} to a channel`}
  placeholder={target.kind === "room" ? "Search agents" : "Search channels"}
  {emptyText}
  {placement}
  width={340}
  onselect={(id, item) => {
    onpick?.();
    void addMembership(membership(id, item), { refresh });
  }}
/>
