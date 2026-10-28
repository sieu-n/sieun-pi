<script lang="ts">
  import type { ProjectList } from "$lib/api";
  import { Input, Select } from "$lib/ui";
  import { shortPath } from "./agents-model";

  type Props = {
    projects: ProjectList | null;
    /** The chosen folder; "" until the list loads. */
    value: string;
    disabled?: boolean;
    id?: string;
    onchange?: (value: string) => void;
  };
  let { projects, value = $bindable(""), disabled = false, id = "project-folder", onchange }: Props = $props();

  const OTHER = "__other";
  const known = $derived(projects?.projects ?? []);
  let other = $state(false);
  $effect(() => {
    if (value && !known.some((p) => p.path === value)) other = true;
  });
  const options = $derived([
    ...known.map((p) => ({ value: p.path, label: `${p.name} · ${shortPath(p.path)}` })),
    { value: OTHER, label: "Other folder…" },
  ]);
  const selected = $derived(other ? OTHER : value || OTHER);

  function pick(next: string) {
    if (next === OTHER) {
      other = true;
      value = "";
    } else {
      other = false;
      value = next;
    }
    onchange?.(value);
  }
</script>

<div class="picker" data-testid="project-picker">
  <Select label="Project folder" {id} value={selected} {options} {disabled} onchange={pick} />
  {#if other}
    <Input
      size="sm"
      placeholder="/absolute/path/to/checkout"
      aria-label="Project folder path"
      bind:value
      {disabled}
      autocomplete="off"
      spellcheck="false"
      oninput={() => onchange?.(value)}
    />
  {/if}
</div>

<style>
  .picker {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: var(--space-2);
    min-width: 0;
    max-width: 100%;
  }
  .picker :global(.select),
  .picker :global(.control) {
    max-width: 100%;
    min-width: 0;
  }
  .picker :global(select) {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .picker :global(.input) {
    width: 280px;
    max-width: 100%;
  }
</style>
