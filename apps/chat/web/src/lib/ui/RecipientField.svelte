<script lang="ts">
  import Avatar from "./Avatar.svelte";
  import Chip from "./Chip.svelte";
  import Input from "./Input.svelte";
  import Picker from "./Picker.svelte";
  import { composing } from "./keyboard";
  import type { PickerItem } from "./types";

  /**
   * Slack's To: field: picked items show as chips before the caret, typing filters a list under the field, Enter or a click adds the
   * highlighted row, Backspace in an empty field drops the last chip, and the list opens by itself while nothing is picked. Rows that share
   * a `group` sit under its heading only while the field is empty, because the list's filter also matches a group's name.
   * `onsubmit` runs on Enter in an empty field once something is picked.
   */
  type Props = {
    id: string;
    items: PickerItem[];
    value: string[];
    label?: string;
    /** One pick only: a second pick replaces the first. */
    single?: boolean;
    placeholder?: string;
    listLabel?: string;
    emptyText?: string;
    onsubmit?: () => void;
    input?: HTMLInputElement | undefined;
  };
  let {
    id,
    items,
    value = $bindable(),
    label = "To:",
    single = false,
    placeholder = "Type a name",
    listLabel = "Suggestions",
    emptyText = "No matches",
    onsubmit,
    input = $bindable(),
  }: Props = $props();

  let query = $state("");
  let open = $state(false);
  let field = $state<HTMLElement>();
  let width = $state(0);

  const chosen = $derived(value.map((v) => items.find((item) => item.id === v)).filter((item): item is PickerItem => !!item));
  const available = $derived((query.trim() ? items.map(({ group: _group, ...item }) => item) : items).filter((item) => !value.includes(item.id)));

  function add(pick: string) {
    value = single ? [pick] : value.includes(pick) ? value : [...value, pick];
    query = "";
    open = false;
    input?.focus();
  }
  function remove(drop: string) {
    value = value.filter((v) => v !== drop);
    input?.focus();
  }
  function onkeydown(e: KeyboardEvent) {
    if (e.defaultPrevented || composing(e)) return;
    if (e.key === "Backspace" && !query && value.length) {
      e.preventDefault();
      value = value.slice(0, -1);
    } else if (e.key === "ArrowDown" && !open) {
      e.preventDefault();
      open = true;
    } else if (e.key === "Enter" && !query && value.length && onsubmit) {
      e.preventDefault();
      onsubmit();
    }
  }
</script>

<div class="recipients" bind:this={field} bind:clientWidth={width} data-testid="{id}-field">
  <Input
    {id}
    class="recipient-input"
    bind:element={input}
    bind:value={query}
    placeholder={value.length ? "" : placeholder}
    autocomplete="off"
    role="combobox"
    aria-expanded={open}
    aria-autocomplete="list"
    onfocus={() => (open = !value.length || !!query)}
    oninput={() => (open = true)}
    {onkeydown}
  >
    {#snippet prefix()}
      <label for={id} class="t-label-sm">{label}</label>
      {#each chosen as item (item.id)}
        {#if item.avatar}
          {@const avatar = item.avatar}
          <Chip label={item.label} size="sm" removeLabel="Remove {item.label}" onremove={() => remove(item.id)}>
            {#snippet leading()}<Avatar name={avatar.name} kind={avatar.kind ?? "agent"} seed={avatar.seed ?? item.id} size={16} />{/snippet}
          </Chip>
        {:else}
          <Chip label={item.label} size="sm" icon={item.icon} removeLabel="Remove {item.label}" onremove={() => remove(item.id)} />
        {/if}
      {/each}
    {/snippet}
  </Input>
</div>
{#if input}
  <Picker bind:open anchor={field} items={available} width={Math.max(width, 280)} label={listLabel} {emptyText} typeahead={{ query, keys: input }} onselect={(pick) => add(pick)} />
{/if}

<style>
  .recipients :global(.input.recipient-input) {
    flex-wrap: wrap;
    gap: 6px;
    height: auto;
    min-height: 40px;
    padding: 4px 12px;
  }
  .recipients :global(.input.recipient-input input) {
    min-width: 8rem;
    height: 30px;
  }
  .recipients label {
    color: var(--text-subtle);
  }
</style>
