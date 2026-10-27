<script lang="ts">
  import type { Snippet } from "svelte";

  type Props = {
    title: string;
    subtitle?: string;
    /** Buttons at the right of the title. */
    actions?: Snippet;
    /** Content under the title row, for example Tabs. */
    below?: Snippet;
    size?: "page" | "section";
  };
  let { title, subtitle, actions, below, size = "page" }: Props = $props();
</script>

<header class="page-header {size}">
  <div class="row">
    <div class="text">
      {#if size === "page"}<h1>{title}</h1>{:else}<h2>{title}</h2>{/if}
      {#if subtitle}<p>{subtitle}</p>{/if}
    </div>
    {#if actions}<div class="actions">{@render actions()}</div>{/if}
  </div>
  {#if below}<div class="below">{@render below()}</div>{/if}
</header>

<style>
  .page-header {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .row {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 16px;
  }
  .text {
    min-width: 0;
  }
  h1 {
    margin: 0;
    font: var(--text-title);
    letter-spacing: var(--tracking-title);
  }
  h2 {
    margin: 0;
    font: var(--text-label);
  }
  p {
    margin: 6px 0 0;
    font: var(--text-body);
    color: var(--text-subtle);
  }
  .section p {
    margin-top: 2px;
    font: var(--text-body-sm);
  }
  .actions {
    display: flex;
    gap: 8px;
    flex: none;
  }
</style>
