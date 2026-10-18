<script lang="ts">
  import type { Snippet } from "svelte";
  import Floating from "./ui/Floating.svelte";

  /** A trigger plus a floating panel. The panel mounts at the top layer, so a scroll container around the trigger never clips it. */
  let { open, onclose, align = "start", width = 280, maxHeight = 480, label, trigger, children }: {
    open: boolean; onclose: () => void; align?: "start" | "end"; width?: number; maxHeight?: number; label?: string; trigger: Snippet; children: Snippet;
  } = $props();
  let root: HTMLElement | undefined = $state();
  const anchor = $derived(open ? (root?.firstElementChild as HTMLElement | null) ?? root : undefined);
</script>

<span class="root" bind:this={root}>{@render trigger()}</span>
{#if open && anchor}
  <Floating {anchor} {width} {maxHeight} {align} {label} {onclose}>{@render children()}</Floating>
{/if}

<style>
  .root { display: inline-flex; min-width: 0; }
</style>
