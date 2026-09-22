<script lang="ts">
  import type { Snippet } from "svelte";

  let { open, onclose, align = "start", side = "below", width = "auto", trigger, children }: {
    open: boolean; onclose: () => void; align?: "start" | "end"; side?: "below" | "above"; width?: string; trigger: Snippet; children: Snippet;
  } = $props();
  let root: HTMLElement | undefined = $state();

  $effect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => { if (root && event.target instanceof Node && !root.contains(event.target)) onclose(); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onclose(); } };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("pointerdown", onPointer, true); document.removeEventListener("keydown", onKey, true); };
  });
</script>

<div class="root" bind:this={root}>
  {@render trigger()}
  {#if open}
    <div class="panel fade-in {align} {side}" style:min-width={width} role="dialog">
      {@render children()}
    </div>
  {/if}
</div>

<style>
  .root { position: relative; display: inline-flex; min-width: 0; }
  .panel {
    position: absolute; z-index: 30; padding: 6px; border-radius: var(--radius); border: 1px solid var(--border);
    background: var(--bg-elevated); box-shadow: var(--shadow); max-height: min(60vh, 480px); overflow: auto;
  }
  .start { left: 0; } .end { right: 0; }
  .below { top: calc(100% + 6px); } .above { bottom: calc(100% + 6px); }
</style>
