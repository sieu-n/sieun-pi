<script lang="ts">
  import type { Snippet } from "svelte";

  /** A Settings tab's own buttons (refresh, a switch), right-aligned above its content. */
  let { children }: { children: Snippet } = $props();
</script>

<div class="settings-actions">{@render children()}</div>

<style>
  .settings-actions { display: flex; align-items: center; justify-content: flex-end; gap: 6px; margin-bottom: -6px; }
</style>
