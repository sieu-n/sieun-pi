<script lang="ts">
  import type { Snippet } from "svelte";
  import ResizeHandle from "./ResizeHandle.svelte";

  type Props = {
    /** The list on the left, flexible with a 320 px floor. */
    list: Snippet;
    /** The detail on the right, at `detailWidth` and resizable. Hidden when absent. */
    detail?: Snippet | undefined;
    detailWidth?: number;
    minDetail?: number;
    minList?: number;
    /** localStorage key for the detail width. */
    storageKey?: string;
    label?: string;
  };
  let { list, detail, detailWidth = 420, minDetail = 316, minList = 320, storageKey, label = "Resize detail" }: Props = $props();

  let width = $state(initial());
  let total = $state(1200);
  const max = $derived(Math.max(minDetail, total - minList - 8));

  function initial(): number {
    if (!storageKey) return detailWidth;
    try {
      const n = Number(localStorage.getItem(storageKey));
      return n >= minDetail ? n : detailWidth;
    } catch {
      return detailWidth;
    }
  }
  function save(px: number) {
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, String(Math.round(px)));
    } catch {}
  }
</script>

<div class="split" bind:clientWidth={total}>
  <div class="list">{@render list()}</div>
  {#if detail}
    <div class="detail" style:width="{Math.min(width, max)}px">
      <ResizeHandle size={Math.min(width, max)} min={minDetail} {max} edge="end" {label} onresize={(px) => (width = px)} oncommit={save} />
      {@render detail()}
    </div>
  {/if}
</div>

<style>
  .split {
    display: flex;
    flex: 1;
    min-height: 0;
    min-width: 0;
  }
  .list {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: auto;
  }
  .detail {
    position: relative;
    flex: none;
    min-height: 0;
    overflow: auto;
    border-left: 1px solid var(--border-standard);
  }
</style>
