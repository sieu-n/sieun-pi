<script lang="ts">
  import { me } from "$lib/api";
  import Avatar from "$lib/ui/Avatar.svelte";
  import Icon from "$lib/ui/Icon.svelte";
  import { author, type Hit } from "./hit-view";

  let { hit, size = 24 }: { hit: Hit; size?: number } = $props();
  const who = $derived(author(hit));
</script>

{#if who.avatar === "system"}
  <span class="system" style:width="{size}px" style:height="{size}px" title={who.name} data-avatar="system"><Icon name="settings" size={Math.round(size * 0.6)} /></span>
{:else if who.avatar === "person"}
  <Avatar name={me.value?.owner.name ?? "You"} kind="person" seed="owner" {size} />
{:else}
  <Avatar name={who.name} kind="agent" seed={who.seed} {size} />
{/if}

<style>
  .system {
    display: inline-grid;
    place-items: center;
    flex: none;
    border-radius: 30%;
    background: var(--affordance-subtle);
    color: var(--text-subtle);
  }
</style>
