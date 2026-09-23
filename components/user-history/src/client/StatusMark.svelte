<script lang="ts">
  import type { RowStatus } from "./organize.ts";
  import type { PulseLevel } from "../shared/pulse.ts";

  /**
   * The status glyph rows share. Running: a spinner while live, a dim spinner when quiet, an amber dot when stalled, a red dot when failed.
   * Otherwise an accent dot for needs response, a ring when idle, a dashed ring when saved.
   */
  let { status, level = "live" }: { status: RowStatus; level?: PulseLevel } = $props();
  const running = $derived(status === "working" || status === "stalled");
</script>

{#if running && (level === "live" || level === "quiet")}<span class="spinner tiny" class:quiet={level === "quiet"} aria-hidden="true"></span>
{:else if running}<span class="mark {level}" aria-hidden="true"></span>
{:else}<span class="mark {status}" aria-hidden="true"></span>{/if}

<style>
  .mark { display: inline-block; flex: none; width: 7px; height: 7px; border-radius: 50%; border: 1.5px solid var(--border-strong); }
  .mark.needs { border: 0; background: var(--accent); }
  .mark.saved { border-style: dashed; }
  .mark.stalled { border: 0; width: 8px; height: 8px; background: var(--warning); box-shadow: 0 0 0 2px color-mix(in srgb, var(--warning) 22%, transparent); }
  .mark.failed { border: 0; width: 8px; height: 8px; background: var(--danger); box-shadow: 0 0 0 2px color-mix(in srgb, var(--danger) 22%, transparent); }
  .spinner.quiet { opacity: 0.4; animation-duration: 2.4s; }
</style>
