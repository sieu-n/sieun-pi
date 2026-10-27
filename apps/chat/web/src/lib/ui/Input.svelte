<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLInputAttributes } from "svelte/elements";
  import Icon from "./Icon.svelte";

  type Props = Omit<HTMLInputAttributes, "size" | "value"> & {
    value?: string;
    size?: "sm" | "md" | "lg";
    icon?: string;
    /** Content inside the field before the text, for example chips. */
    prefix?: Snippet;
    /** Content inside the field after the text, for example a clear button. */
    suffix?: Snippet;
    invalid?: boolean;
    element?: HTMLInputElement | undefined;
  };
  let { value = $bindable(""), size = "md", icon, prefix, suffix, invalid = false, element = $bindable(), class: className = "", ...rest }: Props = $props();
</script>

<div class="input {size} {className}" class:invalid>
  {#if icon}<Icon name={icon} size={size === "lg" ? 20 : 16} />{/if}
  {#if prefix}{@render prefix()}{/if}
  <input bind:this={element} bind:value aria-invalid={invalid || undefined} {...rest} />
  {#if suffix}{@render suffix()}{/if}
</div>

<style>
  .input {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    padding: 0 12px;
    border: 1px solid var(--border-standard);
    border-radius: var(--radius-control);
    background: var(--surface-panel);
    color: var(--text-standard);
    transition: border-color var(--duration-fast) var(--ease-standard);
  }
  .input:focus-within {
    border-color: var(--border-prominent);
  }
  .input :global(.icon) {
    color: var(--text-metadata);
  }
  .sm {
    height: 32px;
    border-radius: var(--radius-row);
  }
  .md {
    height: 40px;
  }
  .lg {
    height: 48px;
  }
  .invalid {
    border-color: var(--border-danger);
  }
  input {
    flex: 1;
    min-width: 0;
    height: 100%;
    padding: 0;
    border: 0;
    background: transparent;
    font: var(--text-body);
    letter-spacing: var(--tracking-body);
  }
  .lg input {
    font: var(--text-body-lg);
  }
  input::placeholder {
    color: var(--text-metadata);
  }
  input:disabled {
    opacity: 0.5;
  }
</style>
