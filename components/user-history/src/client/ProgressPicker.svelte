<script lang="ts">
  import { PROGRESS_LABEL } from "./organize.ts";
  import { PROGRESS_STEPS, type Progress } from "../shared/types.ts";
  import LevelPicker from "./ui/LevelPicker.svelte";

  let { value, onchange, autofocus = false }: { value: Progress | null; onchange: (value: Progress) => void; autofocus?: boolean } = $props();
</script>

<LevelPicker label="Progress" values={PROGRESS_STEPS} {value} {onchange} {autofocus} fill>
  {#snippet item(step)}{step === "none" ? "None" : PROGRESS_LABEL[step]}{/snippet}
</LevelPicker>
