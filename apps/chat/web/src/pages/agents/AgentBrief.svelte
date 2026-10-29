<script lang="ts">
  /**
   * An agent's brief (`brief.md` in its folder), shown as markdown with an Edit button. Every thread of the agent loads it as a context
   * file, so a save shows in each thread's next request. An empty brief offers the agent's first message as starting text, and nothing is
   * written until the owner presses Save.
   */
  import { api, type AgentFolder } from "$lib/api";
  import { Button, Markdown, TextArea, stampLabel, toast } from "$lib/ui";
  import { shortPath } from "./agents-model";

  type Props = {
    folder: AgentFolder;
    name: string;
    /** The agent's first message, offered as starting text for an empty brief. */
    purpose: string | null;
    /** A job's card shows its agent's brief without editing. */
    readonly?: boolean;
    onsaved: (folder: AgentFolder) => void;
  };
  let { folder, name, purpose, readonly = false, onsaved }: Props = $props();

  let editing = $state(false);
  let draft = $state("");
  let fromPurpose = $state(false);
  let saving = $state(false);
  let error = $state("");

  const text = $derived(folder.brief.text);

  function edit() {
    error = "";
    fromPurpose = !text.trim() && !!purpose?.trim();
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
      const next = await api.setBrief(folder.agent, draft.trim() ? draft : "");
      editing = false;
      onsaved(next);
      toast.success(next.brief.text ? "Saved the brief" : "Removed the brief");
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
    } finally {
      saving = false;
    }
  }
</script>

<section class="brief" aria-label="Brief" data-testid="agent-brief" data-brief={text ? "set" : "empty"}>
  <div class="head">
    <h3 class="t-caption heading">Brief</h3>
    {#if !readonly && !editing}<Button size="sm" variant="ghost" icon="edit" onclick={edit}>{text ? "Edit" : "Write a brief"}</Button>{/if}
  </div>
  {#if editing}
    {#if fromPurpose}
      <div class="hint">
        <span class="t-caption">This starting text is its first message. Keep it, change it or clear it.</span>
        <button type="button" class="link t-caption" onclick={() => ((draft = ""), (fromPurpose = false))}>Clear</button>
      </div>
    {/if}
    <TextArea bind:value={draft} rows={8} maxRows={24} aria-label="Brief of {name}" placeholder="What {name} is responsible for, in your words." disabled={saving} />
    <div class="actions">
      <Button size="sm" variant="ghost" onclick={cancel} disabled={saving}>Cancel</Button>
      <Button size="sm" variant="primary" onclick={save} loading={saving} disabled={saving || draft === text}>Save</Button>
    </div>
    {#if error}<p class="t-caption warn" role="alert">{error}</p>{/if}
  {:else if text}
    <div class="text"><Markdown {text} /></div>
  {:else}
    <p class="t-caption meta">{readonly ? `${name} has no brief yet.` : "No brief yet. Write what this agent is responsible for."}</p>
  {/if}
  <span class="t-caption meta" data-path={folder.brief.path}>
    Loaded into every thread of {name} from <code class="t-mono" title={folder.brief.path}>{shortPath(folder.brief.path)}</code>{folder.brief.modifiedAt ? `, changed ${stampLabel(folder.brief.modifiedAt)}` : ""}
  </span>
</section>

<style>
  .brief {
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
  .text {
    max-height: 320px;
    overflow: auto;
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-row);
    background: var(--surface-inset);
    font: var(--text-body-sm);
    color: var(--text-standard);
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
