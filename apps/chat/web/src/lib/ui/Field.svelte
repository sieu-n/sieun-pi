<script lang="ts">
  import type { Snippet } from "svelte";

  type Props = {
    label: string;
    /** Pass the same id to the control inside, so the label points at it. */
    id: string;
    hint?: string;
    error?: string | null;
    optional?: boolean;
    /** Put the label beside the control instead of above it. */
    inline?: boolean;
    children: Snippet;
  };
  let { label, id, hint, error = null, optional = false, inline = false, children }: Props = $props();
</script>

<div class="field" class:inline class:invalid={!!error}>
  <label for={id}>
    {label}{#if optional}<span class="optional"> (optional)</span>{/if}
  </label>
  <div class="control">{@render children()}</div>
  {#if error}
    <p class="msg error" id="{id}-error" role="alert">{error}</p>
  {:else if hint}
    <p class="msg" id="{id}-hint">{hint}</p>
  {/if}
</div>

<style>
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .inline {
    display: grid;
    grid-template-columns: minmax(120px, auto) 1fr;
    align-items: center;
    column-gap: 12px;
  }
  .inline .msg {
    grid-column: 2;
  }
  label {
    font: var(--text-label-sm);
    letter-spacing: var(--tracking-label-sm);
    color: var(--text-standard);
  }
  .optional {
    font-weight: 400;
    color: var(--text-metadata);
  }
  .msg {
    margin: 0;
    font: var(--text-caption);
    letter-spacing: var(--tracking-caption);
    color: var(--text-metadata);
  }
  .error {
    color: var(--border-danger);
  }
  .invalid :global(.input) {
    border-color: var(--border-danger);
  }
</style>
