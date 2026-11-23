<script lang="ts">
  import { untrack } from "svelte";
  import { api, reads, view, type WikiPages } from "$lib/api";
  import { router } from "$lib/router.svelte";
  import { openView } from "$lib/shell/viewer.svelte";
  import { Button, EmptyState, LoadingText, PanelHeader, SearchField } from "$lib/ui";
  import PageRows from "./PageRows.svelte";
  import { WIKI_HOME, withoutFavorites } from "./wiki-pages";

  /**
   * The Wiki view at `#/c/wiki`, Slack's Canvases list for this app's wiki: the favorites and the pages updated last, and a field that finds a
   * page by its title or words (`?q=`, so Back and a reload keep the search). A row opens the page in the viewer beside this list.
   */
  const LIMIT = 50;
  /**
   * How long after an answer the server marked `refreshing` the view asks again: the server's read of the list behind it took 196 to 260 ms
   * on 11-24 and 826 ms at most on the owner's calls of 11-23 (~/work/wiki-page-list/report.md).
   */
  const AGAIN_MS = 1_000;
  type Load = { state: "loading"; last: WikiPages | null } | { state: "ready"; pages: WikiPages } | { state: "error"; message: string };

  const q = $derived(router.route.params.q ?? "");
  let text = $state(untrack(() => router.route.params.q ?? ""));
  /** A search's answer; the list with no words is kept (`recent`) and drawn at once on each open. */
  let load = $state<Load>({ state: "loading", last: null });
  let attempt = $state(0);
  let field = $state<HTMLInputElement>();
  const recent = view(() => (q ? null : reads.wikiPages()));

  // An address that brings new words, such as Cmd K's "See all pages", puts them in the field; typing a space keeps what is typed.
  $effect(() => {
    const words = q;
    if (untrack(() => text.trim()) !== words) text = words;
  });

  $effect(() => {
    const words = q;
    void attempt;
    if (!words) return;
    const controller = new AbortController();
    const before = untrack(() => load);
    load = { state: "loading", last: before.state === "ready" ? before.pages : before.state === "loading" ? before.last : null };
    api.pages({ q: words, limit: LIMIT }, { signal: controller.signal }).then(
      pages => (load = { state: "ready", pages }),
      (error: unknown) => {
        if (!controller.signal.aborted) load = { state: "error", message: error instanceof Error ? error.message : String(error) };
      },
    );
    return () => controller.abort();
  });

  // The server answers the list from its last read and reads the wiki again behind an older one, so an open asks once more for that read.
  $effect(() => {
    if (q) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    void untrack(() => recent.refresh()).then(() => {
      if (!closed && untrack(() => recent.value?.refreshing)) timer = setTimeout(() => void recent.refresh(), AGAIN_MS);
    });
    return () => {
      closed = true;
      clearTimeout(timer);
    };
  });

  const error = $derived(q ? (load.state === "error" ? load.message : null) : recent.value ? null : recent.error);
  const shown = $derived(q ? (load.state === "ready" ? load.pages : load.state === "loading" ? load.last : null) : recent.value);
  /** The rows match what is typed only once the answer for those words is in; until then the last answer stays, dimmed. */
  const stale = $derived(!!q && load.state === "loading" && !!shown);
  const sections = $derived.by(() => {
    if (!shown) return [];
    if (shown.query) return [{ id: "matches", label: `${shown.pages.length === LIMIT ? `${LIMIT}+` : shown.pages.length} ${shown.pages.length === 1 ? "page" : "pages"}`, rows: shown.pages }];
    return [
      ...(shown.favorites.length ? [{ id: "favorites", label: "Favorites", rows: shown.favorites }] : []),
      { id: "recent", label: "Recently updated", rows: withoutFavorites(shown.pages, shown.favorites) },
    ];
  });
  const empty = $derived(!!shown && sections.every(section => !section.rows.length));

  function setText(value: string) {
    text = value;
    router.setParams({ q: value.trim() || null }, { replace: true });
  }

  /** ArrowDown in the field moves to the first page, and the arrows move between pages, as in Slack's lists. */
  function onkeydown(e: KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const links = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLAnchorElement>("[data-wiki-page-row]")];
    if (!links.length) return;
    const at = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (at < 0 && e.key === "ArrowUp") return;
    e.preventDefault();
    if (at === 0 && e.key === "ArrowUp") return field?.focus();
    links[Math.min(links.length - 1, at < 0 ? 0 : at + (e.key === "ArrowDown" ? 1 : -1))]?.focus();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="page" data-testid="wiki-page" {onkeydown}>
  <PanelHeader title="Wiki" icon="file" level={1}>
    {#snippet actions()}
      <Button size="sm" variant="ghost" onclick={() => openView({ kind: "wiki", path: WIKI_HOME })}>Wiki home</Button>
    {/snippet}
  </PanelHeader>
  <div class="field" role="search">
    <SearchField placeholder="Search pages by title or words" label="Search pages" bind:value={() => text, setText} bind:element={field} maxlength={256} />
  </div>
  <div class="scroll">
    {#if error}
      <div class="notice" role="alert">
        <p class="t-body">The wiki did not answer: {error}</p>
        <Button size="sm" onclick={() => (q ? (attempt += 1) : void recent.refresh())}>Try again</Button>
      </div>
    {:else if !shown}
      <div class="notice"><LoadingText text="Loading pages…" /></div>
    {:else if empty}
      <div class="empty" role="status">
        {#if shown.query}
          <EmptyState icon="search" title={`No pages match “${shown.query}”`} description="Try fewer or other words, or browse every folder from the wiki home.">
            {#snippet action()}<Button size="sm" onclick={() => openView({ kind: "wiki", path: WIKI_HOME })}>Open wiki home</Button>{/snippet}
          </EmptyState>
        {:else}
          <EmptyState icon="file" title="No wiki pages yet" description="Pages that agents write and links in posts show up here." />
        {/if}
      </div>
    {:else}
      <div class="sections" class:stale aria-busy={stale}>
        {#each sections as section (section.id)}
          {#if section.rows.length}
            <section aria-labelledby="wiki-{section.id}">
              <h2 id="wiki-{section.id}" class="heading t-caption" data-wiki-section={section.id}>{section.label}</h2>
              <PageRows rows={section.rows} />
            </section>
          {/if}
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .page { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .field { flex: none; padding: var(--space-2) var(--space-panel-inset) var(--space-3); border-bottom: 1px solid var(--border-standard); }
  .scroll { flex: 1; min-height: 0; overflow: auto; }
  .notice { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-panel-inset); }
  .notice p { margin: 0; }
  .empty { display: grid; place-items: center; min-height: 60%; padding: var(--space-page-section-gap) var(--space-panel-inset); }
  .sections { padding: var(--space-1) var(--space-1-5) var(--space-panel-inset); transition: opacity 120ms; }
  .sections.stale { opacity: 0.6; }
  .heading { margin: 0; padding: var(--space-3) var(--space-3) var(--space-1); color: var(--text-subtle); font-weight: 600; }
</style>
