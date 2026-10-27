<script lang="ts">
  import { api } from "./api.ts";
  import { store } from "./store.svelte.ts";
  import Icon from "./Icon.svelte";
  import { pageSummary, wikiPages } from "./reader.ts";

  /**
   * A small card under a chat message for each wiki page it links: the page's title and its one-line summary. A click opens the page in the
   * reader. The owner, 10-18: a wiki page sent as a document embed reads better than a long reply.
   */
  let { text, chat }: { text: string; chat: string } = $props();
  const paths = $derived(wikiPages(text));
  let pages = $state.raw<Record<string, { title: string; summary: string }>>({});
  $effect(() => {
    let cancelled = false;
    for (const path of paths) {
      if (pages[path]) continue;
      api.wikiPage(path).then(page => { if (!cancelled) pages = { ...pages, [path]: { title: page.title, summary: pageSummary(page) } }; }, () => {});
    }
    return () => { cancelled = true; };
  });
</script>

{#each paths as path (path)}
  {@const page = pages[path]}
  <button type="button" class="wiki-embed" onclick={() => store.openArtifact({ kind: "wiki", path }, chat)}>
    <Icon name="page" size={15} />
    <span class="text">
      <span class="title">{page?.title || path.split("/").at(-1)}</span>
      {#if page?.summary}<span class="summary">{page.summary}</span>{/if}
    </span>
  </button>
{/each}

<style>
  .wiki-embed { display: flex; align-items: flex-start; gap: 10px; width: min(82%, 420px); padding: 10px 12px; border: 1px solid var(--border); border-radius: 14px; background: var(--bg-elevated); text-align: left; }
  .wiki-embed:hover { background: var(--bg-hover); }
  .wiki-embed :global(svg) { flex: none; margin-top: 2px; color: var(--accent); }
  .text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13.5px; color: var(--text); }
  .summary { display: -webkit-box; overflow: hidden; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; font-size: 12.5px; line-height: 1.4; color: var(--text-muted); }
  @container app (max-width: 899px) { .wiki-embed { width: 86%; } }
</style>
