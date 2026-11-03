<script lang="ts">
  import Avatar from "$lib/ui/Avatar.svelte";
  import Icon from "$lib/ui/Icon.svelte";
  import { avatarOf } from "$pages/channel/present";
  import { author, type Hit } from "./hit-view";

  let { hit, size = 24 }: { hit: Hit; size?: number } = $props();
  const who = $derived(author(hit));
  const face = $derived(avatarOf(hit.author));
</script>

{#if who.avatar === "system"}
  <span class="system" style:width="{size}px" style:height="{size}px" title={who.name} data-avatar="system"><Icon name="settings" size={Math.round(size * 0.6)} /></span>
{:else}
  <Avatar name={face.name} kind={face.kind} seed={face.id} {size} />
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
