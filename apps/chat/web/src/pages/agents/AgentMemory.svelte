<script lang="ts">
  /**
   * An agent's memory: the entries of the harness store in its folder, which every thread of the agent reads as its local store. The owner
   * adds, edits and deletes entries here; a job's card lists them without editing.
   */
  import { api, type AgentFolder, type HarnessEntryView } from "$lib/api";
  import { Button, Chip, Input, TextArea, stampLabel, toast } from "$lib/ui";
  import { SvelteSet } from "svelte/reactivity";
  import { shortPath } from "./agents-model";

  type Props = {
    folder: AgentFolder;
    name: string;
    readonly?: boolean;
    onsaved: (folder: AgentFolder) => void;
  };
  let { folder, name, readonly = false, onsaved }: Props = $props();

  type Form = { title: string; content: string };
  let adding = $state<Form | null>(null);
  let editing = $state<{ key: string; form: Form } | null>(null);
  let confirming = $state<string | null>(null);
  let busy = $state<string | null>(null);
  let error = $state<{ key: string; text: string } | null>(null);
  const expanded = new SvelteSet<string>();

  const keyOf = (entry: HarnessEntryView) => `${entry.kind}:${entry.id}`;
  const long = (content: string) => content.length > 160 || content.includes("\n");
  const ready = (form: Form) => !!form.title.trim() && !!form.content.trim();

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
  async function add() {
    if (!adding || !ready(adding)) return;
    const input = { title: adding.title.trim(), content: adding.content.trim() };
    if (await run("new", () => api.addMemory(folder.agent, input), "Added the memory")) adding = null;
  }
  async function update(entry: HarnessEntryView) {
    if (!editing || !ready(editing.form)) return;
    const input = { title: editing.form.title.trim(), content: editing.form.content.trim(), path: entry.path };
    if (await run(keyOf(entry), () => api.updateMemory(folder.agent, entry.id, input, entry.kind), "Saved the memory")) editing = null;
  }
  async function remove(entry: HarnessEntryView) {
    if (await run(keyOf(entry), () => api.deleteMemory(folder.agent, entry.id, entry.kind), "Deleted the memory")) confirming = null;
  }
  function startEdit(entry: HarnessEntryView) {
    confirming = null;
    error = null;
    editing = { key: keyOf(entry), form: { title: entry.title, content: entry.content } };
  }
</script>

{#snippet form(value: Form, key: string, label: string, onsave: () => void, oncancel: () => void)}
  <div class="form" data-testid="memory-form">
    <Input size="sm" bind:value={value.title} placeholder="Title" aria-label="Memory title" disabled={busy === key} />
    <TextArea bind:value={value.content} rows={3} maxRows={14} placeholder="What {name} should remember" aria-label="Memory content" disabled={busy === key} />
    <div class="actions">
      <Button size="sm" variant="ghost" onclick={oncancel} disabled={busy === key}>Cancel</Button>
      <Button size="sm" variant="primary" onclick={onsave} loading={busy === key} disabled={!!busy || !ready(value)}>{label}</Button>
    </div>
    {#if error?.key === key}<p class="t-caption warn" role="alert">{error.text}</p>{/if}
  </div>
{/snippet}

<section class="memory" aria-label="Memory of {name}" data-testid="agent-memory">
  <div class="head">
    <h3 class="t-caption heading">Memory of {name}</h3>
    {#if !readonly && !adding}<Button size="sm" variant="ghost" icon="plus" onclick={() => ((adding = { title: "", content: "" }), (error = null))}>Add memory</Button>{/if}
  </div>
  <span class="t-caption meta" data-path={folder.memory.path}>
    Loaded into every thread of {name} from <code class="t-mono" title={folder.memory.path}>{shortPath(folder.memory.path)}</code>
  </span>
  {#if adding}{@render form(adding, "new", "Add", add, () => (adding = null))}{/if}
  <ul class="entries">
    {#each folder.memory.entries as entry (keyOf(entry))}
      {@const key = keyOf(entry)}
      <li class="entry" data-entry-id={entry.id} data-kind={entry.kind}>
        {#if editing?.key === key}
          {@render form(editing.form, key, "Save", () => update(entry), () => (editing = null))}
        {:else}
          <div class="entry-head">
            <span class="t-label-sm title">{entry.title}</span>
            {#if entry.kind !== "memory"}<Chip size="sm" label={entry.kind} />{/if}
            {#if !readonly}
              <span class="tools">
                <button type="button" class="link t-caption" aria-label="Edit {entry.title}" onclick={() => startEdit(entry)}>Edit</button>
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
          {#if error?.key === key}<p class="t-caption warn" role="alert">{error.text}</p>{/if}
        {/if}
      </li>
    {:else}
      <li class="t-caption meta">No memories yet.</li>
    {/each}
  </ul>
</section>

<style>
  .memory {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .head,
  .actions,
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
  .entry .form {
    align-self: stretch;
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
