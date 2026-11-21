<script lang="ts">
  import { agents, api } from "$lib/api";
  import Button from "$lib/ui/Button.svelte";
  import Dialog from "$lib/ui/Dialog.svelte";
  import Field from "$lib/ui/Field.svelte";
  import Select from "$lib/ui/Select.svelte";
  import TextArea from "$lib/ui/TextArea.svelte";
  import { composing } from "$lib/ui/keyboard";

  /**
   * A note of the owner's own on a chat's board, the todo_add he could only send through the API before: For you lists it under Your notes,
   * and the chat reads it as a `[board]` line. `chat` picks the board first; the last board he picked comes next.
   */
  type Props = { chat?: string; onadded: (chat: string, id: string | undefined) => void; onclose: () => void };
  let { chat, onadded, onclose }: Props = $props();

  const LAST = "chat.forYou.noteChat";
  const chats = $derived(agents.list.filter(a => a.kind === "chat" && !a.archived).map(a => ({ value: a.id as string, label: a.name })));
  // svelte-ignore state_referenced_locally
  let board = $state(chat ?? localStorage.getItem(LAST) ?? "");
  let text = $state("");
  let open = $state(true);
  let pending = $state(false);
  let error = $state<string | null>(null);
  $effect(() => {
    if (chats.length && !chats.some(c => c.value === board)) board = chats[0]!.value;
  });

  async function save(event?: Event) {
    event?.preventDefault();
    const note = text.trim();
    if (pending || !note || !board) return;
    pending = true;
    error = null;
    try {
      const view = await api.boardOps(board, [{ op: "todo_add", text: note }]);
      localStorage.setItem(LAST, board);
      const added = view.board?.todos.findLast(todo => todo.from === "owner" && todo.text === note);
      open = false;
      onadded(board, added?.id);
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
      pending = false;
    }
  }
</script>

<Dialog bind:open title="New note" description="A todo of your own on a chat's board. The chat sees it too." width={480} dirty={!!text.trim()} initialFocus="#note-text" {onclose}>
  <form id="note-form" class="fields" onsubmit={save} aria-label="New note">
    <Field label="Board" id="note-board">
      <Select id="note-board" label="Board" bind:value={board} options={chats} disabled={pending} />
    </Field>
    <Field label="Note" id="note-text" {error} hint="Enter saves, Shift+Enter adds a line.">
      <TextArea id="note-text" bind:value={text} rows={3} disabled={pending} invalid={!!error} placeholder="What you want to remember"
        onkeydown={(e: KeyboardEvent) => { if (e.key === "Enter" && !e.shiftKey && !composing(e)) save(e); }} />
    </Field>
  </form>
  {#snippet actions()}
    <Button variant="ghost" onclick={() => ((open = false), onclose())} disabled={pending}>Cancel</Button>
    <Button variant="primary" type="submit" form="note-form" loading={pending} disabled={pending || !text.trim() || !board}>Add note</Button>
  {/snippet}
</Dialog>

<style>
  .fields { display: grid; gap: var(--space-3); }
</style>
