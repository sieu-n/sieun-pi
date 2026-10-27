<script lang="ts">
  import type { Snippet } from "svelte";
  import Icon from "./Icon.svelte";
  import IconButton from "./IconButton.svelte";

  type Props = {
    value?: string;
    placeholder?: string;
    /** inline: a 32 px field for lists. palette: the 20 px search dialog input with no border. */
    variant?: "inline" | "palette";
    /** Chips before the text, for example from: and in: operators or a scope chip. */
    prefix?: Snippet;
    /** Controls after the text. */
    suffix?: Snippet;
    label?: string;
    clearable?: boolean;
    element?: HTMLInputElement | undefined;
    oninput?: (value: string) => void;
    onkeydown?: (e: KeyboardEvent) => void;
    [key: string]: unknown;
  };
  let {
    value = $bindable(""),
    placeholder = "Search",
    variant = "inline",
    prefix,
    suffix,
    label = "Search",
    clearable = true,
    element = $bindable(),
    oninput,
    onkeydown,
    ...rest
  }: Props = $props();
</script>

<div class="search {variant}">
  <Icon name="search" size={variant === "palette" ? 20 : 16} />
  {#if prefix}<div class="prefix">{@render prefix()}</div>{/if}
  <input
    bind:this={element}
    bind:value
    type="search"
    aria-label={label}
    {placeholder}
    autocomplete="off"
    spellcheck="false"
    oninput={() => oninput?.(value)}
    {onkeydown}
    {...rest}
  />
  {#if clearable && value}
    <IconButton
      icon="close"
      label="Clear"
      size="xs"
      tip={false}
      onclick={() => {
        value = "";
        oninput?.("");
        element?.focus();
      }}
    />
  {/if}
  {#if suffix}{@render suffix()}{/if}
</div>

<style>
  .search {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    color: var(--text-metadata);
  }
  .inline {
    height: 32px;
    padding: 0 6px 0 10px;
    border-radius: var(--radius-pill);
    background: var(--surface-inset);
  }
  .inline:focus-within {
    box-shadow: inset 0 0 0 1px var(--border-prominent);
  }
  .palette {
    min-height: 56px;
    padding: 12px 8px;
  }
  .prefix {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
  }
  input {
    flex: 1;
    min-width: 80px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--text-standard);
    font: var(--text-body-sm);
  }
  .palette input {
    font: 400 20px/28px var(--font-sans);
    letter-spacing: -0.01em;
  }
  input::placeholder {
    color: var(--text-metadata);
  }
  input::-webkit-search-cancel-button {
    display: none;
  }
</style>
