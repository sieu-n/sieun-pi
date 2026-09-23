<script lang="ts" module>
  export interface SelectOption { value: string; label: string; hint?: string }
  let nextId = 0;
</script>

<script lang="ts">
  import Floating from "./Floating.svelte";
  import Icon from "../Icon.svelte";

  /** A filter chip that opens a listbox. It shows "Label" while at its reset value and "Label: Choice" once set. Long lists get a search box. */
  let { label, options, value, resetValue, onchange, width = 240 }: {
    label: string; options: readonly SelectOption[]; value: string; resetValue: string; onchange: (value: string) => void; width?: number;
  } = $props();

  const id = "select-" + ++nextId;
  let open = $state(false);
  let query = $state("");
  let active = $state(0);
  let trigger: HTMLButtonElement | undefined = $state();
  let list: HTMLElement | undefined = $state();
  let typed = "";
  let typedAt = 0;

  const current = $derived(options.find(option => option.value === value));
  const set = $derived(value !== resetValue);
  const searchable = $derived(options.length > 8);
  const shown = $derived(query.trim() ? options.filter(option => option.label.toLowerCase().includes(query.trim().toLowerCase())) : options);

  function show(): void {
    query = "";
    active = Math.max(0, options.findIndex(option => option.value === value));
    open = true;
  }
  function choose(option: SelectOption | undefined): void {
    if (!option) return;
    open = false;
    if (option.value !== value) onchange(option.value);
  }
  function move(to: number): void {
    if (!shown.length) return;
    active = (to + shown.length) % shown.length;
    requestAnimationFrame(() => list?.querySelector(`#${id}-${active}`)?.scrollIntoView({ block: "nearest" }));
  }
  function onKey(event: KeyboardEvent): void {
    if (event.key === "ArrowDown") { event.preventDefault(); move(active + 1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); move(active - 1); }
    else if (event.key === "Home" && !searchable) { event.preventDefault(); move(0); }
    else if (event.key === "End" && !searchable) { event.preventDefault(); move(shown.length - 1); }
    else if (event.key === "Enter" || (event.key === " " && !searchable)) { event.preventDefault(); choose(shown[active]); }
    else if (event.key === "Tab") { open = false; }
    else if (!searchable && event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
      typed = Date.now() - typedAt > 700 ? event.key.toLowerCase() : typed + event.key.toLowerCase();
      typedAt = Date.now();
      const index = shown.findIndex(option => option.label.toLowerCase().startsWith(typed));
      if (index >= 0) move(index);
    }
  }
  function onTriggerKey(event: KeyboardEvent): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); show(); }
  }
  $effect(() => { void query; active = 0; });
</script>

<button bind:this={trigger} type="button" class="select" class:set aria-haspopup="listbox" aria-expanded={open} aria-label="{label}: {current?.label ?? value}"
  onclick={() => { if (open) open = false; else show(); }} onkeydown={onTriggerKey}>
  <span class="text">{#if set}<span class="key">{label}</span> {current?.label ?? value}{:else}{label}{/if}</span>
  <Icon name="chevronDown" size={12} />
</button>

{#if open && trigger}
  <Floating anchor={trigger} {width} maxHeight={340} role="none" onclose={() => { open = false; }}>
    {#if searchable}
      <input class="field search" data-autofocus bind:value={query} placeholder="Search {label.toLowerCase()}" role="combobox" aria-expanded="true" aria-controls="{id}-list"
        aria-activedescendant={shown[active] ? `${id}-${active}` : undefined} aria-autocomplete="list" onkeydown={onKey} />
    {/if}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div bind:this={list} id="{id}-list" class="list" role="listbox" aria-label={label} tabindex={searchable ? -1 : 0} data-autofocus={searchable ? undefined : true}
      aria-activedescendant={!searchable && shown[active] ? `${id}-${active}` : undefined} onkeydown={searchable ? undefined : onKey}>
      {#each shown as option, index (option.value)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div id="{id}-{index}" class="menu-item" role="option" tabindex="-1" aria-selected={option.value === value} data-active={index === active}
          onpointermove={() => { active = index; }} onclick={() => choose(option)}>
          <span class="check">{#if option.value === value}<Icon name="check" size={13} />{/if}</span>
          <span class="name">{option.label}</span>
          {#if option.hint}<span class="hint">{option.hint}</span>{/if}
        </div>
      {/each}
      {#if !shown.length}<div class="none">No match</div>{/if}
    </div>
  </Floating>
{/if}

<style>
  .select { display: inline-flex; align-items: center; gap: 5px; height: 28px; max-width: 240px; padding: 0 8px 0 10px; border-radius: var(--radius-small); border: 1px solid var(--border-strong);
    background: var(--bg-elevated); font-size: 12.5px; color: var(--text-muted); transition: border-color 0.12s, background-color 0.12s; }
  .select:hover, .select[aria-expanded="true"] { color: var(--text); border-color: color-mix(in srgb, var(--border-strong) 50%, var(--text-faint)); }
  .select.set { background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 35%, transparent); color: var(--accent-bold); }
  .text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .key { color: var(--text-muted); }
  .set .key { color: color-mix(in srgb, var(--accent-bold) 70%, transparent); }
  .search { margin: 2px 0 4px; }
  .list { outline: none; }
  .menu-item { cursor: default; }
  .check { display: inline-flex; width: 14px; flex: none; color: var(--accent-bold); }
  .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .none { padding: 10px; font-size: 12.5px; color: var(--text-faint); }
</style>
