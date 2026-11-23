<script lang="ts">
  import { onDestroy } from "svelte";
  import { markedUnread, replies, threadMarkKey, timeline, type Item } from "$lib/api";
  import type { MarkdownContext } from "$lib/ui/markdown";
  import type { Status } from "$lib/ui/types";
  import Composer from "./Composer.svelte";
  import Timeline from "./Timeline.svelte";
  import { directory } from "./directory.svelte";
  import type { Outgoing } from "./present";

  type Props = {
    /** The channel a channel thread lives in. */
    channel?: string | null;
    /** That channel's name, for the reply box's "Also send to #channel". */
    channelName?: string | null;
    /** A job's conversation id, or a channel root post id when `channel` is set. */
    threadKey: string;
    /** The reply box's draft key in lib/drafts, which names the conversation too, since post ids repeat across rooms. */
    draftKey: string;
    context: MarkdownContext;
    statusOf?: (id: string) => Status | null;
    oncopylink: (item: Item, conversation: string) => void;
    onthread: (key: string) => void;
    onmention?: (id: string, kind: string, e: MouseEvent) => void;
    onboardid?: (id: string, chatId: string, e: MouseEvent) => void;
    onartifact?: (target: string, e: MouseEvent) => void;
    /** slack draws the root post, an "N replies" rule and the replies as Slack rows. */
    layout?: "bubble" | "slack";
    /** The reply a link names, such as a saved reply on the Later page: the pane scrolls to it and flashes it. */
    focus?: string;
  };
  let { channel = null, channelName = null, threadKey, draftKey, focus, context, statusOf, oncopylink, onthread, onmention, onboardid, onartifact, layout = "bubble" }: Props = $props();

  // svelte-ignore state_referenced_locally
  const job = channel ? null : timeline(threadKey);
  // svelte-ignore state_referenced_locally
  const posts = channel ? replies(channel, threadKey) : null;
  // A thread reply marked unread draws the New line while the pane stays open; its Keep unread item in Later stays until he handles it.
  // svelte-ignore state_referenced_locally
  const markKey = channel ? threadMarkKey(channel, threadKey) : null;
  onDestroy(() => {
    job?.close();
    posts?.close();
    if (markKey) markedUnread.delete(markKey);
  });

  const channelRoom = $derived.by(() => {
    const row = channel ? directory.channels.find((c) => c.id === channel) : undefined;
    return row ? { label: `#${row.name}`, members: row.members.map((m) => m.principal.id) } : null;
  });
  const items = $derived(job ? job.items : posts?.root ? [rootOnly(posts.root), ...posts.items] : []);
  let retry = $state(0);

  /** The pane already is the thread, so its root shows no pill to itself. */
  function rootOnly(root: Item): Item {
    if (root.kind !== "message" || !root.thread) return root;
    const { thread: _thread, ...rest } = root;
    return rest;
  }

  function send(out: Outgoing): Promise<void> {
    if (job) return job.send(out.text, { images: out.images, mentions: out.mentions });
    // A reply answers the reply he marked unread here, so its New line goes with it.
    if (markKey) markedUnread.delete(markKey);
    return posts?.send(out.text, { images: out.images, mentions: out.mentions, ...(out.alsoInChannel ? { alsoInChannel: true } : {}) }) ?? Promise.resolve();
  }

  function retrySend(item: Item) {
    if (job) job.retrySend(item.id);
    else posts?.retrySend(item.id);
  }

  function discardSend(item: Item) {
    if (job) job.discardSend(item.id);
    else posts?.discardSend(item.id);
  }
</script>

<div class="pane" data-testid="thread-pane" data-thread={threadKey}>
  {#key retry}
    <Timeline
      {items}
      {layout}
      replyCount={layout === "slack" && posts?.root ? posts.items.length : null}
      loading={job ? job.loading : (posts?.loading ?? false)}
      error={job ? job.error : (posts?.error ?? null)}
      hasOlder={!!job?.older}
      loadingOlder={job?.loadingOlder ?? false}
      loadOlder={(wait) => job?.loadOlder(wait) ?? Promise.resolve()}
      {focus}
      {context}
      queue={job?.queue ?? null}
      compact
      {statusOf}
      onretry={() => retry++}
      onretrysend={retrySend}
      ondiscardsend={discardSend}
      {onthread}
      oncopylink={(item) => oncopylink(item, channel ?? threadKey)}
      {onmention}
      {onboardid}
      {onartifact}
      newLine={markKey ? markedUnread.get(markKey) : null}
    />
  {/key}
  <Composer
    placeholder={layout === "slack" ? "Reply…" : "Reply to thread"}
    agents={directory.agents}
    channels={directory.channels}
    room={channelRoom}
    alsoSend={channel && channelName ? `Also send to #${channelName}` : null}
    working={job?.status === "working"}
    {draftKey}
    compact
    onsend={send}
    onstop={job ? () => void job.stop() : undefined}
  />
</div>

<style>
  .pane {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    height: 100%;
  }
</style>
