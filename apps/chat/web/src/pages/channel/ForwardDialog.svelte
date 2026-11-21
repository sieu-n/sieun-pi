<script lang="ts" module>
  import type { ConversationId, Item } from "$lib/api";

  /** What Forward sends: a room post, or a wiki page, which goes as its link. */
  export type ForwardSubject =
    | { kind: "post"; room: ConversationId; item: Extract<Item, { kind: "message" }> }
    | { kind: "wiki"; path: string; title: string };
</script>

<script lang="ts">
  import { agents, api, conversations, me, requestId, type ForwardedPost } from "$lib/api";
  import { conversationHref, router } from "$lib/router.svelte";
  import { sidebar } from "$lib/shell/sidebar.svelte";
  import Button from "$lib/ui/Button.svelte";
  import Dialog from "$lib/ui/Dialog.svelte";
  import LinkCards from "$lib/ui/LinkCards.svelte";
  import RecipientField from "$lib/ui/RecipientField.svelte";
  import TextArea from "$lib/ui/TextArea.svelte";
  import { composing } from "$lib/ui/keyboard";
  import { wikiUrl } from "$lib/ui/markdown";
  import { toast } from "$lib/ui/toast.svelte";
  import type { PickerItem } from "$lib/ui/types";
  import { directory } from "./directory.svelte";
  import ForwardCard from "./ForwardCard.svelte";
  import { mentionContext } from "./present";

  /**
   * Slack's Forward message and a canvas's Share: pick a channel, a DM or a Solo room, add words if you like, and Forward posts the room
   * post with its quote card under them, or the wiki page's link, whose card shows its title and summary.
   */
  type Props = { subject: ForwardSubject; onclose: () => void };
  let { subject, onclose }: Props = $props();

  let open = $state(true);
  let picked = $state<string[]>([]);
  const to = $derived(picked[0] ?? null);
  let note = $state("");
  let pending = $state(false);
  let noteBox = $state<HTMLTextAreaElement>();

  const rowItem = (row: { id: string; name: string; agent?: string }): PickerItem =>
    row.id.startsWith("ch_")
      ? { id: row.id, label: row.name, icon: "hash" }
      : row.id.startsWith("dm_")
        ? { id: row.id, label: row.name, avatar: { name: row.name, kind: "agent", seed: row.agent ?? row.id } }
        : { id: row.id, label: row.name, icon: "users" };

  /** A room's name from what the page holds: the sidebar, the open conversations, the room list or its agent. */
  const nameOf = (id: string): string =>
    [...sidebar.data.channels, ...sidebar.data.dms, ...sidebar.data.solo].find((row) => row.id === id)?.name ??
    conversations.byId(id)?.name ??
    directory.room(id)?.name ??
    agents.list.find((agent) => agents.room(agent.id) === id)?.name ??
    id;

  /** Slack's order, with the room you are in first when the sidebar does not list it, such as a test room: the sidebar's rooms by their last post under Recent, then the other channels, then the agents with no DM in the sidebar. */
  const items = $derived.by((): PickerItem[] => {
    const data = sidebar.data;
    const rows = [...data.channels, ...data.dms, ...data.solo.filter((row) => !row.closedAt)].filter((row) => !row.archived).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    const listed = new Set(rows.map((row) => row.id));
    const channels = directory.channels.filter((room) => !room.archived && !listed.has(room.id)).sort((a, b) => a.name.localeCompare(b.name));
    const dms = agents.list
      .filter((agent) => agent.id.startsWith("ag_") && !agent.archived && !listed.has(agents.room(agent.id)))
      .sort((a, b) => a.name.localeCompare(b.name));
    const here = subject.kind === "post" ? subject.room : router.conversationId && /^(dm|ch|so)_/.test(router.conversationId) ? router.conversationId : null;
    const hereRow = here && !listed.has(here) && !channels.some((room) => room.id === here) ? [{ id: here, name: nameOf(here), agent: agents.list.find((a) => agents.room(a.id) === here)?.id }] : [];
    const all = [
      ...[...hereRow, ...rows].map((row) => ({ ...rowItem(row), group: "Recent" })),
      ...channels.map((room) => ({ ...rowItem(room), group: "Channels" })),
      ...dms.map((agent) => ({ ...rowItem({ id: agents.room(agent.id), name: agent.name, agent: agent.id }), group: "Agents" })),
    ];
    return all.filter((item, index) => all.findIndex((other) => other.id === item.id) === index);
  });
  const chosen = $derived(to ? items.find((item) => item.id === to) ?? null : null);
  const placeName = (item: PickerItem): string => (item.id.startsWith("ch_") ? `#${item.label}` : item.label);

  /** The quote card the forward will carry, as the server copies it (server/forward.ts `forwardOf`). */
  const preview = $derived.by((): ForwardedPost | null => {
    if (subject.kind !== "post") return null;
    const { room, item } = subject;
    if (item.forward && !item.text.trim() && !item.images.length) return item.forward;
    return { room, roomName: nameOf(room), post: item.id, ...(item.threadRoot ? { threadRoot: item.threadRoot } : {}), author: item.author, text: item.text, images: item.images, at: item.at };
  });
  const context = $derived({ mentions: mentionContext(directory.agents, directory.channels, me.value?.owner.name ?? ""), plain: true });
  const title = $derived(subject.kind === "post" ? "Forward this message" : "Share this page");

  /** A pick moves the caret to the message box, as Slack's Forward does. */
  $effect(() => {
    if (!to) return;
    // The list hands focus back to the field as it closes, after this effect, so the move waits a frame.
    const frame = requestAnimationFrame(() => noteBox?.focus());
    return () => cancelAnimationFrame(frame);
  });

  function close() {
    open = false;
    onclose();
  }

  function onNoteKeydown(e: KeyboardEvent) {
    if (e.key !== "Enter" || e.shiftKey || composing(e)) return;
    e.preventDefault();
    void send();
  }

  const link = $derived(
    subject.kind === "post" ? new URL(conversationHref(subject.room, { messageId: subject.item.id }), location.href).href : new URL(wikiUrl(subject.path), location.href).href,
  );

  function copyLink() {
    void navigator.clipboard.writeText(link).then(
      () => toast.show("Link copied"),
      () => toast.error("Could not copy the link"),
    );
  }

  async function send() {
    if (!to || !chosen || pending) return;
    const target = to;
    const words = note.trim();
    pending = true;
    try {
      if (subject.kind === "post") await api.send(target, { text: words, requestId: requestId(), forward: { room: subject.room, post: subject.item.id } });
      else await api.send(target, { text: [words, `[${subject.title}](wiki:${subject.path})`].filter(Boolean).join("\n\n"), requestId: requestId() });
      close();
      toast.show(`${subject.kind === "post" ? "Message forwarded" : "Page shared"} to ${placeName(chosen)}`, { action: { label: "View", run: () => router.openConversation(target) } });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : subject.kind === "post" ? "Could not forward the message" : "Could not share the page");
      pending = false;
    }
  }
</script>

<Dialog bind:open {title} width={560} dirty={!!note.trim() || !!to} initialFocus="#forward-to" onclose={close}>
  <div class="form" data-forward-dialog>
    <RecipientField
      id="forward-to"
      {items}
      bind:value={picked}
      single
      label="To:"
      placeholder="Add a channel or an agent"
      listLabel="Forward to"
      emptyText="No channel or agent matches"
      onsubmit={() => noteBox?.focus()}
    />
    <TextArea id="forward-note" bind:element={noteBox} bind:value={note} rows={2} maxRows={8} placeholder="Add a message, if you'd like" aria-label="Message" disabled={pending} onkeydown={onNoteKeydown} />
    {#if preview}
      <ForwardCard forward={preview} {context} />
    {:else if subject.kind === "wiki"}
      <LinkCards text={`[${subject.title}](wiki:${subject.path})`} />
    {/if}
  </div>
  {#snippet actions()}
    <Button variant="ghost" icon="link" onclick={copyLink} disabled={pending}>Copy link</Button>
    <Button variant="primary" loading={pending} disabled={!to || pending} onclick={send} data-forward-send>Forward</Button>
  {/snippet}
</Dialog>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
</style>
