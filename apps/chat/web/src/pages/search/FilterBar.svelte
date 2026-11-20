<script lang="ts">
  import type { Snippet } from "svelte";
  import { agents, conversations, me } from "$lib/api";
  import Avatar from "$lib/ui/Avatar.svelte";
  import Button from "$lib/ui/Button.svelte";
  import Chip from "$lib/ui/Chip.svelte";
  import Field from "$lib/ui/Field.svelte";
  import Input from "$lib/ui/Input.svelte";
  import Menu from "$lib/ui/Menu.svelte";
  import Picker from "$lib/ui/Picker.svelte";
  import Popover from "$lib/ui/Popover.svelte";
  import type { MenuEntry } from "$lib/ui/menu";
  import type { PickerItem } from "$lib/ui/types";
  import { dateLabel, dateRanges, toggleFrom, toggleWhere, WHERES, type Filters } from "./filters";

  /**
   * The search filter chips, From, In, Where and Date, under the Cmd K field and on the full results page, so both filter the same way.
   * The row is one toolbar stop: Tab enters it, arrows move between chips, Enter or Space opens a chip's dropdown, and Esc closes the
   * dropdown and leaves the dialog open (the dropdown's Popover takes the key first).
   */
  type Props = { filters: Filters; onchange: (next: Filters) => void; now: Date; trailing?: Snippet };
  let { filters, onchange, now, trailing }: Props = $props();

  type Open = "from" | "in" | "where" | "date" | "range" | undefined;
  let open = $state<Open>();
  let fromChip = $state<HTMLSpanElement>();
  let inChip = $state<HTMLSpanElement>();
  let whereChip = $state<HTMLSpanElement>();
  let dateChip = $state<HTMLSpanElement>();
  const toggle = (name: Exclude<Open, undefined>) => (open = open === name ? undefined : name);
  const set = (name: Exclude<Open, undefined>, on: boolean) => {
    if (on) open = name;
    else if (open === name) open = undefined;
  };

  const owner = $derived(me.value?.owner);
  type Who = { id: string; name: string; kind: "person" | "agent" | "group" };
  function who(id: string): Who {
    if (id === "owner") return { id, name: owner?.name ?? "You", kind: "person" };
    if (id === "agents") return { id, name: "Any agent", kind: "group" };
    return { id, name: agents.byId(id)?.name ?? id, kind: "agent" };
  }
  const picked = $derived(filters.from.map(who));
  /** "From: You, agent factory" names up to two picks, as Slack's chip does, and "+2" counts the rest; the chip ellipsizes a long pair. */
  const fromLabel = $derived(
    picked.length ? `From: ${picked.slice(0, 2).map(one => one.name).join(", ")}${picked.length > 2 ? ` +${picked.length - 2}` : ""}` : "From",
  );
  const fromItems = $derived<PickerItem[]>([
    { id: "owner", label: owner?.name ?? "You", detail: owner && owner.name !== "You" ? "You" : undefined, avatar: { name: owner?.name ?? "You", kind: "person", seed: "owner" }, keywords: ["me", "owner"] },
    { id: "agents", label: "Any agent", detail: "Everyone but you", icon: "robot" },
    ...agents.list
      .filter(agent => !agent.archived)
      .map(agent => ({ id: agent.id, label: agent.name, group: "Agents", avatar: { name: agent.name, kind: "agent" as const, seed: agent.id } })),
  ]);

  const inConversation = $derived(filters.in ? conversations.byId(filters.in) : undefined);
  const inName = $derived(inConversation ? (inConversation.kind === "channel" ? `#${inConversation.name.replace(/^#/, "")}` : inConversation.name) : filters.in);
  const inItems = $derived<PickerItem[]>([
    { id: "", label: "Anywhere", icon: "search" },
    ...[...conversations.list]
      .filter(c => !c.archived)
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .map(c => ({
        id: c.id,
        label: c.kind === "channel" ? `#${c.name.replace(/^#/, "")}` : c.name,
        group: c.kind === "channel" ? "Channels" : c.kind === "job" ? "Jobs" : "Conversations",
        icon: c.kind === "channel" ? "hash" : c.kind === "job" ? "robot" : "chat",
      })),
  ]);

  const whereLabel = $derived(filters.where.length ? WHERES.filter(w => filters.where.includes(w.id)).map(w => w.label).join(", ") : "Where");
  const whereItems = $derived<MenuEntry[]>(
    WHERES.map(w => ({ type: "checkbox" as const, id: w.id, label: w.label, detail: w.detail, checked: filters.where.includes(w.id), onselect: () => onchange(toggleWhere(filters, w.id)) })),
  );

  const ranges = $derived(dateRanges(now));
  const dateText = $derived(dateLabel(filters, now));
  const custom = $derived(!!dateText && !ranges.some(r => r.id !== "any" && r.after === filters.after && r.before === filters.before));
  const dateItems = $derived<MenuEntry[]>([
    ...ranges.map(range => ({
      type: "radio" as const, id: range.id, group: "date", label: range.label,
      checked: range.id === "any" ? !dateText : range.after === filters.after && range.before === filters.before,
      onselect: () => onchange({ ...filters, after: range.after, before: range.before }),
    })),
    { type: "separator" },
    { type: "radio", id: "custom", group: "date", label: "Custom range…", checked: custom, keepOpen: true, onselect: openRange },
  ]);

  let rangeAfter = $state("");
  let rangeBefore = $state("");
  const rangeBad = $derived(!!rangeAfter && !!rangeBefore && rangeBefore <= rangeAfter);
  function openRange() {
    rangeAfter = filters.after ?? "";
    rangeBefore = filters.before ?? "";
    // The range form gives focus back to what held it when it opened, so that is the Date chip and not the menu row about to go.
    dateChip?.querySelector("button")?.focus();
    open = "range";
  }
  function applyRange(e: SubmitEvent) {
    e.preventDefault();
    if (rangeBad) return;
    onchange({ ...filters, after: rangeAfter || undefined, before: rangeBefore || undefined });
    open = undefined;
  }

  // One tab stop for the row, as a toolbar: the last focused button keeps tabindex 0 and the arrows move between buttons.
  let bar = $state<HTMLDivElement>();
  const buttons = () => (bar ? [...bar.querySelectorAll<HTMLButtonElement>(":scope > .chips button")] : []);
  $effect(() => {
    void filters;
    void trailing;
    const list = buttons();
    if (!list.length) return;
    const current = list.find(b => b.tabIndex === 0) ?? list[0]!;
    for (const b of list) b.tabIndex = b === current ? 0 : -1;
  });
  function onfocusin(e: FocusEvent) {
    const list = buttons();
    if (!list.includes(e.target as HTMLButtonElement)) return;
    for (const b of list) b.tabIndex = b === e.target ? 0 : -1;
  }
  function onkeydown(e: KeyboardEvent) {
    const list = buttons();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    const next = step ? list[(at + step + list.length) % list.length] : e.key === "Home" ? list[0] : e.key === "End" ? list.at(-1) : undefined;
    if (!next) return;
    e.preventDefault();
    next.focus();
  }
</script>

<div class="bar" role="toolbar" tabindex="-1" aria-label="Search filters" aria-orientation="horizontal" data-search-filters bind:this={bar} {onfocusin} {onkeydown}>
  <div class="chips">
    <Chip
      bind:element={fromChip}
      selected={!!picked.length}
      popup={{ kind: "dialog", open: open === "from" }}
      onclick={() => toggle("from")}
      onremove={picked.length ? () => onchange({ ...filters, from: [] }) : undefined}
      removeLabel="Remove the From filter"
    >
      {#if picked.length}
        <span class="faces" aria-hidden="true">
          {#each picked.slice(0, 3) as one (one.id)}
            <Avatar name={one.name} kind={one.kind === "person" ? "person" : "agent"} seed={one.id} size={16} ring />
          {/each}
        </span>
      {/if}
      <span class="value" data-chip="from">{fromLabel}</span>
    </Chip>
    <Chip
      bind:element={inChip}
      selected={!!filters.in}
      popup={{ kind: "dialog", open: open === "in" }}
      onclick={() => toggle("in")}
      onremove={filters.in ? () => onchange({ ...filters, in: undefined }) : undefined}
      removeLabel="Remove the In filter"
    >
      <span class="value" data-chip="in">{filters.in ? `In: ${inName}` : "In"}</span>
    </Chip>
    <Chip
      bind:element={whereChip}
      selected={!!filters.where.length}
      popup={{ kind: "menu", open: open === "where" }}
      onclick={() => toggle("where")}
      onremove={filters.where.length ? () => onchange({ ...filters, where: [] }) : undefined}
      removeLabel="Remove the Where filter"
    >
      <span class="value" data-chip="where">{whereLabel}</span>
    </Chip>
    <Chip
      bind:element={dateChip}
      selected={!!dateText}
      popup={{ kind: "menu", open: open === "date" || open === "range" }}
      onclick={() => toggle("date")}
      onremove={dateText ? () => onchange({ ...filters, after: undefined, before: undefined }) : undefined}
      removeLabel="Remove the Date filter"
    >
      <span class="value" data-chip="date">{dateText ?? "Date"}</span>
    </Chip>
  </div>
  {#if trailing}<div class="trailing">{@render trailing()}</div>{/if}
</div>

<Picker
  bind:open={() => open === "from", on => set("from", on)}
  anchor={fromChip}
  items={fromItems}
  value={[...filters.from]}
  multiple
  searchable
  label="From"
  placeholder="Find a person or agent"
  onselect={id => onchange(toggleFrom(filters, id))}
/>
<Picker
  bind:open={() => open === "in", on => set("in", on)}
  anchor={inChip}
  items={inItems}
  value={filters.in ?? ""}
  searchable
  label="In"
  placeholder="Find a conversation"
  onselect={id => onchange({ ...filters, in: id || undefined })}
/>
<Menu bind:open={() => open === "where", on => set("where", on)} anchor={whereChip} items={whereItems} label="Where" />
<Menu bind:open={() => open === "date", on => set("date", on)} anchor={dateChip} items={dateItems} label="Date" />
<Popover bind:open={() => open === "range", on => set("range", on)} anchor={dateChip} surface="solid" width={280} padding={12} label="Custom date range">
  <form class="range" onsubmit={applyRange}>
    <Field label="On or after" id="search-range-after"><Input id="search-range-after" type="date" size="sm" bind:value={rangeAfter} max={rangeBefore || undefined} data-autofocus /></Field>
    <Field label="Before" id="search-range-before" error={rangeBad ? "Pick a day after the first one." : null}>
      <Input id="search-range-before" type="date" size="sm" bind:value={rangeBefore} min={rangeAfter || undefined} invalid={rangeBad} />
    </Field>
    <div class="range-actions">
      <Button variant="ghost" size="sm" onclick={() => (open = "date")}>Back</Button>
      <Button variant="primary" size="sm" type="submit" disabled={rangeBad || (!rangeAfter && !rangeBefore)}>Apply</Button>
    </div>
  </form>
</Popover>

<style>
  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .chips {
    display: flex;
    flex: 1;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .value {
    max-width: 16rem;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .faces {
    display: inline-flex;
  }
  .faces > :global(*:not(:first-child)) {
    margin-left: -5px;
  }
  .trailing {
    display: flex;
    flex: none;
    align-items: center;
  }
  .range {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .range-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }
</style>
