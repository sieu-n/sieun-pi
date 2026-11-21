<script lang="ts">
  import { tick } from "svelte";
  import type { Member } from "$lib/api";
  import type { DetailsTab } from "$lib/shell/channel-details.svelte";
  import AvatarStack from "$lib/ui/AvatarStack.svelte";
  import Button from "$lib/ui/Button.svelte";
  import CardGroup from "$lib/ui/CardGroup.svelte";
  import Dialog from "$lib/ui/Dialog.svelte";
  import IconButton from "$lib/ui/IconButton.svelte";
  import Tabs from "$lib/ui/Tabs.svelte";
  import TextArea from "$lib/ui/TextArea.svelte";
  import { toast } from "$lib/ui/toast.svelte";
  import { avatarOf } from "./present";

  /**
   * Slack's channel details: About shows the name, the description, the members and when the channel was made, and Settings archives or
   * unarchives it. The description edits in place, Enter saves and Esc or a click away drops the edit. Conversation owns every change.
   */
  type Props = {
    id: string;
    name: string;
    purpose: string;
    createdAt: number | null;
    archived: boolean;
    members: Member[];
    tab: DetailsTab;
    editDescription: boolean;
    /** Resolves false when the save failed and its error was shown. */
    onsavepurpose: (text: string) => Promise<boolean>;
    onrename: () => void;
    onaddpeople: () => void;
    onarchive: () => void;
    onunarchive: () => void;
    onclose: () => void;
  };
  let { id, name, purpose, createdAt, archived, members, tab, editDescription, onsavepurpose, onrename, onaddpeople, onarchive, onunarchive, onclose }: Props = $props();

  let open = $state(true);
  // svelte-ignore state_referenced_locally
  let current = $state<DetailsTab>(tab);
  // svelte-ignore state_referenced_locally
  let editing = $state(editDescription && !archived);
  // svelte-ignore state_referenced_locally
  let draft = $state(purpose);
  let saving = $state(false);
  let field = $state<HTMLTextAreaElement>();

  const count = $derived(members.length);
  const stack = $derived(members.filter((m) => m.principal.id !== "owner").map((m) => avatarOf(m.principal)));
  const created = $derived(createdAt ? new Date(createdAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : null);

  function close() {
    open = false;
    onclose();
  }

  async function startEdit() {
    draft = purpose;
    editing = true;
    await tick();
    field?.focus();
    field?.setSelectionRange(draft.length, draft.length);
  }

  async function save() {
    if (saving) return;
    const text = draft.trim();
    if (text === purpose.trim()) {
      editing = false;
      return;
    }
    saving = true;
    const ok = await onsavepurpose(text);
    saving = false;
    if (ok) editing = false;
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      editing = false;
    }
  }

  function copyId() {
    void navigator.clipboard.writeText(id).then(
      () => toast.show("Channel ID copied"),
      () => toast.error("Could not copy the channel ID"),
    );
  }
</script>

<Dialog bind:open title="#{name}" width={520} {onclose} initialFocus={editing ? "textarea" : "[data-tab][aria-selected=true]"}>
  <div class="details" data-testid="channel-details">
    <Tabs items={[{ id: "about", label: "About" }, { id: "settings", label: "Settings" }]} bind:value={current} variant="underline" size="sm" label="Channel details" />
    {#if current === "about"}
      <CardGroup>
        <div class="row">
          <div class="text">
            <span class="label">Channel name</span>
            <span class="value">#{name}</span>
          </div>
          {#if !archived}<Button variant="ghost" size="sm" onclick={onrename}>Edit</Button>{/if}
        </div>
        <div class="row" data-testid="details-description">
          <div class="text">
            <span class="label" id="details-description-label">Description</span>
            {#if editing}
              <TextArea
                bind:element={field}
                bind:value={draft}
                rows={2}
                maxRows={6}
                aria-labelledby="details-description-label"
                placeholder="What is this channel about?"
                disabled={saving}
                {onkeydown}
                onblur={() => {
                  if (!saving) editing = false;
                }}
              />
              <span class="hint">Enter to save, Shift+Enter for a new line, Esc to cancel</span>
            {:else if purpose}
              <span class="value prose">{purpose}</span>
            {:else if archived}
              <span class="value muted">No description</span>
            {:else}
              <button type="button" class="add" onclick={() => void startEdit()}>Add a description</button>
            {/if}
          </div>
          {#if !editing && purpose && !archived}<Button variant="ghost" size="sm" onclick={() => void startEdit()}>Edit</Button>{/if}
        </div>
        <div class="row">
          <div class="text">
            <span class="label">Members</span>
            <span class="value members">
              {#if stack.length}<AvatarStack members={stack} size={20} max={5} />{/if}
              {count} {count === 1 ? "member" : "members"}
            </span>
          </div>
          {#if !archived}<Button variant="ghost" size="sm" icon="plus" onclick={onaddpeople}>Add people</Button>{/if}
        </div>
        {#if created}
          <div class="row">
            <div class="text">
              <span class="label">Created</span>
              <span class="value">You made this channel on {created}</span>
            </div>
          </div>
        {/if}
      </CardGroup>
      <p class="id">
        Channel ID: <code>{id}</code>
        <IconButton icon="copy" label="Copy channel ID" size="xs" onclick={copyId} />
      </p>
    {:else}
      <CardGroup>
        {#if archived}
          <div class="row">
            <div class="text">
              <span class="label">Unarchive channel</span>
              <span class="value muted">Brings #{name} back to the sidebar, and its members get posts again.</span>
            </div>
            <Button variant="primary" size="sm" onclick={onunarchive}>Unarchive</Button>
          </div>
        {:else}
          <div class="row">
            <div class="text">
              <span class="label">Archive channel</span>
              <span class="value muted">Takes #{name} out of the sidebar and stops every post to its agents. You can read it and unarchive it later.</span>
            </div>
            <Button variant="danger" size="sm" icon="archive" onclick={onarchive}>Archive</Button>
          </div>
        {/if}
      </CardGroup>
    {/if}
  </div>
  {#snippet actions()}
    <Button variant="ghost" onclick={close}>Done</Button>
  {/snippet}
</Dialog>

<style>
  .details {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .row {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 12px 16px;
  }
  .text {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .label {
    font: var(--text-label-sm);
    color: var(--text-standard);
  }
  .value {
    font: var(--text-body-sm);
    color: var(--text-standard);
    overflow-wrap: anywhere;
  }
  .prose {
    white-space: pre-wrap;
  }
  .muted,
  .hint {
    color: var(--text-subtle);
  }
  .hint {
    font: var(--text-caption);
  }
  .members {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .add {
    align-self: flex-start;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--text-message-link);
    font: var(--text-body-sm);
    cursor: pointer;
  }
  .add:hover {
    text-decoration: underline;
  }
  .id {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    padding: 0 4px;
    color: var(--text-subtle);
    font: var(--text-caption);
  }
  .id code {
    font: var(--text-mono);
    font-size: inherit;
  }
</style>
