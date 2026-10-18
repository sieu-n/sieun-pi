<script lang="ts">
  import type { Tag } from "../shared/types.ts";

  let { tag }: { tag: Tag } = $props();
</script>

<span class="tag" style:--h={tag.hue}>{tag.name}</span>

<style>
  .tag { display: inline-block; flex: none; max-width: 96px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 5px; border-radius: 4px; font-size: 11px; font-weight: 500; line-height: 16px;
    background: light-dark(hsl(var(--h) 70% 50% / 0.12), hsl(var(--h) 60% 60% / 0.16)); color: light-dark(hsl(var(--h) 55% 32%), hsl(var(--h) 70% 76%)); }
</style>
