<script lang="ts" module>
  import type { LinkPreview } from "../api/types";

  type PageMeta = { title: string; summary: string } | null;
  /** Each wiki page's title and summary, read once per page load: null while it loads or when the page is gone. */
  const metas = new Map<string, Promise<PageMeta>>();
  /** Each web page's preview from the chat server's `GET /api/unfurl`, read once per page load: null when the page states none. */
  const unfurls = new Map<string, Promise<LinkPreview | null>>();

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

  function readUnfurl(url: string): Promise<LinkPreview | null> {
    let hit = unfurls.get(url);
    if (!hit) {
      hit = fetch(`/api/unfurl?url=${encodeURIComponent(url)}`)
        .then(async (res) => (res.ok ? ((await res.json()) as { preview: LinkPreview | null }).preview : null))
        .catch(() => null);
      unfurls.set(url, hit);
    }
    return hit;
  }
</script>

<script lang="ts">
  import Icon from "./Icon.svelte";
  import { previewLinks, wikiUrl, type PreviewLink } from "./markdown";
  import { whenVisible } from "./mermaid";

  /**
   * One card under a post per link it previews, in the order the text links them. A wiki page shows its title and one-line summary, and a
   * click opens it through `onopen` (the app's page viewer); a Cmd, Ctrl or Shift click opens the wiki in a tab. After
   * legacy/prime/user-history's WikiEmbeds. A web page shows its site, title, description and image, as a Slack unfurl does, and opens in a
   * tab; one that states no title shows no card. Previews load once the post scrolls near the viewport.
   */
  type Props = { text: string; onopen?: (path: string, e: MouseEvent) => void };
  let { text, onopen }: Props = $props();

  const links = $derived(previewLinks(text));
  let root = $state<HTMLElement>();
  let visible = $state(false);
  let pages = $state<Record<string, PageMeta | undefined>>({});
  let webs = $state<Record<string, LinkPreview | null | undefined>>({});

  $effect(() => {
    if (!root || visible) return;
    return whenVisible(root, () => (visible = true));
  });

  $effect(() => {
    if (!visible) return;
    let live = true;
    for (const link of links) {
      if (link.kind === "wiki" && !(link.path in pages)) {
        void readMeta(link.path).then((meta) => {
          if (live) pages = { ...pages, [link.path]: meta };
        });
      } else if (link.kind === "web" && !(link.url in webs)) {
        void readUnfurl(link.url).then((preview) => {
          if (live) webs = { ...webs, [link.url]: preview };
        });
      }
    }
    return () => {
      live = false;
    };
  });

  const fileName = (path: string): string => path.split("/").filter(Boolean).at(-1) ?? path;
  const key = (link: PreviewLink): string => (link.kind === "wiki" ? `wiki:${link.path}` : link.url);
  const hostOf = (url: string): string => new URL(url).hostname;

  function open(path: string, e: MouseEvent) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0 || !onopen) return;
    e.preventDefault();
    onopen(path, e);
  }
</script>

{#if links.length}
  <div class="link-cards" bind:this={root} data-link-cards>
    {#each links as link (key(link))}
      {#if link.kind === "wiki"}
        {@const page = pages[link.path]}
        <a class="link-card" href={wikiUrl(link.path)} target="_blank" rel="noopener noreferrer" title={`wiki:${link.path}`} data-wiki-card={link.path} onclick={(e) => open(link.path, e)}>
          <span class="mark"><Icon name="file" size={16} /></span>
          <span class="text">
            <span class="title">{page?.title || fileName(link.path)}</span>
            <span class="summary">{page?.summary || link.path}</span>
          </span>
        </a>
      {:else if webs[link.url]}
        {@const preview = webs[link.url]!}
        <a class="link-card web" href={link.url} target="_blank" rel="noopener noreferrer" title={link.url} data-web-card={link.url}>
          <span class="mark"><img class="favicon" src={`https://${hostOf(link.url)}/favicon.ico`} alt="" width="16" height="16" loading="lazy" onerror={(e) => ((e.currentTarget as HTMLImageElement).style.visibility = "hidden")} /></span>
          <span class="text">
            <span class="site">{preview.site}</span>
            <span class="title">{preview.title}</span>
            {#if preview.description}<span class="summary">{preview.description}</span>{/if}
          </span>
          {#if preview.image}<img class="thumb" src={preview.image} alt="" loading="lazy" onerror={(e) => (e.currentTarget as HTMLImageElement).remove()} />{/if}
        </a>
      {/if}
    {/each}
  </div>
{/if}

<style>
  .link-cards {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 6px;
    max-width: 100%;
  }
  .link-card {
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
  .link-card:hover {
    box-shadow: inset 0 0 0 1px var(--border-prominent);
  }
  .mark {
    display: flex;
    flex: none;
    margin-top: 2px;
    color: var(--accent-link);
  }
  .favicon {
    border-radius: 3px;
  }
  .text {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .site {
    color: var(--text-metadata);
    font: var(--text-caption);
    letter-spacing: var(--tracking-caption);
  }
  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font: var(--text-body-sm);
    font-weight: 500;
  }
  .web .title {
    color: var(--text-message-link, var(--accent-link));
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
  .thumb {
    flex: none;
    width: 72px;
    height: 72px;
    border-radius: 8px;
    object-fit: cover;
    background: var(--surface-inset);
  }
</style>
