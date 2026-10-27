<script lang="ts">
  import type { Snippet } from "svelte";
  import Icon from "./Icon.svelte";

  type Props = {
    checked?: boolean;
    indeterminate?: boolean;
    label?: string;
    /** Rich label content instead of `label`. */
    children?: Snippet;
    disabled?: boolean;
    /** round draws a circle, for to-do style done marks. */
    shape?: "square" | "round";
    onchange?: (checked: boolean) => void;
    [key: string]: unknown;
  };
  let { checked = $bindable(false), indeterminate = false, label, children, disabled = false, shape = "square", onchange, ...rest }: Props = $props();
</script>

<label class="checkbox" class:disabled>
  <input
    type="checkbox"
    bind:checked
    {indeterminate}
    {disabled}
    onchange={() => onchange?.(checked)}
    aria-label={!label && !children ? (rest["aria-label"] as string | undefined) : undefined}
    {...rest}
  />
  <span class="box {shape}" class:on={checked || indeterminate} aria-hidden="true">
    {#if indeterminate}<Icon name="minus" size={12} />{:else if checked}<Icon name="check" size={12} />{/if}
  </span>
  {#if children}{@render children()}{:else if label}<span class="label">{label}</span>{/if}
</label>

<style>
  .checkbox {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font: var(--text-body-sm);
    cursor: pointer;
  }
  .disabled {
    opacity: 0.5;
    cursor: default;
  }
  input {
    position: absolute;
    opacity: 0;
    width: 16px;
    height: 16px;
    margin: 0;
  }
  .box {
    display: inline-grid;
    place-items: center;
    flex: none;
    width: 16px;
    height: 16px;
    border-radius: 5px;
    box-shadow: inset 0 0 0 1.5px var(--border-prominent);
    color: var(--text-on-prominent);
    transition: background-color var(--duration-fast) var(--ease-standard);
  }
  .round {
    border-radius: 50%;
    width: 18px;
    height: 18px;
  }
  .box.on {
    background: var(--affordance-prominent);
    box-shadow: none;
  }
  .box :global(.icon) {
    stroke-width: 2.2;
  }
  input:focus-visible + .box {
    outline: 2px solid var(--border-focus);
    outline-offset: 2px;
  }
</style>
