<script lang="ts">
  import { onDestroy } from "svelte";
  import { replies, timeline, type Item } from "$lib/api";
  import type { MarkdownContext } from "$lib/ui/markdown";
  import type { Status } from "$lib/ui/types";
  import Composer from "./Composer.svelte";
  import Timeline from "./Timeline.svelte";
  import { directory } from "./directory.svelte";
  import type { Outgoing } from "./present";

  type Props = {
    /** The channel a channel thread lives in. */
    channel?: string | null;
    /** A job's conversation id, or a channel root post id when `channel` is set. */
    threadKey: string;
    context: MarkdownContext;
    statusOf?: (id: string) => Status | null;
    oncopylink: (item: Item, conversation: string) => void;
    onthread: (key: string) => void;
    onmention?: (id: string, kind: string, e: MouseEvent) => void;
    onboardid?: (id: string, chatId: string, e: MouseEvent) => void;
    onartifact?: (target: string, e: MouseEvent) => void;
  };
  let { channel = null, threadKey, context, statusOf, oncopylink, onthread, onmention, onboardid, onartifact }: Props = $props();

  // svelte-ignore state_referenced_locally
  const job = channel ? null : timeline(threadKey);
  // svelte-ignore state_referenced_locally
  const posts = channel ? replies(channel, threadKey) : null;
  onDestroy(() => {
    job?.close();
    posts?.close();
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
    return posts?.send(out.text, { images: out.images, mentions: out.mentions }) ?? Promise.resolve();
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
      loading={job ? job.loading : (posts?.loading ?? false)}
      error={job ? job.error : (posts?.error ?? null)}
      hasOlder={!!job?.older}
      loadingOlder={job?.loadingOlder ?? false}
      loadOlder={() => job?.loadOlder() ?? Promise.resolve()}
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
    />
  {/key}
  <Composer
    placeholder="Reply to thread"
    agents={directory.agents}
    channels={directory.channels}
    working={job?.status === "working"}
    draftKey="thread:{threadKey}"
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
