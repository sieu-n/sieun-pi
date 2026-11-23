<script lang="ts" module>
  import type { AgentFolder } from "$lib/api";

  /** The markdown files of an agent's folder that the Brief tab shows and edits, each with its own words and save call. */
  export type FolderText = "brief" | "workingMemory";
</script>

<script lang="ts">
  /**
   * One markdown file of an agent's folder, its brief (`brief.md`) or its working memory (`working-memory.md`), shown with an Edit button.
   * Every thread of the agent loads the brief as a context file, and its main thread rewrites its working memory after each turn. An empty
   * brief offers the agent's first message as starting text, and nothing is written until the owner presses Save.
   */
  import { api } from "$lib/api";
  import { Button, TextArea, stampLabel, toast } from "$lib/ui";
  import { shortPath } from "./agents-model";
  import FoldedMarkdown from "./FoldedMarkdown.svelte";

  type Props = {
    /** Its config's folder, whose file this shows; a save answers with the whole folder. */
    folder: Pick<AgentFolder, "agent" | FolderText>;
    doc: FolderText;
    name: string;
    /** The agent's first message, offered as starting text for an empty brief. */
    purpose?: string | null;
    /** A job's page shows its agent's files without editing. */
    readonly?: boolean;
    onsaved: (folder: AgentFolder) => void;
  };
  let { folder, doc, name, purpose = null, readonly = false, onsaved }: Props = $props();

  const COPY: Record<FolderText, { title: string; testid: string; write: string; empty: string; placeholder: string; noun: string; save: (agent: string, text: string) => Promise<AgentFolder> }> = {
    brief: {
      title: "Brief", testid: "agent-brief", write: "Write a brief", noun: "the brief",
      empty: "No brief yet. Write what this agent is responsible for.",
      placeholder: "What {name} is responsible for, in your words.",
      save: api.setBrief,
    },
    workingMemory: {
      title: "Working memory", testid: "agent-working-memory", write: "Write it", noun: "the working memory",
      empty: "No working memory yet. Its main thread writes one after its next turn.",
      placeholder: "What {name} is on now, what it waits for and what comes next.",
      save: api.setWorkingMemory,
    },
  };
  const copy = $derived(COPY[doc]);
  const file = $derived(folder[doc]);

  let editing = $state(false);
  let draft = $state("");
  let fromPurpose = $state(false);
  let saving = $state(false);
  let error = $state("");

  const text = $derived(file.text);
  /** The text as shown: a working memory's own opening heading, such as "# agent factory, working memory", repeats the label above it. */
  const shown = $derived(doc === "workingMemory" ? text.replace(/^\s*#{1,3} [^\n]*working memory[^\n]*\n+/i, "") : text);

  function edit() {
    error = "";
    fromPurpose = doc === "brief" && !text.trim() && !!purpose?.trim();
    draft = fromPurpose ? purpose!.trim() : text;
    editing = true;
  }
  function cancel() {
    editing = false;
    error = "";
  }
  async function save() {
    if (saving) return;
    saving = true;
    error = "";
    try {
      const next = await copy.save(folder.agent, draft.trim() ? draft : "");
      editing = false;
      onsaved(next);
      toast.success(next[doc].text ? `Saved ${copy.noun}` : `Removed ${copy.noun}`);
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
    } finally {
      saving = false;
    }
  }
</script>

<section class="doc" aria-label={copy.title} data-testid={copy.testid} data-doc={text ? "set" : "empty"}>
  <div class="head">
    <h3 class="t-caption heading">{copy.title}</h3>
    {#if !readonly && !editing}<Button size="sm" variant="ghost" icon="edit" onclick={edit}>{text ? "Edit" : copy.write}</Button>{/if}
  </div>
  {#if editing}
    {#if fromPurpose}
      <div class="hint">
        <span class="t-caption">This starting text is its first message. Keep it, change it or clear it.</span>
        <button type="button" class="link t-caption" onclick={() => ((draft = ""), (fromPurpose = false))}>Clear</button>
      </div>
    {/if}
    <TextArea bind:value={draft} rows={8} maxRows={24} aria-label="{copy.title} of {name}" placeholder={copy.placeholder.replace("{name}", name)} disabled={saving} />
    <div class="actions">
      <Button size="sm" variant="ghost" onclick={cancel} disabled={saving}>Cancel</Button>
      <Button size="sm" variant="primary" onclick={save} loading={saving} disabled={saving || draft === text}>Save</Button>
    </div>
    {#if error}<p class="t-caption warn" role="alert">{error}</p>{/if}
  {:else if text}
    <FoldedMarkdown text={shown} />
  {:else}
    <p class="t-caption meta">{readonly ? `${name} has no ${copy.title.toLowerCase()} yet.` : copy.empty}</p>
  {/if}
  <span class="t-caption meta" data-path={file.path}>
    {doc === "brief" ? `Loaded into every thread of ${name} from` : `Rewritten by its main thread after each turn and read by every other thread of ${name}, from`}
    <code class="t-mono" title={file.path}>{shortPath(file.path)}</code>{file.modifiedAt ? `, changed ${stampLabel(file.modifiedAt)}` : ""}
  </span>
</section>

<style>
  .doc {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .head,
  .hint,
  .actions {
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
  .hint {
    flex-wrap: wrap;
    color: var(--text-subtle);
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
  .link {
    padding: 0;
    border: 0;
    background: none;
    color: var(--text-subtle);
    text-decoration: underline;
    cursor: pointer;
  }
</style>
