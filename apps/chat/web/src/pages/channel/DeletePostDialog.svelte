<script lang="ts">
  import { api } from "$lib/api";
  import Button from "$lib/ui/Button.svelte";
  import Dialog from "$lib/ui/Dialog.svelte";
  import { toast } from "$lib/ui/toast.svelte";

  /** Slack's Delete message confirm for the owner's own room post. An agent that already read the post is told it was deleted. */
  type Props = { open: boolean; room: string; post: string; text: string };
  let { open = $bindable(), room, post, text }: Props = $props();
  let deleting = $state(false);

  async function remove() {
    deleting = true;
    try {
      await api.deletePost(room, post);
      open = false;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not delete the message");
    } finally {
      deleting = false;
    }
  }
</script>

<Dialog bind:open title="Delete message" description="Are you sure you want to delete this message? This cannot be undone. An agent that read it is told." width={460}>
  {#if text}<p class="quote">{text.length > 400 ? `${text.slice(0, 400)}…` : text}</p>{/if}
  {#snippet actions()}
    <Button variant="outline" onclick={() => (open = false)}>Cancel</Button>
    <Button variant="danger" loading={deleting} onclick={() => void remove()} data-autofocus data-confirm-delete>Delete</Button>
  {/snippet}
</Dialog>

<style>
  .quote {
    margin: 0;
    padding: 8px 12px;
    border-left: 3px solid var(--border-standard);
    color: var(--text-subtle);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 200px;
    overflow: auto;
  }
</style>
