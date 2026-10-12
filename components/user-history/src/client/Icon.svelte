<script lang="ts">
  import { ICON_PATHS, type IconName } from "./icons.ts";

  /** `filled` paints the shape solid, for a toggle that is on (a saved bookmark). */
  let { name, size = 18, filled = false }: { name: IconName; size?: number; filled?: boolean } = $props();
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d={ICON_PATHS[name]} />
</svg>
