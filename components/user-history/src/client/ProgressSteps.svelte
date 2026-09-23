<script lang="ts">
  import type { Progress } from "../shared/types.ts";
  import { PROGRESS_LABEL } from "./organize.ts";

  /** Three short segments for plan, implementation and QA; the steps up to the thread's stage are filled. */
  let { progress }: { progress: Progress } = $props();
  const STEPS = ["plan", "implementation", "qa"] as const;
  const reached = $derived(progress === "none" ? 0 : STEPS.indexOf(progress) + 1);
</script>

<span class="steps" class:done={reached === 3} role="img" aria-label="Progress: {PROGRESS_LABEL[progress]}">
  {#each STEPS as step, index (step)}<span class="step" class:on={index < reached}></span>{/each}
</span>

<style>
  .steps { display: inline-flex; align-items: center; gap: 2px; flex: none; }
  .step { width: 5px; height: 5px; border-radius: 1.5px; background: var(--border-strong); }
  .step.on { background: var(--accent); }
  .done .step.on { background: var(--success); }
</style>
