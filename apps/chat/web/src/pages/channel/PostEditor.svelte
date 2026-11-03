<script lang="ts">
  import { api } from "$lib/api";
  import Button from "$lib/ui/Button.svelte";
  import TextArea from "$lib/ui/TextArea.svelte";
  import { toast } from "$lib/ui/toast.svelte";

  /**
   * Slack's inline Edit message on the owner's own room post: the post's text in a box in place of the post, Enter saves, Shift+Enter breaks
   * the line, Escape cancels. An edit that empties the text asks to delete the post, as Slack does.
   */
  type Props = {
    room: string;
    post: string;
    text: string;
    ondone: () => void;
    ondelete: () => void;
  };
  let { room, post, text, ondone, ondelete }: Props = $props();

  // svelte-ignore state_referenced_locally
  let draft = $state(text);
  let saving = $state(false);
  let element = $state<HTMLTextAreaElement>();

  $effect(() => {
    if (!element) return;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  });

  async function save() {
    if (saving) return;
    if (!draft.trim()) return ondelete();
    if (draft.trim() === text.trim()) return ondone();
    saving = true;
    try {
      await api.editPost(room, post, draft);
      ondone();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the edit");
    } finally {
      saving = false;
    }
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      ondone();
    } else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void save();
    }
  }
</script>

<div class="post-editor" data-post-editor>
  <TextArea bind:value={draft} bind:element rows={1} maxRows={14} aria-label="Edit message" {onkeydown} />
  <div class="buttons">
    <span class="hint">Escape to cancel, Enter to save</span>
    <Button size="sm" variant="outline" onclick={ondone}>Cancel</Button>
    <Button size="sm" variant="accent" loading={saving} onclick={() => void save()} data-save-edit>Save</Button>
  </div>
</div>

<style>
  .post-editor {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: min(100%, 46rem);
    margin: 2px 0 4px;
  }
  .buttons {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
  }
  .hint {
    flex: 1;
    color: var(--text-metadata);
    font: var(--text-caption);
    letter-spacing: var(--tracking-caption);
  }
</style>
