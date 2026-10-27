<script lang="ts">
  import { mascotSvg } from "./mascot";

  type Props = {
    /** The agent id or name; the same seed always draws the same mascot. */
    seed: string;
    size?: number;
    /** Gradient id, needed when the same seed shows twice on one page. */
    id?: string;
    label?: string;
    class?: string;
  };
  let { seed, size = 64, id, label, class: className = "" }: Props = $props();
  const svg = $derived(id ? mascotSvg(seed, id) : mascotSvg(seed));
</script>

<span class="mascot {className}" style:width="{size}px" style:height="{size}px" role={label ? "img" : undefined} aria-label={label}>
  {@html svg}
</span>

<style>
  .mascot {
    display: inline-block;
    flex: none;
    line-height: 0;
  }
  .mascot :global(svg) {
    width: 100%;
    height: 100%;
  }
</style>
