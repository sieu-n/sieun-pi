<script lang="ts">
  import { agents, type Member, type RunStatus } from "$lib/api";
  import AvatarStack from "$lib/ui/AvatarStack.svelte";
  import Button from "$lib/ui/Button.svelte";
  import Picker from "$lib/ui/Picker.svelte";
  import type { PickerItem } from "$lib/ui/types";
  import { avatarKind } from "./present";

  type Props = {
    /** Every member of the room, the owner included, as Slack counts them. */
    members: Member[];
    /** A picked agent opens its DM. */
    onopen: (agentId: string) => void;
  };
  let { members, onopen }: Props = $props();

  let open = $state(false);
  let anchor = $state<HTMLElement>();

  const statusText: Record<RunStatus, string> = { working: "Working now", idle: "Idle", sleeping: "Waiting for a model slot", failed: "Last run failed" };
  const agentsFirst = $derived([...members].sort((a, b) => Number(a.principal.id === "owner") - Number(b.principal.id === "owner")));
  const stack = $derived(agentsFirst.map((m) => ({ id: m.principal.id, name: m.principal.name, kind: avatarKind(m.principal) })));
  const label = $derived(`${members.length} ${members.length === 1 ? "member" : "members"}`);
  const items = $derived<PickerItem[]>(
    agentsFirst.map((m) => {
      const status = agents.byId(m.principal.id)?.status ?? m.status;
      return {
        id: m.principal.id,
        label: m.principal.name,
        ...(status ? { detail: statusText[status] } : {}),
        group: label,
        avatar: { name: m.principal.name, kind: avatarKind(m.principal), seed: m.principal.id },
      };
    }),
  );
</script>

<Button variant="outline" size="sm" bind:element={anchor} onclick={() => (open = !open)} aria-label="Members, {label}" data-testid="channel-members">
  <span class="members"><AvatarStack members={stack.slice(0, 3)} size={20} max={3} label="" /><span class="count">{members.length}</span></span>
</Button>
<Picker
  bind:open
  {anchor}
  {items}
  label="Members"
  placement="bottom-end"
  width={320}
  onselect={(id) => {
    if (id !== "owner") onopen(id);
  }}
/>

<style>
  .members {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .count {
    font-variant-numeric: tabular-nums;
  }
</style>
