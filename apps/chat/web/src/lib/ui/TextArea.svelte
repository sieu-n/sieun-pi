<script lang="ts">
  import type { HTMLTextareaAttributes } from "svelte/elements";

  type Props = Omit<HTMLTextareaAttributes, "value"> & {
    value?: string;
    /** Grow with the text up to this many rows. */
    maxRows?: number;
    invalid?: boolean;
    element?: HTMLTextAreaElement | undefined;
  };
  let { value = $bindable(""), rows = 3, maxRows = 12, invalid = false, element = $bindable(), class: className = "", ...rest }: Props = $props();

  $effect(() => {
    void value;
    if (!element) return;
    element.style.height = "auto";
    const line = parseFloat(getComputedStyle(element).lineHeight) || 20;
    element.style.height = `${Math.min(element.scrollHeight, line * maxRows + 20)}px`;
  });
</script>

<textarea bind:this={element} bind:value class="textarea {className}" class:invalid {rows} aria-invalid={invalid || undefined} {...rest}></textarea>

<style>
  .textarea {
    display: block;
    width: 100%;
    padding: 10px 12px;
    border: 1px solid var(--border-standard);
    border-radius: var(--radius-control);
    background: var(--surface-panel);
    font: var(--text-body);
    letter-spacing: var(--tracking-body);
    resize: none;
  }
  .textarea:focus {
    border-color: var(--border-prominent);
  }
  .textarea::placeholder {
    color: var(--text-metadata);
  }
  .invalid {
    border-color: var(--border-danger);
  }
</style>
