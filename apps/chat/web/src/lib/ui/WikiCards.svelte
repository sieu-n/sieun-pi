<script lang="ts" module>
  type PageMeta = { title: string; summary: string } | null;
  /** Each page's title and summary, read once per page load: null while it loads or when the page is gone. */
  const metas = new Map<string, Promise<PageMeta>>();

  /** The YAML header of `GET /wiki/<path>?format=md&lines=1-1`, whose `key: <json>` lines carry the title and the summary. */
  function readMeta(path: string): Promise<PageMeta> {
    let hit = metas.get(path);
    if (!hit) {
      hit = fetch(`/wiki/${path.split("/").map(encodeURIComponent).join("/")}?format=md&lines=1-1`)
        .then(async (res) => {
          if (!res.ok) return null;
          const head: Record<string, unknown> = {};
          for (const line of (/^---\n([\s\S]*?)\n---/.exec(await res.text())?.[1] ?? "").split("\n")) {
            const m = /^(\w+): (.*)$/.exec(line);
            if (m) {
              try {
                head[m[1]!] = JSON.parse(m[2]!);
              } catch {
                head[m[1]!] = m[2];
              }
            }
          }
          const text = (key: string) => (typeof head[key] === "string" ? (head[key] as string) : "");
          return { title: text("title"), summary: text("summary") || text("description") };
        })
        .catch(() => null);
      metas.set(path, hit);
    }
    return hit;
  }
</script>

<script lang="ts">
  import Icon from "./Icon.svelte";
  import { wikiPages, wikiUrl } from "./markdown";

  /**
   * A card under a post for each wiki page its text links: the page's title and one-line summary. A click opens the page through
   * `onopen` (the app's page viewer), and a Cmd, Ctrl or Shift click opens the wiki in a tab. After legacy/prime/user-history's WikiEmbeds.
   */
  type Props = { text: string; onopen?: (path: string, e: MouseEvent) => void };
  let { text, onopen }: Props = $props();

  const paths = $derived(wikiPages(text));
  let pages = $state<Record<string, PageMeta | undefined>>({});
  $effect(() => {
    let live = true;
    for (const path of paths) {
      if (path in pages) continue;
      void readMeta(path).then((meta) => {
        if (live) pages = { ...pages, [path]: meta };
      });
    }
    return () => {
      live = false;
    };
  });

  const fileName = (path: string): string => path.split("/").filter(Boolean).at(-1) ?? path;

  function open(path: string, e: MouseEvent) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0 || !onopen) return;
    e.preventDefault();
    onopen(path, e);
  }
</script>

{#if paths.length}
  <div class="wiki-cards" data-wiki-cards>
    {#each paths as path (path)}
      {@const page = pages[path]}
      <a class="wiki-card" href={wikiUrl(path)} target="_blank" rel="noopener noreferrer" title={`wiki:${path}`} data-wiki-card={path} onclick={(e) => open(path, e)}>
        <Icon name="file" size={16} />
        <span class="text">
          <span class="title">{page?.title || fileName(path)}</span>
          <span class="summary">{page?.summary || path}</span>
        </span>
      </a>
    {/each}
  </div>
{/if}

<style>
  .wiki-cards {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 6px;
    max-width: 100%;
  }
  .wiki-card {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    width: min(100%, 440px);
    padding: 9px 12px;
    border-radius: 12px;
    background: var(--surface-panel);
    box-shadow: inset 0 0 0 1px var(--border-standard);
    color: var(--text-standard);
    text-decoration: none;
  }
  .wiki-card:hover {
    box-shadow: inset 0 0 0 1px var(--border-prominent);
  }
  .wiki-card :global(svg) {
    flex: none;
    margin-top: 2px;
    color: var(--accent-link);
  }
  .text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font: var(--text-body-sm);
    font-weight: 500;
  }
  .summary {
    display: -webkit-box;
    overflow: hidden;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    color: var(--text-metadata);
    font: var(--text-caption);
  }
</style>
