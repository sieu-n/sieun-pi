<script lang="ts">
  import Icon from "./Icon.svelte";
  import Menu from "./Menu.svelte";
  import Popover from "./Popover.svelte";
  import type { Anchor, Placement } from "./floating";
  import { isPickable, type MenuEntry, type Pickable } from "./menu";

  type Props = {
    open: boolean;
    /** An element, or a point for a context menu: `{ x: e.clientX, y: e.clientY }`. */
    anchor: Anchor | null | undefined;
    items: MenuEntry[];
    placement?: Placement;
    width?: number | "anchor" | "auto";
    label?: string;
    onclose?: () => void;
    /** Set by a parent menu so arrow left closes this submenu. */
    nested?: boolean;
    /** Set by a parent menu so a pick inside this submenu closes the whole menu. */
    onpick?: () => void;
  };
  let { open = $bindable(), anchor, items, placement = "bottom-start", width = "auto", label, onclose, nested = false, onpick }: Props = $props();

  let element = $state<HTMLDivElement>();
  let subOpen = $state<string | null>(null);
  let subAnchor = $state<HTMLElement | null>(null);

  function close() {
    open = false;
    subOpen = null;
    onclose?.();
  }

  function pick(entry: Pickable, el: HTMLElement) {
    if (entry.type === "submenu") {
      subAnchor = el;
      subOpen = entry.id;
      return;
    }
    if (entry.type === "checkbox") {
      entry.onselect?.(!entry.checked);
      if (entry.keepOpen === false) done();
      return;
    }
    entry.onselect?.();
    if (!entry.keepOpen) done();
  }

  function done() {
    close();
    onpick?.();
  }

  function rows(): HTMLElement[] {
    return element ? [...element.querySelectorAll<HTMLElement>(":scope > .menu > [data-menu-row]:not([aria-disabled=true])")] : [];
  }

  function onKeydown(e: KeyboardEvent) {
    const list = rows();
    const at = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = list[(at + (e.key === "ArrowDown" ? 1 : list.length - 1) + (at === -1 && e.key === "ArrowUp" ? 1 : 0)) % list.length];
      next?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      (e.key === "Home" ? list[0] : list[list.length - 1])?.focus();
    } else if (e.key === "ArrowRight") {
      const el = list[at];
      if (el?.dataset.submenu) {
        e.preventDefault();
        el.click();
      }
    } else if (e.key === "ArrowLeft" && nested) {
      e.preventDefault();
      close();
    } else if (e.key.length === 1 && /\S/.test(e.key)) {
      const ch = e.key.toLowerCase();
      const from = list.slice(at + 1).concat(list.slice(0, at + 1));
      from.find((el) => el.textContent?.trim().toLowerCase().startsWith(ch))?.focus();
    }
  }

  function roleOf(entry: Pickable): string {
    return entry.type === "radio" ? "menuitemradio" : entry.type === "checkbox" ? "menuitemcheckbox" : "menuitem";
  }
</script>

<Popover bind:open bind:element {anchor} {placement} {width} role="menu" {label} onclose={close} padding={6}>
  <div class="menu" role="none" onkeydown={onKeydown}>
    {#each items as entry, i (i)}
      {#if entry.type === "separator"}
        <div class="sep" role="separator"></div>
      {:else if entry.type === "label"}
        <div class="group-label" role="presentation">{entry.label}</div>
      {:else}
        {@const checked = entry.type === "radio" || entry.type === "checkbox" ? entry.checked : undefined}
        <button
          type="button"
          class="row"
          class:danger={entry.type !== "submenu" && entry.type !== "radio" && entry.type !== "checkbox" && entry.tone === "danger"}
          data-menu-row
          data-submenu={entry.type === "submenu" ? "" : undefined}
          role={roleOf(entry)}
          aria-checked={checked}
          aria-haspopup={entry.type === "submenu" ? "menu" : undefined}
          aria-expanded={entry.type === "submenu" ? subOpen === entry.id : undefined}
          aria-disabled={entry.disabled || undefined}
          tabindex="-1"
          onclick={(e) => isPickable(entry) && pick(entry, e.currentTarget)}
          onpointerenter={(e) => {
            if (entry.type === "submenu" && !entry.disabled) {
              subAnchor = e.currentTarget;
              subOpen = entry.id;
            } else if (subOpen) subOpen = null;
          }}
        >
          {#if entry.type === "radio"}
            <span class="mark">{#if entry.checked}<span class="radio-dot"></span>{/if}</span>
          {:else if entry.type === "checkbox"}
            <span class="mark box" class:on={entry.checked}>{#if entry.checked}<Icon name="check" size={14} />{/if}</span>
          {:else if entry.icon}
            <Icon name={entry.icon} size={18} />
          {/if}
          <span class="text">
            <span class="label">{entry.label}</span>
            {#if entry.detail}<span class="detail">{entry.detail}</span>{/if}
          </span>
          {#if entry.type === "submenu"}
            <Icon name="chevron-right" size={16} />
          {:else if entry.type !== "radio" && entry.type !== "checkbox" && entry.shortcut}
            <kbd>{entry.shortcut}</kbd>
          {/if}
        </button>
        {#if entry.type === "submenu" && subOpen === entry.id}
          <Menu open={true} anchor={subAnchor} items={entry.items} placement="right-start" nested onclose={() => (subOpen = null)} onpick={done} />
        {/if}
      {/if}
    {/each}
  </div>
</Popover>

<style>
  .menu {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 200px;
  }
  .row {
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
    letter-spacing: var(--tracking-body-sm);
    color: var(--text-standard);
  }
  .row :global(.icon) {
    color: var(--text-subtle);
  }
  .row:hover,
  .row:focus-visible,
  .row:focus,
  .row[aria-expanded="true"] {
    background: var(--affordance-ghost-hover);
  }
  .row[aria-disabled="true"] {
    opacity: 0.45;
    cursor: default;
  }
  .danger,
  .danger :global(.icon) {
    color: var(--border-danger);
  }
  .text {
    display: flex;
    flex: 1;
    min-width: 0;
    flex-direction: column;
  }
  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .detail {
    font: var(--text-caption);
    color: var(--text-metadata);
  }
  kbd {
    font: var(--text-caption);
    color: var(--text-metadata);
  }
  .mark {
    display: inline-grid;
    place-items: center;
    width: 18px;
    height: 18px;
    flex: none;
  }
  .radio-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-standard);
  }
  .box {
    width: 16px;
    height: 16px;
    margin: 1px;
    border-radius: 5px;
    box-shadow: inset 0 0 0 1.5px var(--border-prominent);
  }
  .box.on {
    background: var(--affordance-prominent);
    color: var(--text-on-prominent);
    box-shadow: none;
  }
  .box.on :global(.icon) {
    color: var(--text-on-prominent);
  }
  .sep {
    height: 1px;
    margin: 4px 6px;
    background: var(--border-standard);
  }
  .group-label {
    padding: 8px 10px 4px;
    font: var(--text-caption);
    letter-spacing: var(--tracking-caption);
    color: var(--text-subtle);
  }
</style>
