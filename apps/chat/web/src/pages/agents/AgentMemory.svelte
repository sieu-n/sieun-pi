<script lang="ts">
  /**
   * An agent's memory: the entries of the harness store in its folder, which every thread of the agent reads as its local store. The owner
   * finds entries by search and sort, adds and edits them in a dialog, and deletes them here; a job's card lists them without editing.
   */
  import { api, type AgentFolder, type HarnessEntryView } from "$lib/api";
  import { Button, Chip, Dialog, EmptyState, Input, SearchField, Select, TextArea, stampLabel, toast } from "$lib/ui";
  import { SvelteSet } from "svelte/reactivity";
  import { MEMORY_SORTS, memoryMatches, shortPath, sortMemories, type MemorySort } from "./agents-model";

  type Props = {
    folder: AgentFolder;
    name: string;
    readonly?: boolean;
    onsaved: (folder: AgentFolder) => void;
  };
  let { folder, name, readonly = false, onsaved }: Props = $props();

  type Form = { title: string; content: string };
  /** The dialog's entry: a new one, or the entry it edits. */
  let editing = $state<{ entry: HarnessEntryView | null; form: Form } | null>(null);
  let dialogOpen = $state(false);
  let confirming = $state<string | null>(null);
  let busy = $state<string | null>(null);
  let error = $state<{ key: string; text: string } | null>(null);
  let query = $state("");
  let sort = $state<MemorySort>("updated");
  const expanded = new SvelteSet<string>();

  const keyOf = (entry: HarnessEntryView) => `${entry.kind}:${entry.id}`;
  const long = (content: string) => content.length > 160 || content.includes("\n");
  const ready = (form: Form) => !!form.title.trim() && !!form.content.trim();
  const total = $derived(folder.memory.entries.length);
  const shown = $derived(sortMemories(folder.memory.entries.filter((entry) => memoryMatches(entry, query)), sort));
  const dialogKey = $derived(editing?.entry ? keyOf(editing.entry) : "new");
  const plural = (n: number) => `${n} ${n === 1 ? "memory" : "memories"}`;

  async function run(key: string, write: () => Promise<AgentFolder>, done: string): Promise<boolean> {
    if (busy) return false;
    busy = key;
    error = null;
    try {
      onsaved(await write());
      toast.success(done);
      return true;
    } catch (reason) {
      error = { key, text: reason instanceof Error ? reason.message : String(reason) };
      return false;
    } finally {
      busy = null;
    }
  }
  async function save() {
    if (!editing || !ready(editing.form)) return;
    const { entry, form } = editing;
    const input = { title: form.title.trim(), content: form.content.trim() };
    const saved = entry
      ? await run(keyOf(entry), () => api.updateMemory(folder.agent, entry.id, { ...input, path: entry.path }, entry.kind), "Saved the memory")
      : await run("new", () => api.addMemory(folder.agent, input), "Added the memory");
    if (saved) close();
  }
  async function remove(entry: HarnessEntryView) {
    if (await run(keyOf(entry), () => api.deleteMemory(folder.agent, entry.id, entry.kind), "Deleted the memory")) confirming = null;
  }
  function open(entry: HarnessEntryView | null) {
    confirming = null;
    error = null;
    editing = { entry, form: entry ? { title: entry.title, content: entry.content } : { title: "", content: "" } };
    dialogOpen = true;
  }
  function close() {
    dialogOpen = false;
    editing = null;
  }
</script>

<section class="memory" aria-label="Memory of {name}" data-testid="agent-memory">
  <div class="head">
    <h3 class="t-caption heading">Memory of {name}{total ? ` · ${plural(total)}` : ""}</h3>
    {#if !readonly && total}<Button size="sm" variant="ghost" icon="plus" onclick={() => open(null)}>Add memory</Button>{/if}
  </div>
  <span class="t-caption meta" data-path={folder.memory.path}>
    Loaded into every thread of {name} from <code class="t-mono" title={folder.memory.path}>{shortPath(folder.memory.path)}</code>
  </span>
  {#if total > 1}
    <div class="tools-row">
      <div class="search"><SearchField bind:value={query} placeholder="Search {plural(total)}" label="Search memories" data-testid="memory-search" /></div>
      <Select label="Sort memories" size="sm" bind:value={sort} options={MEMORY_SORTS} />
    </div>
    {#if query.trim()}<span class="t-caption meta" role="status" data-testid="memory-count">{shown.length} of {plural(total)} match</span>{/if}
  {/if}
  {#if !total}
    <EmptyState icon="bulb" title="No memories yet" description="What you add here, every thread of {name} reads." size="sm">
      {#snippet action()}{#if !readonly}<Button size="sm" variant="primary" icon="plus" onclick={() => open(null)}>Add memory</Button>{/if}{/snippet}
    </EmptyState>
  {:else if !shown.length}
    <EmptyState icon="search" title="No memory matches “{query.trim()}”" description="Search reads each title, its text and who wrote it." size="sm">
      {#snippet action()}<Button size="sm" onclick={() => (query = "")}>Clear search</Button>{/snippet}
    </EmptyState>
  {/if}
  <ul class="entries">
    {#each shown as entry (keyOf(entry))}
      {@const key = keyOf(entry)}
      <li class="entry" data-entry-id={entry.id} data-kind={entry.kind}>
        <div class="entry-head">
          <span class="t-label-sm title">{entry.title}</span>
          {#if entry.kind !== "memory"}<Chip size="sm" label={entry.kind} />{/if}
          {#if !readonly}
            <span class="tools">
              <button type="button" class="link t-caption" aria-label="Edit {entry.title}" onclick={() => open(entry)}>Edit</button>
              <button type="button" class="link t-caption" aria-label="Delete {entry.title}" onclick={() => ((confirming = key), (error = null))}>Delete</button>
            </span>
          {/if}
        </div>
        <p class="t-body-sm content" class:folded={!expanded.has(key)}>{entry.content}</p>
        {#if long(entry.content)}
          <button type="button" class="link t-caption" aria-expanded={expanded.has(key)} onclick={() => (expanded.has(key) ? expanded.delete(key) : expanded.add(key))}>
            {expanded.has(key) ? "Show less" : "Show all"}
          </button>
        {/if}
        <span class="t-caption meta">From {entry.source || "unknown"} · updated {stampLabel(Date.parse(entry.updatedAt))}</span>
        {#if confirming === key}
          <div class="confirm" role="group" aria-label="Confirm delete">
            <span class="t-caption">Delete this memory from every thread of {name}?</span>
            <Button size="sm" variant="ghost" onclick={() => (confirming = null)} disabled={busy === key}>Cancel</Button>
            <Button size="sm" variant="danger" onclick={() => remove(entry)} loading={busy === key} disabled={!!busy}>Delete</Button>
          </div>
        {/if}
        {#if error?.key === key && editing?.entry?.id !== entry.id}<p class="t-caption warn" role="alert">{error.text}</p>{/if}
      </li>
    {/each}
  </ul>
</section>

{#if editing}
  <Dialog bind:open={dialogOpen} title={editing.entry ? "Edit memory" : "Add memory"} width={560} dirty initialFocus={editing.entry ? "textarea" : "input"} onclose={() => (editing = null)}>
    <form id="memory-form" class="form" data-testid="memory-form" onsubmit={(e) => (e.preventDefault(), void save())}>
      <Input size="sm" bind:value={editing.form.title} placeholder="Title" aria-label="Memory title" disabled={busy === dialogKey} />
      <TextArea bind:value={editing.form.content} rows={4} maxRows={16} placeholder="What {name} should remember" aria-label="Memory content" disabled={busy === dialogKey} />
      {#if error?.key === dialogKey}<p class="t-caption warn" role="alert">{error.text}</p>{/if}
    </form>
    {#snippet actions()}
      <Button variant="ghost" onclick={close} disabled={busy === dialogKey}>Cancel</Button>
      <Button variant="primary" type="submit" form="memory-form" loading={busy === dialogKey} disabled={!!busy || !editing || !ready(editing.form)}>{editing?.entry ? "Save" : "Add"}</Button>
    {/snippet}
  </Dialog>
{/if}

<style>
  .memory {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .head,
  .tools-row,
  .entry-head,
  .confirm {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .head {
    justify-content: space-between;
    min-height: 28px;
  }
  .heading {
    margin: 0;
    color: var(--text-metadata);
  }
  .meta {
    margin: 0;
    color: var(--text-metadata);
    overflow-wrap: anywhere;
  }
  .warn {
    margin: 0;
    color: var(--text-danger);
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .entries {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .entry {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-1);
    padding: var(--space-3);
    border-radius: var(--radius-row);
    background: var(--surface-inset);
  }
  .search {
    flex: 1;
    min-width: 0;
  }
  .entry-head {
    align-self: stretch;
    min-width: 0;
  }
  .title {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
    color: var(--text-standard);
  }
  .tools {
    display: flex;
    gap: var(--space-2);
  }
  .content {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--text-subtle);
  }
  .folded {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
  }
  .confirm {
    flex-wrap: wrap;
    padding-top: var(--space-1);
  }
  .link {
    padding: 0;
    border: 0;
    background: none;
    color: var(--text-subtle);
    text-decoration: underline;
    cursor: pointer;
  }
</style>
