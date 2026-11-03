<script lang="ts">
  import { EMOJI, EMOJI_CATEGORIES, emojiName, emojiOf, searchEmoji, type EmojiInfo } from "$lib/api/shared/emoji";
  import Icon from "$lib/ui/Icon.svelte";
  import type { IconName } from "$lib/ui/icons";
  import { frequentEmoji } from "./frequent-emoji.svelte";

  type Props = {
    /** `keepOpen` is a Shift pick, which Slack uses to add several reactions in one go. */
    onpick: (emoji: string, keepOpen: boolean) => void;
    /** The owner's own reactions on the post, drawn selected. */
    selected?: (emoji: string) => boolean;
  };
  let { onpick, selected = () => false }: Props = $props();

  const COLUMNS = 9;
  const FREQUENT = "Frequently used";
  const ICON: Record<string, IconName> = {
    [FREQUENT]: "clock",
    "Smileys & Emotion": "smile",
    "People & Body": "hand",
    "Animals & Nature": "leaf",
    "Food & Drink": "cup",
    "Travel & Places": "car",
    Activities: "ball",
    Objects: "bulb",
    Symbols: "heart",
    Flags: "flag",
  };
  const uid = `emoji-${Math.random().toString(36).slice(2, 8)}`;

  type Section = { label: string; emoji: EmojiInfo[] };
  type Row = { section: number; cells: EmojiInfo[] };

  let query = $state("");
  let active = $state({ row: 0, col: 0 });
  let current = $state(FREQUENT);
  let grid = $state<HTMLDivElement>();
  let input = $state<HTMLInputElement>();

  const browse: Section[] = $derived([
    { label: FREQUENT, emoji: frequentEmoji.list.flatMap((char) => emojiOf(char) ?? []) },
    ...EMOJI_CATEGORIES.map((label) => ({ label, emoji: EMOJI.filter((e) => e.category === label) })),
  ]);
  const sections: Section[] = $derived(query.trim() ? [{ label: "Search results", emoji: searchEmoji(query) }] : browse);
  const rows: Row[] = $derived(
    sections.flatMap((s, section) => Array.from({ length: Math.ceil(s.emoji.length / COLUMNS) }, (_, i) => ({ section, cells: s.emoji.slice(i * COLUMNS, (i + 1) * COLUMNS) }))),
  );
  const focused = $derived(rows[active.row]?.cells[active.col]);
  const cellId = (row: number, col: number) => `${uid}-${row}-${col}`;

  $effect(() => {
    void query;
    active = { row: 0, col: 0 };
    grid?.scrollTo({ top: 0 });
  });

  function move(row: number, col: number) {
    if (!rows.length) return;
    const r = Math.min(Math.max(row, 0), rows.length - 1);
    active = { row: r, col: Math.min(Math.max(col, 0), rows[r]!.cells.length - 1) };
    document.getElementById(cellId(active.row, active.col))?.scrollIntoView({ block: "nearest" });
  }

  function step(by: number) {
    const { row, col } = active;
    const width = rows[row]?.cells.length ?? 0;
    if (col + by >= 0 && col + by < width) move(row, col + by);
    else if (by > 0 && row + 1 < rows.length) move(row + 1, 0);
    else if (by < 0 && row > 0) move(row - 1, (rows[row - 1]?.cells.length ?? 1) - 1);
  }

  function onkeydown(e: KeyboardEvent) {
    const keys: Record<string, () => void> = {
      ArrowRight: () => step(1),
      ArrowLeft: () => step(-1),
      ArrowDown: () => move(active.row + 1, active.col),
      ArrowUp: () => move(active.row - 1, active.col),
      Enter: () => focused && onpick(focused.char, e.shiftKey),
    };
    const action = keys[e.key];
    if (!action || e.isComposing) return;
    e.preventDefault();
    action();
  }

  function jump(label: string) {
    query = "";
    const index = browse.findIndex((s) => s.label === label);
    const head = grid?.querySelector<HTMLElement>(`[data-section="${index}"]`);
    if (grid && head) grid.scrollTop = head.offsetTop;
    current = label;
    input?.focus();
  }

  function onscroll() {
    if (!grid || query.trim()) return;
    const heads = [...grid.querySelectorAll<HTMLElement>("[data-section]")];
    const top = heads.findLast((h) => h.offsetTop <= grid!.scrollTop + 8) ?? heads[0];
    current = browse[Number(top?.dataset.section ?? 0)]?.label ?? FREQUENT;
  }
</script>

<div class="picker" data-emoji-picker>
  <label class="search">
    <Icon name="search" size={16} />
    <input
      bind:this={input}
      bind:value={query}
      data-autofocus
      type="text"
      placeholder="Search all emoji"
      aria-label="Search emoji"
      role="combobox"
      aria-expanded="true"
      aria-controls="{uid}-grid"
      aria-activedescendant={focused ? cellId(active.row, active.col) : undefined}
      autocomplete="off"
      spellcheck="false"
      {onkeydown}
    />
  </label>
  <div class="tabs" role="tablist" aria-label="Emoji categories">
    {#each browse as section (section.label)}
      <button
        type="button"
        class="tab"
        role="tab"
        tabindex="-1"
        aria-selected={!query.trim() && current === section.label}
        aria-label={section.label}
        title={section.label}
        onpointerdown={(e) => e.preventDefault()}
        onclick={() => jump(section.label)}
      ><Icon name={ICON[section.label] ?? "smile"} size={18} /></button>
    {/each}
  </div>
  <div class="grid" id="{uid}-grid" role="listbox" aria-label="Emoji" bind:this={grid} {onscroll}>
    {#if !rows.length}
      <p class="empty">No emoji match “{query.trim()}”</p>
    {/if}
    {#each rows as row, r (r)}
      {#if r === 0 || rows[r - 1]!.section !== row.section}
        <h3 class="head" data-section={row.section}>{sections[row.section]?.label}</h3>
      {/if}
      <div class="row">
        {#each row.cells as e, c (e.char)}
          <button
            type="button"
            id={cellId(r, c)}
            class="cell"
            class:active={active.row === r && active.col === c}
            class:mine={selected(e.char)}
            role="option"
            tabindex="-1"
            aria-selected={active.row === r && active.col === c}
            aria-label=":{e.names[0]}:"
            data-emoji={e.char}
            onpointerdown={(ev) => ev.preventDefault()}
            onpointermove={() => (active.row !== r || active.col !== c) && (active = { row: r, col: c })}
            onclick={(ev) => onpick(e.char, ev.shiftKey)}
          >{e.char}</button>
        {/each}
      </div>
    {/each}
  </div>
  <div class="footer">
    {#if focused}
      <span class="big">{focused.char}</span>
      <span class="name">:{emojiName(focused.char) ?? focused.names[0]}:</span>
    {/if}
  </div>
</div>

<style>
  .picker {
    display: flex;
    flex-direction: column;
    width: 356px;
    height: 432px;
    max-height: var(--popover-available-height, 432px);
  }
  .search {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 36px;
    margin: 12px 12px 4px;
    padding: 0 10px;
    border-radius: 10px;
    background: var(--surface-inset);
    box-shadow: inset 0 0 0 1px var(--border-standard);
    color: var(--text-subtle);
  }
  .search:focus-within {
    box-shadow: inset 0 0 0 1px var(--border-prominent);
  }
  .search input {
    flex: 1;
    min-width: 0;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--text-standard);
    font: var(--text-body);
  }
  .tabs {
    display: flex;
    justify-content: space-between;
    padding: 0 8px;
    border-bottom: 1px solid var(--border-standard);
  }
  .tab {
    display: grid;
    place-items: center;
    width: 32px;
    height: 34px;
    padding: 0;
    border: 0;
    border-bottom: 2px solid transparent;
    background: transparent;
    color: var(--text-metadata);
    cursor: pointer;
  }
  .tab:hover {
    color: var(--text-standard);
  }
  .tab[aria-selected="true"] {
    border-bottom-color: var(--text-standard);
    color: var(--text-standard);
  }
  .grid {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0 10px 8px;
    overscroll-behavior: contain;
  }
  .head {
    position: sticky;
    top: 0;
    z-index: 1;
    margin: 0;
    padding: 10px 4px 4px;
    background: var(--surface-popover);
    font: var(--text-label-sm);
    font-size: 13px;
    color: var(--text-standard);
  }
  .row {
    display: grid;
    grid-template-columns: repeat(9, 36px);
  }
  .cell {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    padding: 0;
    border: 0;
    border-radius: 8px;
    background: transparent;
    font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif;
    font-size: 24px;
    line-height: 1;
    cursor: pointer;
  }
  .cell.mine {
    background: color-mix(in srgb, var(--accent-9) 24%, transparent);
  }
  .cell.active {
    background: var(--affordance-ghost-hover, var(--surface-inset));
  }
  .cell.mine.active {
    background: color-mix(in srgb, var(--accent-9) 40%, transparent);
  }
  .empty {
    margin: 32px 0;
    text-align: center;
    font: var(--text-body);
    color: var(--text-subtle);
  }
  .footer {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 56px;
    flex: none;
    padding: 0 14px;
    border-top: 1px solid var(--border-standard);
    background: var(--surface-inset);
  }
  .big {
    font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif;
    font-size: 32px;
    line-height: 1;
  }
  .name {
    overflow: hidden;
    font: var(--text-label-sm);
    color: var(--text-standard);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
