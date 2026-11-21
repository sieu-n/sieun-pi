<script lang="ts">
  import type { Snippet } from "svelte";

  /** One setting of Preferences or Notifications: its name on the left, an optional quiet line under it, and its control on the right. */
  type Props = {
    label: string;
    /** The id of the control, so the name labels it. */
    for?: string;
    /** A short line under the name, such as the state of a pause or a browser block. */
    detail?: string;
    /** The full text behind `detail`, as a tooltip. */
    detailTitle?: string;
    children: Snippet;
  };
  let { label, for: htmlFor, detail, detailTitle, children }: Props = $props();
</script>

<div class="setting" data-setting={htmlFor}>
  <div class="text">
    {#if htmlFor}<label for={htmlFor}>{label}</label>{:else}<span class="label">{label}</span>{/if}
    {#if detail}<span class="detail" title={detailTitle}>{detail}</span>{/if}
  </div>
  <div class="control">{@render children()}</div>
</div>

<style>
  .setting {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    min-height: 52px;
    padding: 8px 16px;
  }
  .text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  label,
  .label {
    font: var(--text-body-sm);
    color: var(--text-standard);
  }
  .detail {
    font: var(--text-caption);
    color: var(--text-metadata);
  }
  .control {
    display: flex;
    flex: none;
    align-items: center;
    gap: var(--space-2);
  }
</style>
