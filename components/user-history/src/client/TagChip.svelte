<script lang="ts">
  import type { Tag } from "../shared/types.ts";

  let { tag }: { tag: Tag } = $props();
</script>

<span class="tag" style:--h={tag.hue} title={tag.name}>{tag.name}</span>

<style>
  .tag { display: inline-block; max-width: 96px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 6px; border-radius: 999px; font-size: 11px; line-height: 16px;
    background: hsl(var(--h) 70% 55% / 0.14); color: light-dark(hsl(var(--h) 50% 38%), hsl(var(--h) 70% 74%)); }
</style>
