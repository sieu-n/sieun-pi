<script lang="ts">
  import { onMount } from "svelte";
  import type { BoardOp, OwnerTodo } from "$lib/api";
  import { Button, Chip, Input, Markdown, toast } from "$lib/ui";
  import { linkView, openTarget } from "./links";

  let {
    chatId,
    ask,
    titles,
    onops,
    onboardid,
    autofocusReply = false,
  }: {
    chatId: string;
    ask: OwnerTodo;
    titles: ReadonlyMap<string, string>;
    onops: (ops: BoardOp[]) => Promise<void>;
    onboardid?: (id: string) => void;
    autofocusReply?: boolean;
  } = $props();

  let replying = $state(false);
  let editing = $state(false);
  let draft = $state("");
  let busy = $state<string | null>(null);
  let input = $state<HTMLInputElement>();

  const fromChat = $derived(ask.from === "agent");
  const links = $derived((ask.links ?? []).map(linkView));

  onMount(() => {
    if (autofocusReply && fromChat && !ask.done && !ask.reply) startReply("");
  });

  function startReply(text: string) {
    draft = text;
    editing = false;
    replying = true;
    queueMicrotask(() => input?.focus());
  }

  async function run(key: string, ops: BoardOp[], done?: string) {
    busy = key;
    try {
      await onops(ops);
      if (done) toast.success(done);
      replying = false;
      editing = false;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The board did not take that change.");
    } finally {
      busy = null;
    }
  }

  const answer = (text: string) => {
    const reply = text.trim();
    if (!reply) return;
    void run(`choice:${reply}`, [{ op: "todo_update", id: ask.id, reply, done: true }], `Answered ${ask.id}`);
  };
  const saveEdit = () => {
    const text = draft.trim();
    if (!text || text === ask.text) { editing = false; return; }
    void run("edit", [{ op: "todo_update", id: ask.id, text }]);
  };
  function onKey(event: KeyboardEvent, submit: () => void) {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(); }
    if (event.key === "Escape") { event.preventDefault(); replying = false; editing = false; }
  }
</script>

<div class="ask" class:done={ask.done} data-board-id={ask.id} data-from={ask.from}>
  {#if editing}
    <Input bind:value={draft} bind:element={input} size="sm" aria-label="Edit {ask.id}" onkeydown={(e: KeyboardEvent) => onKey(e, saveEdit)} onblur={saveEdit} />
  {:else}
    <Markdown class="ask-text t-body" text={ask.text} inline context={{ board: { chatId, titles } }} onboardid={(id: string) => onboardid?.(id)} />
  {/if}

  {#if links.length}
    <div class="links">
      {#each links as link, index (link.raw + index)}
        <Chip size="sm" icon={link.icon} label={link.label} onclick={link.target ? () => openTarget(link.target!, chatId) : undefined} />
      {/each}
    </div>
  {/if}

  {#if ask.reply && !replying}
    <button type="button" class="reply t-body-sm" title="Change your answer" onclick={() => startReply(ask.reply ?? "")}><span class="you">You:</span> {ask.reply}</button>
  {/if}

  {#if replying}
    <div class="reply-row">
      <Input bind:value={draft} bind:element={input} size="sm" placeholder="Your reply, Enter sends" aria-label="Reply to {ask.id}" onkeydown={(e: KeyboardEvent) => onKey(e, () => answer(draft))} />
      <Button size="sm" variant="primary" loading={busy === `choice:${draft.trim()}`} disabled={!draft.trim()} onclick={() => answer(draft)}>Send</Button>
    </div>
  {/if}

  <div class="actions">
    {#if !ask.done}
      {#each ask.choices ?? [] as choice, index (index)}
        <Button size="sm" variant={index === 0 ? "primary" : "outline"} loading={busy === `choice:${choice}`} title={index === 0 ? "The chat recommends this one" : undefined} onclick={() => answer(choice)}>{choice}</Button>
      {/each}
    {/if}
    <span class="quiet">
      {#if ask.done}
        <Button size="sm" variant="ghost" loading={busy === "reopen"} onclick={() => run("reopen", [{ op: "todo_update", id: ask.id, done: false }])}>Reopen</Button>
      {:else}
        {#if fromChat && !replying}<Button size="sm" variant="ghost" onclick={() => startReply("")}>Reply</Button>{/if}
        <Button size="sm" variant="ghost" loading={busy === "done"} onclick={() => run("done", [{ op: "todo_update", id: ask.id, done: true }], fromChat ? `Dismissed ${ask.id}` : `Done ${ask.id}`)}>{fromChat ? "Dismiss" : "Done"}</Button>
      {/if}
      {#if !fromChat}
        <Button size="sm" variant="ghost" onclick={() => { draft = ask.text; editing = true; queueMicrotask(() => input?.focus()); }}>Edit</Button>
        <Button size="sm" variant="ghost" loading={busy === "remove"} onclick={() => run("remove", [{ op: "todo_remove", id: ask.id }])}>Remove</Button>
      {/if}
    </span>
  </div>
</div>

<style>
  .ask { display: grid; gap: var(--space-2); min-width: 0; }
  .ask.done :global(.ask-text) { color: var(--text-subtle); }
  .ask :global(.ask-text) { overflow-wrap: anywhere; }
  .links { display: flex; flex-wrap: wrap; gap: var(--space-1); }
  .reply { justify-self: start; max-width: 100%; padding: var(--space-1) var(--space-2); border: 0; border-radius: var(--radius-chip); background: var(--surface-message-own); color: var(--text-message-own); text-align: start; cursor: pointer; overflow-wrap: anywhere; }
  .you { font-weight: 500; }
  .reply-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-2); align-items: center; }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1); }
  .quiet { display: inline-flex; gap: var(--space-half); margin-inline-start: auto; }
</style>
