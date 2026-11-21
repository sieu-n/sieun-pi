<script lang="ts">
  import { onMount } from "svelte";
  import type { BoardOp, OwnerTodo } from "$lib/api";
  import { Button, Chip, Input, Markdown, Menu, toast } from "$lib/ui";
  import RemindDialog from "$lib/RemindDialog.svelte";
  import { remindedText, remindMenu, whenLabel } from "$lib/remind";
  import { snoozed } from "$lib/api/shared/snooze";
  import Composer from "../channel/Composer.svelte";
  import type { Outgoing } from "../channel/present";
  import { linkView, openTarget } from "./links";
  import { changeAsk, changeWords } from "./for-you";
  import { composing } from "$lib/ui/keyboard";

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
  let remindAnchor = $state<HTMLElement>();
  let remindOpen = $state(false);
  let customRemind = $state(false);

  const fromChat = $derived(ask.from === "agent");
  const links = $derived((ask.links ?? []).map(linkView));
  /** The reply box keeps its draft under this key, as a conversation's composer does. */
  const draftKey = $derived(`ask.${chatId}.${ask.id}`);
  const remindAt = $derived(ask.remindAt ? Date.parse(ask.remindAt) : undefined);
  const remindItems = $derived(remindMenu({
    label: "Remind me",
    ...(remindAt !== undefined && snoozed(ask, Date.now()) ? { remindAt } : {}),
    set: at => void remind(at),
    custom: () => { customRemind = true; },
    clear: () => void remind(null),
  }).items);

  onMount(() => {
    if (autofocusReply && fromChat && !ask.done && !ask.reply) startReply("");
  });

  /** Opens the reply box, with `text` in it when he changes his answer. */
  function startReply(text: string) {
    if (text) localStorage.setItem(`chat.draft.${draftKey}`, text);
    editing = false;
    replying = true;
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

  /** Done, Dismiss, Reopen and Remove, each with Undo in its toast. */
  async function change(key: "done" | "reopen" | "remove") {
    busy = key;
    const ops: BoardOp[] = key === "remove" ? [{ op: "todo_remove", id: ask.id }] : [{ op: "todo_update", id: ask.id, done: key === "done" }];
    await changeAsk(onops, ask, key, ops, changeWords(ask, key));
    busy = null;
  }

  /** Remind me: the ask leaves For you until `at`; null takes the reminder off. */
  async function remind(at: number | null) {
    const words = at === null ? `Removed the reminder on ${ask.id}` : remindedText(at);
    await changeAsk(onops, ask, "remind", [{ op: "todo_update", id: ask.id, remindAt: at === null ? null : new Date(at).toISOString() }], words);
  }

  const answer = (text: string) => {
    const reply = text.trim();
    if (!reply) return;
    void run(`choice:${reply}`, [{ op: "todo_update", id: ask.id, reply, done: true }], `Answered ${ask.id}`);
  };

  /** A reply from the composer: its text, then each attached image as a markdown image the chat gets with the answer (server/boards.ts), and each other file as a link. */
  async function send(out: Outgoing) {
    const refs = await Promise.all(out.images.map(image => image.ref()));
    const reply = [out.text.trim(), ...refs.map(ref => (ref.name === undefined ? `![image](${ref.url})` : `[${ref.name}](${ref.url})`))].filter(Boolean).join("\n\n");
    if (!reply) return;
    await onops([{ op: "todo_update", id: ask.id, reply, done: true }]);
    toast.success(`Answered ${ask.id}`);
    replying = false;
  }

  const saveEdit = () => {
    const text = draft.trim();
    if (!text || text === ask.text) { editing = false; return; }
    void run("edit", [{ op: "todo_update", id: ask.id, text }]);
  };
  function onKey(event: KeyboardEvent, submit: () => void) {
    if (event.key === "Enter" && !event.shiftKey && !composing(event)) { event.preventDefault(); submit(); }
    if (event.key === "Escape") { event.preventDefault(); editing = false; }
  }
  /** Escape closes the reply box and keeps its draft; an open @ list in it takes Escape first. */
  function replyKey(event: KeyboardEvent) {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    replying = false;
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
    <div class="reply t-body-sm"><span class="you">You:</span> <Markdown text={ask.reply} inline /></div>
  {/if}

  {#if remindAt !== undefined && snoozed(ask, Date.now())}
    <p class="snoozed t-caption" data-snoozed>Snoozed until {whenLabel(remindAt)}</p>
  {/if}

  {#if replying}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="reply-box" onkeydown={replyKey}>
      <Composer placeholder="Reply to {ask.id}, Enter sends" agents={[]} channels={[]} {draftKey} autofocus compact onsend={send} />
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
        <Button size="sm" variant="ghost" loading={busy === "reopen"} onclick={() => change("reopen")}>Reopen</Button>
      {:else}
        {#if fromChat && !replying}<Button size="sm" variant="ghost" onclick={() => startReply(ask.reply ?? "")}>{ask.reply ? "Change answer" : "Reply"}</Button>{/if}
        <Button size="sm" variant="ghost" icon="clock" bind:element={remindAnchor} aria-haspopup="menu" aria-expanded={remindOpen} onclick={() => { remindOpen = !remindOpen; }}>Remind me</Button>
        <Button size="sm" variant="ghost" loading={busy === "done"} onclick={() => change("done")}>{fromChat ? "Dismiss" : "Done"}</Button>
      {/if}
      {#if ask.done && fromChat && ask.reply && !replying}<Button size="sm" variant="ghost" onclick={() => startReply(ask.reply ?? "")}>Change answer</Button>{/if}
      {#if !fromChat}
        <Button size="sm" variant="ghost" onclick={() => { draft = ask.text; editing = true; queueMicrotask(() => input?.focus()); }}>Edit</Button>
        <Button size="sm" variant="ghost" loading={busy === "remove"} onclick={() => change("remove")}>Remove</Button>
      {/if}
    </span>
  </div>
</div>
<Menu bind:open={remindOpen} anchor={remindAnchor} items={remindItems} placement="bottom-end" label="Remind me" />
{#if customRemind}<RemindDialog title="Remind me" at={remindAt} onpick={at => remind(at)} onclose={() => (customRemind = false)} />{/if}

<style>
  .ask { display: grid; gap: var(--space-2); min-width: 0; }
  .ask.done :global(.ask-text) { color: var(--text-subtle); }
  .ask :global(.ask-text) { overflow-wrap: anywhere; }
  .links { display: flex; flex-wrap: wrap; gap: var(--space-1); }
  .reply { justify-self: start; max-width: 100%; padding: var(--space-1) var(--space-2); border-radius: var(--radius-chip); background: var(--surface-message-own); color: var(--text-message-own); overflow-wrap: anywhere; }
  .you { font-weight: 500; }
  .snoozed { margin: 0; color: var(--text-subtle); }
  .reply-box { min-width: 0; }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1); }
  .quiet { display: inline-flex; flex-wrap: wrap; gap: var(--space-half); margin-inline-start: auto; }
</style>
