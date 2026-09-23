<script lang="ts">
  import type { RowStatus } from "./organize.ts";

  /** The status glyph rows share: a spinner while working, an accent dot for needs response, a ring when idle, a dashed ring when saved. */
  let { status }: { status: RowStatus } = $props();
</script>

{#if status === "working"}<span class="spinner tiny" aria-hidden="true"></span>{:else}<span class="mark {status}" aria-hidden="true"></span>{/if}

<style>
  .mark { display: inline-block; flex: none; width: 7px; height: 7px; border-radius: 50%; border: 1.5px solid var(--border-strong); }
  .mark.needs { border: 0; background: var(--accent); }
  .mark.saved { border-style: dashed; }
</style>
