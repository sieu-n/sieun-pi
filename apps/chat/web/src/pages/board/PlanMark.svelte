<script lang="ts">
  import type { StepStatus } from "./model";
  import { STATUS_LABEL } from "./model";

  let { status, size = 16 }: { status: StepStatus; size?: number } = $props();
</script>

<svg class="mark {status}" width={size} height={size} viewBox="0 0 16 16" role="img" aria-label={STATUS_LABEL[status]}>
  {#if status === "todo"}
    <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5" />
  {:else if status === "doing"}
    <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5" />
    <path d="M8 3.5a4.5 4.5 0 0 1 0 9z" fill="currentColor" />
  {:else if status === "done"}
    <circle cx="8" cy="8" r="7" fill="currentColor" />
    <path d="M5 8.2l2 2 4-4.2" fill="none" stroke="var(--surface-panel)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
  {:else if status === "blocked"}
    <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5" />
    <path d="M5 8h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
  {:else}
    <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.4 2" />
    <path d="M6 6l4 4M10 6l-4 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
  {/if}
</svg>

<style>
  .mark { flex: none; display: block; }
  .todo { color: var(--text-subtle); }
  .doing { color: var(--status-away); }
  .done { color: var(--status-online); }
  .blocked { color: var(--border-danger); }
  .dropped { color: var(--text-metadata); }
</style>
