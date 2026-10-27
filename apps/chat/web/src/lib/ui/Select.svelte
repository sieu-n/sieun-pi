<script lang="ts" generics="T extends string">
  import Icon from "./Icon.svelte";

  type Option = { value: T; label: string; disabled?: boolean };
  type Props = {
    value: T;
    options: Option[];
    /** Accessible name. With `showLabel` it also shows as a small label before the control. */
    label: string;
    showLabel?: boolean;
    size?: "sm" | "md";
    disabled?: boolean;
    id?: string;
    onchange?: (value: T) => void;
  };
  let { value = $bindable(), options, label, showLabel = false, size = "md", disabled = false, id, onchange }: Props = $props();
</script>

<label class="select {size}">
  {#if showLabel}<span class="label">{label}</span>{/if}
  <span class="control">
    <select bind:value {id} {disabled} aria-label={showLabel ? undefined : label} onchange={() => onchange?.(value)}>
      {#each options as o (o.value)}
        <option value={o.value} disabled={o.disabled}>{o.label}</option>
      {/each}
    </select>
    <Icon name="chevron-down" size={16} />
  </span>
</label>

<style>
  .select {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .label {
    font: var(--text-caption);
    letter-spacing: var(--tracking-caption);
    color: var(--text-subtle);
  }
  .control {
    position: relative;
    display: inline-flex;
    align-items: center;
  }
  select {
    appearance: none;
    height: 32px;
    padding: 0 32px 0 12px;
    border: 1px solid var(--border-standard);
    border-radius: var(--radius-pill);
    background: var(--surface-panel);
    color: var(--text-standard);
    font: var(--text-body-sm);
    cursor: pointer;
  }
  .sm select {
    height: 28px;
    padding-left: 10px;
    font: var(--text-caption);
  }
  select:hover {
    background: var(--surface-inset);
  }
  .control :global(.icon) {
    position: absolute;
    right: 10px;
    pointer-events: none;
    color: var(--text-subtle);
  }
</style>
