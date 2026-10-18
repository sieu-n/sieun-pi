<script lang="ts">
  import type { Priority } from "../shared/types.ts";
  import LevelPicker from "./ui/LevelPicker.svelte";
  import PriorityBars from "./PriorityBars.svelte";

  let { value, onchange, autofocus = false }: { value: Priority | null; onchange: (value: Priority) => void; autofocus?: boolean } = $props();
  const LEVELS: readonly Priority[] = [0, 1, 2, 3];
</script>

<LevelPicker label="Priority" values={LEVELS} {value} {onchange} {autofocus}>
  {#snippet item(level)}{#if level === 0}None{:else}<PriorityBars {level} size={13} />{/if}{/snippet}
</LevelPicker>
