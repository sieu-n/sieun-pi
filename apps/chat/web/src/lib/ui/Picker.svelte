<script lang="ts">
  import type { Snippet } from "svelte";
  import Avatar from "./Avatar.svelte";
  import Icon from "./Icon.svelte";
  import Popover from "./Popover.svelte";
  import SearchField from "./SearchField.svelte";
  import type { Anchor, Placement } from "./floating";
  import type { PickerItem } from "./types";

  type Props = {
    open: boolean;
    anchor: Anchor | null | undefined;
    items: PickerItem[];
    /** Selected id, or ids when `multiple`. */
    value?: string | string[] | null;
    multiple?: boolean;
    /** Show the filter field; defaults to on when there are more than 7 items. */
    searchable?: boolean;
    placeholder?: string;
    emptyText?: string;
    width?: number;
    placement?: Placement;
    label?: string;
    onselect: (id: string, item: PickerItem) => void;
    onclose?: () => void;
    /** Extra rows under the list, for example a "Custom model" field or an effort control. */
    footer?: Snippet<[{ query: string; close: () => void }]>;
    /**
     * Typeahead mode for a text box that keeps the caret, such as the composer's @ list: the list filters by `query`,
     * shows no search field, never takes focus, and reads ArrowUp, ArrowDown, Enter and Tab from `keys`.
     */
    typeahead?: { query: string; keys: HTMLElement };
  };
  let {
    open = $bindable(),
    anchor,
    items,
    value = null,
    multiple = false,
    searchable,
    placeholder = "Search",
    emptyText = "No matches",
    width = 300,
    placement = "bottom-start",
    label = "Choose",
    onselect,
    onclose,
    footer,
    typeahead,
  }: Props = $props();

  let query = $state("");
  let active = $state(0);
  let listEl = $state<HTMLElement>();
  const listId = `pick-${Math.random().toString(36).slice(2, 8)}`;

  const showSearch = $derived(!typeahead && (searchable ?? items.length > 7));
  const selected = $derived(new Set(Array.isArray(value) ? value : value ? [value] : []));
  const filtered = $derived.by(() => {
    const q = (typeahead ? typeahead.query : query).trim().toLowerCase();
    if (!q) return items;
    return items.filter((i) => [i.label, i.detail ?? "", i.group ?? "", ...(i.keywords ?? [])].join(" ").toLowerCase().includes(q));
  });
  const groups = $derived.by(() => {
    const out: { name: string; items: { item: PickerItem; index: number }[] }[] = [];
    filtered.forEach((item, index) => {
      const name = item.group ?? "";
      let g = out.find((x) => x.name === name);
      if (!g) out.push((g = { name, items: [] }));
      g.items.push({ item, index });
    });
    return out;
  });

  $effect(() => {
    if (open) {
      query = "";
      const at = items.findIndex((i) => selected.has(i.id));
      active = Math.max(0, at);
    }
  });
  $effect(() => {
    if (active >= filtered.length) active = Math.max(0, filtered.length - 1);
  });
  $effect(() => {
    const keys = typeahead?.keys;
    if (!open || !keys) return;
    const onKeys = (e: KeyboardEvent) => {
      if (e.key === "Tab") {
        const item = filtered[active];
        if (item) {
          e.preventDefault();
          choose(item);
        }
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter") onKeydown(e);
    };
    keys.addEventListener("keydown", onKeys, true);
    return () => keys.removeEventListener("keydown", onKeys, true);
  });

  function close() {
    open = false;
    onclose?.();
  }
  function choose(item: PickerItem) {
    if (item.disabled) return;
    onselect(item.id, item);
    if (!multiple) close();
  }
  function onKeydown(e: KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = filtered.length;
      if (!n) return;
      let next = active;
      for (let k = 0; k < n; k++) {
        next = (next + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
        if (!filtered[next]!.disabled) break;
      }
      active = next;
      listEl?.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      const item = filtered[active];
      if (item) {
        e.preventDefault();
        choose(item);
      }
    }
  }
</script>

<Popover bind:open {anchor} {placement} {width} surface="glass" role="dialog" {label} onclose={close} padding={6} autofocus={!typeahead}>
  <div class="picker" onkeydown={onKeydown} role="presentation">
    {#if showSearch}
      <div class="search"><SearchField bind:value={query} {placeholder} label={placeholder} data-autofocus aria-controls={listId} aria-activedescendant={filtered[active] ? `${listId}-${active}` : undefined} /></div>
    {/if}
    <div class="list" id={listId} role="listbox" aria-multiselectable={multiple || undefined} bind:this={listEl} tabindex={showSearch ? -1 : 0}>
      {#each groups as g (g.name)}
        {#if g.name}<div class="group" role="presentation">{g.name}</div>{/if}
        {#each g.items as { item, index } (item.id)}
          <button
            type="button"
            class="option"
            class:active={index === active}
            id="{listId}-{index}"
            data-index={index}
            role="option"
            aria-selected={selected.has(item.id)}
            aria-disabled={item.disabled || undefined}
            tabindex="-1"
            onpointermove={() => (active = index)}
            onclick={() => choose(item)}
          >
            {#if item.avatar}
              <Avatar name={item.avatar.name} kind={item.avatar.kind ?? "agent"} seed={item.avatar.seed ?? item.id} src={item.avatar.src ?? null} size={20} />
            {:else if item.icon}
              <Icon name={item.icon} size={18} />
            {/if}
            <span class="text">
              <span class="label">{item.label}</span>
              {#if item.detail}<span class="detail">{item.detail}</span>{/if}
            </span>
            {#if item.trailing}<span class="trailing">{item.trailing}</span>{/if}
            {#if selected.has(item.id)}<Icon name="check" size={16} />{/if}
          </button>
        {/each}
      {:else}
        <p class="empty">{emptyText}</p>
      {/each}
    </div>
    {#if footer}<div class="footer">{@render footer({ query, close })}</div>{/if}
  </div>
</Popover>

<style>
  .picker {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 440px;
  }
  .search {
    padding: 2px 2px 4px;
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-height: 0;
    overflow-y: auto;
  }
  .group {
    padding: 8px 10px 4px;
    font: var(--text-caption);
    letter-spacing: var(--tracking-caption);
    color: var(--text-subtle);
  }
  .option {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 32px;
    padding: 6px 10px;
    border: 0;
    border-radius: 12px;
    background: transparent;
    text-align: left;
    font: var(--text-body-sm);
    color: var(--text-standard);
  }
  .option :global(.icon) {
    color: var(--text-subtle);
    flex: none;
  }
  .option.active {
    background: var(--affordance-ghost-hover);
  }
  .option[aria-disabled="true"] {
    opacity: 0.45;
    cursor: default;
  }
  .text {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }
  .label,
  .detail {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .detail {
    font: var(--text-caption);
    color: var(--text-metadata);
  }
  .trailing {
    flex: none;
    max-width: 40%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font: var(--text-mono);
    letter-spacing: var(--tracking-mono);
    color: var(--text-metadata);
  }
  .empty {
    margin: 0;
    padding: 12px 10px;
    font: var(--text-caption);
    color: var(--text-metadata);
  }
  .footer {
    padding-top: 4px;
    border-top: 1px solid var(--border-standard);
  }
</style>
