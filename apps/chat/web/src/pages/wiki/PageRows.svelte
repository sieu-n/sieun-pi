<script lang="ts">
  import type { WikiPageRow } from "$lib/api";
  import { hrefFor, router } from "$lib/router.svelte";
  import { openView } from "$lib/shell/viewer.svelte";
  import Icon from "$lib/ui/Icon.svelte";
  import { shortAge } from "$pages/search/hit-view";
  import { pagePlace } from "./wiki-pages";

  /**
   * A list of wiki pages, one row each with its title, description, place and age, as the Wiki view and the search page's Pages tab show
   * them. A plain click opens the page in the viewer over the page under it; Cmd or Ctrl click keeps the link's own new tab.
   */
  type Props = { rows: readonly WikiPageRow[]; label?: string };
  let { rows, label }: Props = $props();

  const viewHref = (path: string) => hrefFor(router.route.page, router.route.rest, { ...router.route.params, view: `wiki:${path}` });

  function open(e: MouseEvent, path: string) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    openView({ kind: "wiki", path });
  }

  /** When the page last changed, as Cmd K stamps a hit: "3h", "Yesterday", "Mon", "Sep 2". */
  const updated = (row: WikiPageRow) => {
    const at = Date.parse(row.updated);
    return Number.isFinite(at) ? `Updated ${shortAge(at, new Date())}` : "";
  };
</script>

<ul class="rows" aria-label={label}>
  {#each rows as row (row.path)}
    <li>
      <a class="row" href={viewHref(row.path)} onclick={e => open(e, row.path)} data-wiki-page-row={row.path}>
        <span class="icon"><Icon name="file" size={18} /></span>
        <span class="main">
          <span class="title t-label-sm">{row.title}</span>
          {#if row.description}<span class="desc t-body-sm">{row.description}</span>{/if}
          <span class="meta t-caption">{[pagePlace(row.path), updated(row)].filter(Boolean).join(" · ")}</span>
        </span>
      </a>
    </li>
  {/each}
</ul>

<style>
  .rows { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
  .row { display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: var(--space-3); padding: 10px var(--space-3); color: inherit; text-decoration: none; border-radius: var(--radius-row); }
  .row:hover, .row:focus-visible { background: var(--neutral-3); }
  .icon { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 8px; background: var(--neutral-3); color: var(--text-subtle); }
  .main { display: grid; gap: 2px; min-width: 0; }
  .title { color: var(--text-standard); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .desc { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; max-inline-size: 80ch; color: var(--text-standard); }
  .meta { color: var(--text-metadata); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
