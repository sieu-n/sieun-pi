<script lang="ts">
  import { PLAN_STATUS_LABEL } from "./board.ts";
  import type { PlanStatus } from "../shared/types.ts";
  import Icon from "./Icon.svelte";

  /** A plan step's status as an 18 px inline mark: a spinner while doing, a muted check when done, a ring with a slash when blocked, a dashed ring when dropped. */
  let { status }: { status: PlanStatus } = $props();
</script>

<span class="status" title={PLAN_STATUS_LABEL[status]} role="img" aria-label={PLAN_STATUS_LABEL[status]}>
  {#if status === "doing"}<span class="spinner tiny"></span>
  {:else if status === "done"}<span class="mark done"><Icon name="check" size={11} /></span>
  {:else}<span class="mark {status}"></span>{/if}
</span>

<style>
  .status { display: inline-flex; vertical-align: top; width: 14px; height: 18px; align-items: center; justify-content: center; }
  .mark { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 9px; height: 9px; border-radius: 50%; border: 1.5px solid var(--border-strong); box-sizing: border-box; }
  .mark.done { width: 13px; height: 13px; border: 0; color: color-mix(in srgb, var(--success) 70%, var(--text-muted)); }
  /* Blocked: a hollow ring with a slash, in the muted text color; the step text keeps its color. */
  .mark.blocked { width: 10px; height: 10px; border-color: var(--text-muted); }
  .mark.blocked::after { content: ""; position: absolute; left: 50%; top: -3px; bottom: -3px; width: 1.5px; margin-left: -0.75px; background: var(--text-muted); transform: rotate(45deg); }
  .mark.dropped { border-style: dashed; opacity: 0.6; }
</style>
