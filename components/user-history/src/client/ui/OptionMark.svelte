<script lang="ts" module>
  import type { Priority, Progress, Tag } from "../../shared/types.ts";
  import type { RowStatus } from "../organize.ts";
  import type { PulseLevel } from "../../shared/pulse.ts";
  /** The visual a filter option carries next to its label: a tag chip in its color, priority bars, the progress steps or the status glyph. */
  export type OptionMark = { kind: "tag"; tag: Tag } | { kind: "priority"; level: Priority } | { kind: "progress"; progress: Progress } | { kind: "status"; status: RowStatus; level?: PulseLevel };
</script>

<script lang="ts">
  import TagChip from "../TagChip.svelte";
  import PriorityBars from "../PriorityBars.svelte";
  import ProgressSteps from "../ProgressSteps.svelte";
  import StatusMark from "../StatusMark.svelte";

  let { mark }: { mark: OptionMark } = $props();
</script>

<span class="option-mark">
  {#if mark.kind === "tag"}<TagChip tag={mark.tag} />
  {:else if mark.kind === "priority"}<PriorityBars level={mark.level} />
  {:else if mark.kind === "progress"}<ProgressSteps progress={mark.progress} />
  {:else}<StatusMark status={mark.status} level={mark.level ?? "live"} />{/if}
</span>

<style>
  .option-mark { display: inline-flex; align-items: center; justify-content: center; flex: none; min-width: 14px; }
</style>
