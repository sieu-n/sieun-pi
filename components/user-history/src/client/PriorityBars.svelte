<script lang="ts">
  import type { Priority } from "../shared/types.ts";
  import { PRIORITY_LABEL } from "./organize.ts";

  let { level, size = 12 }: { level: Priority; size?: number } = $props();
</script>

<svg class="bars" class:high={level === 3} width={size} height={size} viewBox="0 0 12 12" role="img" aria-label="Priority: {PRIORITY_LABEL[level]}">
  <title>Priority: {PRIORITY_LABEL[level]}</title>
  {#each [1, 2, 3] as bar (bar)}
    <rect x={(bar - 1) * 4 + 0.5} y={11 - bar * 3.3} width="3" height={bar * 3.3} rx="0.8" class:on={bar <= level} />
  {/each}
</svg>

<style>
  .bars { flex: none; display: block; }
  rect { fill: var(--border-strong); }
  rect.on { fill: var(--text-muted); }
  .high rect.on { fill: var(--accent); }
</style>
