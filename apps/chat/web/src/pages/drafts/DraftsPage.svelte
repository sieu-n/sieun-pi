<script lang="ts">
  import { onDestroy } from "svelte";
  import { jobs } from "$lib/api";
  import { drafts, type Draft } from "$lib/drafts.svelte";
  import { conversationHref, hrefFor, router } from "$lib/router.svelte";
  import { sidebar } from "$lib/shell/sidebar.svelte";
  import { Avatar, Button, EmptyState, Icon, IconButton, PanelHeader, stampLabel } from "$lib/ui";
  import { directory } from "$pages/channel/directory.svelte";
  import { toast } from "$lib/ui/toast.svelte";

  let now = $state(Date.now());
  const clock = setInterval(() => (now = Date.now()), 30_000);
  onDestroy(() => clearInterval(clock));

  type Where = { name: string; kind: "channel" | "dm" | "solo" | "job"; agent?: string };

  /** The room a draft sits in, from the sidebar's rows, else the room list, which also holds test and archived channels, else the jobs. */
  function whereOf(room: string): Where {
    const { channels, dms, solo } = sidebar.data;
    const dm = dms.find((r) => r.id === room);
    if (dm) return { name: dm.name, kind: "dm", agent: dm.agent ?? dm.id };
    const row = channels.find((r) => r.id === room) ?? solo.find((r) => r.id === room);
    const listed = row ? { name: row.name, kind: row.kind } : directory.room(room);
    if (!listed) {
      const job = jobs.byId(room);
      return job ? { name: job.name, kind: "job" } : { name: "a conversation", kind: "channel" };
    }
    return listed.kind === "channel" ? { name: `#${listed.name}`, kind: "channel" } : { name: listed.name, kind: "solo" };
  }

  /** Where a row opens; a thread draft saved before 11-22 whose room no channel claims has none. */
  function hrefOf(draft: Draft): string | null {
    switch (draft.place.kind) {
      case "room": return conversationHref(draft.place.room);
      case "thread": return conversationHref(draft.place.room, { thread: draft.place.thread });
      case "legacy": return null;
      default: {
        const _exhaustive: never = draft.place;
        return _exhaustive;
      }
    }
  }

  function copy(draft: Draft): void {
    void navigator.clipboard.writeText(draft.text).then(() => toast.show("Draft copied"), () => toast.error("Could not copy the draft"));
  }
</script>

<div class="page" data-testid="drafts-page">
  <PanelHeader title="Drafts" icon="edit" level={1} divider />
  <div class="scroll">
    {#if !drafts.list.length}
      <div class="empty" role="status">
        <EmptyState icon="edit" title="No drafts" description="A message you start and don't send waits here, so you can pick it up again.">
          {#snippet action()}
            <Button size="sm" variant="primary" onclick={() => router.navigate(hrefFor("messages", ["new"], { kind: "dm" }))}>New message</Button>
          {/snippet}
        </EmptyState>
      </div>
    {:else}
      <ul class="rows" aria-label="Drafts">
        {#each drafts.list as draft (draft.key)}
          {@const href = hrefOf(draft)}
          <li class="row" data-draft-key={draft.key}>
            {#if draft.place.kind === "legacy"}
              <div class="open" data-draft-legacy>
                <span class="lead"><span class="room-icon"><Icon name="chat" size={18} /></span></span>
                <span class="main">
                  <span class="heading"><strong class="where t-label-sm">Thread reply, room not known</strong></span>
                  <span class="hint t-caption">Saved before drafts named their room. It fills the next {draft.place.thread} thread you open.</span>
                  <span class="preview t-body">{draft.text}</span>
                </span>
              </div>
            {:else}
              {@const where = whereOf(draft.place.room)}
              <a class="open" href={href} data-draft-open>
                <span class="lead">
                  {#if where.kind === "dm"}
                    <Avatar name={where.name} kind="agent" seed={where.agent} size={36} />
                  {:else}
                    <span class="room-icon"><Icon name={where.kind === "solo" ? "users" : where.kind === "job" ? "robot" : "hash"} size={18} /></span>
                  {/if}
                </span>
                <span class="main">
                  <span class="heading">
                    <strong class="where t-label-sm">{draft.place.kind === "thread" ? `Thread in ${where.name}` : where.name}</strong>
                    {#if draft.at}<time class="t-caption" datetime={new Date(draft.at).toISOString()}>{stampLabel(draft.at, now)}</time>{/if}
                  </span>
                  <span class="preview t-body">{draft.text}</span>
                </span>
              </a>
            {/if}
            <span class="row-actions">
              {#if href}
                <IconButton size="sm" icon="edit" label="Edit draft" onclick={() => router.navigate(href)} data-draft-edit />
              {:else}
                <IconButton size="sm" icon="copy" label="Copy draft" onclick={() => copy(draft)} data-draft-copy />
              {/if}
              <IconButton size="sm" icon="trash" label="Delete draft" onclick={() => drafts.remove(draft)} data-draft-delete />
            </span>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>

<style>
  .page { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .scroll { flex: 1; min-height: 0; overflow: auto; }
  .empty { display: grid; place-items: center; min-height: 60%; padding: var(--space-page-section-gap) var(--space-panel-inset); }
  .rows { list-style: none; margin: 0; padding: var(--space-1) var(--space-1-5) var(--space-panel-inset); display: grid; gap: 2px; }
  .row { position: relative; min-width: 0; border-radius: var(--radius-row); }
  .row:hover, .row:focus-within { background: var(--neutral-3); }
  .open { display: grid; grid-template-columns: 36px minmax(0, 1fr); gap: var(--space-3); padding: 10px var(--space-3); color: inherit; text-decoration: none; border-radius: inherit; }
  .lead { padding-top: 2px; }
  .room-icon { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 10px; background: var(--neutral-3); color: var(--text-subtle); }
  .main { display: grid; gap: 2px; min-width: 0; }
  .heading { display: flex; align-items: baseline; gap: var(--space-2); min-width: 0; }
  .where { color: var(--text-standard); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .heading time { color: var(--text-metadata); flex: none; }
  .hint { color: var(--text-subtle); }
  .preview { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; max-inline-size: 72ch; white-space: pre-line; color: var(--text-standard); }
  .row-actions { position: absolute; top: 8px; right: var(--space-3); display: flex; gap: 2px; padding: 2px; border-radius: 8px; background: var(--surface-panel); box-shadow: var(--shadow-float); opacity: 0; }
  .row:hover .row-actions, .row:focus-within .row-actions { opacity: 1; }
  @media (hover: none) { .row-actions { opacity: 1; } }
</style>
