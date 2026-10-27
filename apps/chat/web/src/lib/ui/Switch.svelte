<script lang="ts">
  type Props = {
    checked?: boolean;
    label: string;
    /** Show the label text beside the switch; otherwise it is only the accessible name. */
    showLabel?: boolean;
    disabled?: boolean;
    onchange?: (checked: boolean) => void;
  };
  let { checked = $bindable(false), label, showLabel = false, disabled = false, onchange }: Props = $props();
</script>

<button
  type="button"
  class="switch-wrap"
  role="switch"
  aria-checked={checked}
  aria-label={showLabel ? undefined : label}
  {disabled}
  onclick={() => {
    checked = !checked;
    onchange?.(checked);
  }}
>
  <span class="track" class:on={checked}><span class="thumb"></span></span>
  {#if showLabel}<span class="label">{label}</span>{/if}
</button>

<style>
  .switch-wrap {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 0;
    border: 0;
    background: transparent;
    font: var(--text-body-sm);
  }
  .switch-wrap:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .track {
    position: relative;
    width: 32px;
    height: 20px;
    border-radius: var(--radius-pill);
    background: var(--neutral-5);
    transition: background-color var(--duration-base) var(--ease-standard);
  }
  .track.on {
    background: var(--affordance-prominent);
  }
  .thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #fff;
    box-shadow: var(--shadow-xs);
    transition: transform var(--duration-base) var(--ease-enter);
  }
  .on .thumb {
    transform: translateX(12px);
  }
  :global(:root[data-color-mode="dark"]) .on .thumb {
    background: #000;
  }
</style>
