<script lang="ts">
  import Avatar from "./Avatar.svelte";

  import type { StackMember } from "./types";
  type Props = { members: StackMember[]; size?: number; max?: number; label?: string };
  let { members, size = 20, max = 3, label }: Props = $props();
  const shown = $derived(members.slice(0, max));
  const extra = $derived(members.length - shown.length);
</script>

<span class="stack" style:--overlap="{Math.round(size * 0.3)}px" aria-label={label ?? members.map((m) => m.name).join(", ")}>
  {#each shown as m (m.id)}
    <Avatar name={m.name} kind={m.kind ?? "agent"} src={m.src ?? null} seed={m.id} {size} ring />
  {/each}
  {#if extra > 0}
    <span class="more" style:height="{size}px" style:min-width="{size}px">+{extra}</span>
  {/if}
</span>

<style>
  .stack {
    display: inline-flex;
    align-items: center;
  }
  .stack > :global(*:not(:first-child)) {
    margin-left: calc(var(--overlap) * -1);
  }
  .more {
    display: inline-grid;
    place-items: center;
    padding: 0 4px;
    border-radius: var(--radius-pill);
    background: var(--affordance-subtle);
    box-shadow: 0 0 0 2px var(--surface-panel);
    font: var(--text-caption);
    color: var(--text-subtle);
  }
</style>
