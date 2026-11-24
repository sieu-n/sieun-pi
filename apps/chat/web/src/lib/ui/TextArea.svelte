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
    // A closed dialog or a hidden tab lays nothing out, so scrollHeight reads 0 and would pin the box at its padding; leave `rows` in charge.
    if (!element.getClientRects().length) {
      element.style.height = "";
      return;
    }
    element.style.height = "auto";
    const style = getComputedStyle(element);
    const line = parseFloat(style.lineHeight) || 20;
    // scrollHeight leaves out the borders of this border-box field; short by them, the text overflowed 2 px and WebKit drew a scrollbar.
    const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    const cap = line * maxRows + 20;
    element.style.height = `${Math.min(element.scrollHeight, cap) + border}px`;
    element.style.overflowY = element.scrollHeight > cap ? "auto" : "hidden";
  });
</script>

<textarea bind:this={element} bind:value class="textarea {className}" class:invalid class:one-row={rows === 1} {rows} aria-invalid={invalid || undefined} {...rest}></textarea>

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
  /* A field that opens one line high and grows takes the corners of a text area, not a pill, so it reads as one that holds lines. */
  .one-row {
    border-radius: 8px;
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
