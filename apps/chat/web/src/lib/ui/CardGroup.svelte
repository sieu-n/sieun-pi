<script lang="ts">
  import type { Snippet } from "svelte";

  type Props = {
    title?: string;
    description?: string;
    /** Controls at the right of the title. */
    actions?: Snippet;
    /** Rows, usually NavItem variant="card" or custom rows; hairlines go between them. */
    children: Snippet;
  };
  let { title, description, actions, children }: Props = $props();
</script>

<section class="card-group">
  {#if title || actions}
    <header>
      <div>
        {#if title}<h2>{title}</h2>{/if}
        {#if description}<p>{description}</p>{/if}
      </div>
      {#if actions}<div class="actions">{@render actions()}</div>{/if}
    </header>
  {/if}
  <div class="card">{@render children()}</div>
</section>

<style>
  .card-group {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  header {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 12px;
    padding: 0 4px;
  }
  h2 {
    margin: 0;
    font: var(--text-label);
  }
  p {
    margin: 2px 0 0;
    font: var(--text-body-sm);
    color: var(--text-subtle);
  }
  .actions {
    display: flex;
    gap: 6px;
  }
  .card {
    display: flex;
    flex-direction: column;
    border-radius: var(--radius-container);
    background: var(--surface-panel);
    box-shadow: inset 0 0 0 1px var(--border-standard);
    overflow: hidden;
  }
  .card > :global(* + *) {
    border-top: 1px solid var(--border-standard);
  }
</style>
