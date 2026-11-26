<script lang="ts">
  /**
   * An agent's memory: the entries of the harness store in its folder, which every thread of the agent reads as its local store. The owner
   * finds entries by search and sort, adds and edits them in a dialog, and deletes them here; a job's card lists them without editing.
   */
  import { api, type AgentFolder, type HarnessEntryView } from "$lib/api";
  import { Button, Chip, Dialog, EmptyState, Input, SearchField, Select, ShowAllList, TextArea, stampLabel, toast } from "$lib/ui";
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
  /** Every entry of the store; the folder carries only the newest memory page (server agent-folder.ts MEMORY_PAGE). */
  const total = $derived(folder.memory.count ?? folder.memory.entries.length);
  const memoryCount = $derived(folder.memory.memoryCount ?? folder.memory.entries.filter((entry) => entry.kind === "memory").length);
  /** Older memory pages read by Show older, kept while the folder they continue stays the one shown. */
  // Raw, so `older.folder` stays the very folder object the prop holds and `older.folder === folder` compares them.
  let older = $state.raw<{ folder: AgentFolder | null; entries: HarnessEntryView[] }>({ folder: null, entries: [] });
  let loadingOlder = $state(false);
  const listed = $derived.by(() => {
    const seen = new Set(folder.memory.entries.map(keyOf));
    return [...folder.memory.entries, ...(older.folder === folder ? older.entries.filter((entry) => !seen.has(keyOf(entry))) : [])];
  });
  const loadedMemory = $derived(listed.filter((entry) => entry.kind === "memory").length);
  /** A search runs on the server over the whole store, best match first (GET /api/agents/:id/memory?q=). */
  let found = $state<{ q: string; entries: HarnessEntryView[] } | null>(null);
  const searching = $derived(query.trim() !== "");
  /**
   * The rows, of which ShowAllList draws 10 and the rest on Show all. Drawing all of agent factory's 479 entries took 3 to 5.5 s from the
   * tab's click to its first row in WebKit at box load 130 to 200 on 11-22 (~/work/p155-config).
   */
  const shown = $derived(
    searching
      ? [
          ...listed.filter((entry) => entry.kind !== "memory" && memoryMatches(entry, query)),
          ...(found?.q === query.trim() ? found.entries : listed.filter((entry) => entry.kind === "memory" && memoryMatches(entry, query))),
        ]
      : sortMemories(listed, sort),
  );
  $effect(() => {
    const q = query.trim();
    // A save gives a new folder, which runs the search again so an edited or deleted entry shows as it is now.
    const agent = folder.agent;
    void folder.memory;
    if (!q) {
      found = null;
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const page = await api.memoryPage(agent, { q, limit: 50 });
        if (query.trim() === q) found = { q, entries: page.entries };
      } catch (reason) {
        error = { key: "search", text: reason instanceof Error ? reason.message : String(reason) };
      }
    }, 200);
    return () => clearTimeout(timer);
  });
  async function showOlder() {
    if (loadingOlder) return;
    loadingOlder = true;
    try {
      const page = await api.memoryPage(folder.agent, { offset: loadedMemory, limit: 50 });
      older = { folder, entries: [...(older.folder === folder ? older.entries : []), ...page.entries] };
    } catch (reason) {
      error = { key: "older", text: reason instanceof Error ? reason.message : String(reason) };
    } finally {
      loadingOlder = false;
    }
  }
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
    <h3 class="t-caption heading">Memory{total ? ` · ${total}` : ""}</h3>
    {#if !readonly && total}<Button size="sm" variant="ghost" icon="plus" onclick={() => open(null)}>Add memory</Button>{/if}
  </div>
  <span class="t-caption meta" data-path={folder.memory.path}>
    Each turn of every thread of {name} gets the 40 entries that best match it, from <code class="t-mono" title={folder.memory.path}>{shortPath(folder.memory.path)}</code>
  </span>
  {#if total > 1}
    <div class="tools-row">
      <div class="search"><SearchField bind:value={query} placeholder="Search {plural(total)}" label="Search memories" data-testid="memory-search" /></div>
      <Select label="Sort memories" size="sm" bind:value={sort} options={MEMORY_SORTS} disabled={searching} />
    </div>
    {#if searching}<span class="t-caption meta" role="status" data-testid="memory-count">{shown.length === 1 ? `The best match in ${plural(total)}` : shown.length ? `The ${shown.length} best matches in ${plural(total)}` : `No match in ${plural(total)}`}</span>{/if}
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
  <ShowAllList items={shown} key={keyOf} noun="memories" label="Memories">
    {#snippet row(entry)}
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
            {expanded.has(key) ? "Show less" : "Show more"}
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
    {/snippet}
  </ShowAllList>
  {#if !searching && loadedMemory < memoryCount}
    <div class="older">
      <span class="t-caption meta">Showing the newest {loadedMemory} of {plural(memoryCount)}. Search reads all of them.</span>
      <Button size="sm" variant="ghost" onclick={showOlder} loading={loadingOlder} data-testid="memory-older">Show older</Button>
    </div>
  {/if}
  {#if error && (error.key === "search" || error.key === "older")}<p class="t-caption warn" role="alert">{error.text}</p>{/if}
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
  .older {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
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
