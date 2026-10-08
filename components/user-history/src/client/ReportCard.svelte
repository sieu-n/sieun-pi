<script lang="ts">
  import { untrack } from "svelte";
  import { api } from "./api.ts";
  import { store } from "./store.svelte.ts";
  import { clockTime } from "./format.ts";
  import { renderMarkdown, reportExcerpt } from "./markdown.ts";
  import { diagrams } from "./diagrams.ts";
  import { brokenImage, proseClick } from "./prose.ts";
  import { chatLines } from "../shared/chat-feed.ts";
  import { parseArtifactTarget } from "../shared/artifact-link.ts";
  import { triggerBody } from "../shared/turns.ts";
  import { jobName, jobNames, jobStatusText, reportsFor, treeJobs } from "./jobs.ts";
  import { reportWikiPage, wikiUrl } from "./reader.ts";
  import { mentionIndex } from "./board.ts";
  import { place, placementStyle, type Placement } from "./ui/floating.ts";
  import { previewTriggers, type PreviewTrigger } from "./preview.ts";
  import Icon from "./Icon.svelte";

  /**
   * The one report preview card of the page: the latest message a job sent its chat, rendered as the reader renders it (markdown, code,
   * tables, diagrams drawn), cut to its first blocks, under a header with the job's name, the time of the message and how many it sent.
   * "Open full report" and a click on the trigger open the reader. A report that links a wiki page names it ("Full report: <title>"); the
   * reader draws that page under the report, and the small arrow opens it on the wiki. A job that has sent nothing yet shows its status instead. Mounted once
   * in App; `previewTriggers` (preview.ts) decides when it shows and hides. It sits in the top layer like a Floating panel, inside the
   * open modal dialog when the trigger is in one, and never takes focus, so the owner keeps typing while a card is up.
   */
  const WIDTH = 420;
  const BLOCKS = 12;
  let open = $state<PreviewTrigger | null>(null);
  let node: HTMLElement | undefined = $state();
  let placement = $state<Placement | null>(null);
  $effect(() => previewTriggers({ show: trigger => { open = trigger; }, hide: () => { open = null; }, card: () => node ?? null, shown: () => open }));

  const chat = $derived(open?.chat ?? null);
  const entry = $derived(chat ? store.thread(chat) : undefined);
  const snapshot = $derived(entry?.state ?? null);
  const row = $derived(chat ? store.session(chat) : undefined);
  const rowOf = (id: string) => store.session(id);
  const nameOf = (sessionId: string): string | undefined => store.session(sessionId)?.name;
  /** A chat the tab has not opened is subscribed for the card and let go on close, unless it is the one on screen. */
  $effect(() => {
    const id = chat;
    if (!id) return;
    untrack(() => store.open(id));
    return () => { if (store.selectedId !== id) store.release(id); };
  });
  /** The job as the sidebar lists it, for its display name and status; a job the row does not list yet goes by the name the trigger gave. */
  const listed = $derived.by(() => {
    if (!open || !row) return undefined;
    const wanted = open.job;
    return treeJobs(row).find(job => job.open === wanted || job.name === jobName(wanted));
  });
  const name = $derived(listed?.name ?? (open ? jobName(open.job) : ""));
  const reports = $derived(snapshot ? reportsFor(chatLines(snapshot.messages, nameOf), listed?.report ?? name) : []);
  const latest = $derived(reports[0] ?? null);
  /** The snapshot clips a job's message at 2 KiB; the whole text is fetched once per message shown. */
  let full = $state.raw<Record<string, string>>({});
  $effect(() => {
    const id = chat;
    const report = latest;
    if (!id || !report?.clipped || report.id in full) return;
    const clipped = report.clipped;
    let cancelled = false;
    api.part(id, clipped.message, clipped.part).then(result => { if (!cancelled) full = { ...full, [report.id]: triggerBody(result.text) }; }, () => {});
    return () => { cancelled = true; };
  });
  const excerpt = $derived(latest ? reportExcerpt(full[latest.id] ?? latest.body, BLOCKS) : null);
  /** The wiki page the report links, and its title once the page answers (the reader reuses the same answer). */
  const linkedPath = $derived(latest ? reportWikiPage(full[latest.id] ?? latest.body) : null);
  let linkedTitle = $state.raw<{ path: string; title: string } | null>(null);
  $effect(() => {
    const path = linkedPath;
    if (!path) return;
    let cancelled = false;
    api.wikiPage(path).then(page => { if (!cancelled) linkedTitle = { path, title: page.title }; }, () => {});
    return () => { cancelled = true; };
  });
  const linkedName = $derived(linkedPath ? (linkedTitle?.path === linkedPath ? linkedTitle.title : linkedPath.split("/").at(-1) ?? linkedPath) : "");
  const mentions = $derived(chat ? mentionIndex(chat, snapshot?.board, jobNames(row, snapshot, rowOf)) : null);
  const html = $derived(excerpt && chat ? renderMarkdown(excerpt.text, snapshot?.info.cwd ?? "", mentions) : "");
  const count = $derived(reports.length === 1 ? "1 message" : `${reports.length} messages`);

  /** A trigger in the left third of the window (a sidebar row) gets the card at its right, so the card covers no row under it; the rest get it below or above. */
  function position(): void {
    if (!open) return;
    const beside = open.anchor.getBoundingClientRect().right < window.innerWidth / 3;
    placement = place(open.anchor, { width: Math.min(WIDTH, window.innerWidth - 16), maxHeight: Math.round(window.innerHeight * 0.6), beside });
  }
  /** The card mounts in the top layer, inside the open modal dialog when the trigger is in one (everything outside a modal is inert). */
  function float(element: HTMLElement, anchor: HTMLElement) {
    const host = anchor.closest("dialog[open]") ?? document.body;
    host.appendChild(element);
    element.showPopover();
    position();
    window.addEventListener("resize", position);
    return { destroy() { window.removeEventListener("resize", position); if (element.matches(":popover-open")) element.hidePopover(); element.remove(); } };
  }
  $effect(() => { void html; void latest; position(); });

  function openFull(): void {
    if (!open) return;
    const view = { kind: "job" as const, thread: open.chat, name };
    open = null;
    store.reader = view;
  }
  function onProseClick(event: MouseEvent): void {
    const click = proseClick(event);
    const id = chat;
    if (!id || !click || click.kind === "handled" || click.kind === "image") return;
    open = null;
    if (click.kind === "artifact") { const target = parseArtifactTarget(click.target); if (target) store.openArtifact(target, id); }
    else if (click.kind === "mention") store.openPlan(id, click.id);
    else store.openArtifact({ kind: "job", name: click.name }, id);
  }
</script>

{#if open}
  {#key open.anchor}
    <div bind:this={node} class="report-card panel-surface fade-in" popover="manual" role="dialog" aria-label="Report from {name}" use:float={open.anchor}
      style={placement ? placementStyle(placement) + `;max-height:${placement.maxHeight}px` : "opacity:0"}>
      <div class="head">
        <Icon name="bolt" size={12} /><span class="name">{name}</span>
        {#if latest}<span class="sep"></span><span>{clockTime(latest.at)}</span><span class="sep"></span><span>{count}</span>{/if}
      </div>
      {#if entry?.error && !snapshot}<p class="note error">{entry.error}</p>
      {:else if !snapshot}<p class="note"><span class="spinner tiny"></span> Opening</p>
      {:else if !latest}<p class="note">No report yet{#if listed}<span class="sep"></span>{jobStatusText(listed)}{/if}</p>
      {:else}
        <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
        <div class="prose card-prose" onclick={onProseClick} onerrorcapture={brokenImage} use:diagrams={{ html, live: false, eager: true }}>{@html html}</div>
        <div class="bottom">
          {#if linkedPath}
            {@const path = linkedPath}
            <div class="linked">
              <button type="button" class="linked-open" onclick={openFull}><Icon name="book" size={12} /><span class="linked-label">Full report: <span class="linked-title">{linkedName}</span></span></button>
              <button type="button" class="linked-wiki" title="Open on the wiki" aria-label="Open {linkedName} on the wiki" onclick={() => window.open(wikiUrl(path), "_blank", "noopener")}><Icon name="external" size={12} /></button>
            </div>
          {/if}
          <button type="button" class="foot" onclick={openFull}>Open full report{#if excerpt?.cut}<span class="more">, {reports.length > 1 ? "whole message and earlier ones" : "whole message"}</span>{/if}<Icon name="chevronRight" size={12} /></button>
        </div>
      {/if}
    </div>
  {/key}
{/if}

<style>
  .report-card { position: fixed; inset: auto; margin: 0; padding: 0; overflow: auto; overscroll-behavior: contain; font-size: 13px; }
  .head { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 6px; padding: 7px 12px; border-bottom: 1px solid var(--border); background: var(--bg-elevated); font-size: 12px; color: var(--text-muted); white-space: nowrap; }
  .head :global(svg) { color: var(--accent); flex: none; }
  .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; font-weight: 600; color: var(--text); }
  .sep { flex: none; width: 3px; height: 3px; margin: 0 2px; border-radius: 50%; background: currentColor; opacity: 0.6; }
  .note { display: flex; align-items: center; gap: 6px; margin: 0; padding: 12px; color: var(--text-faint); }
  .note.error { color: var(--danger); }
  .card-prose { padding: 10px 12px 6px; font-size: 13px; line-height: 1.45; }
  .card-prose :global(p), .card-prose :global(ul), .card-prose :global(ol), .card-prose :global(blockquote), .card-prose :global(.table-wrap), .card-prose :global(.code-block) { margin: 0 0 0.6em; }
  .card-prose :global(h1), .card-prose :global(h2), .card-prose :global(h3), .card-prose :global(h4) { font-size: 1em; margin: 0.6em 0 0.25em; }
  .card-prose :global(h1:first-child), .card-prose :global(h2:first-child), .card-prose :global(h3:first-child) { margin-top: 0; }
  .card-prose :global(li + li) { margin-top: 0.15em; }
  .card-prose :global(.code-block), .card-prose :global(.table-wrap) { max-width: 100%; }
  .card-prose :global(pre) { padding: 0.6em 0.8em; }
  .card-prose :global(.reply-image) { max-height: 160px; }
  .card-prose :global(.artifact-link) { color: var(--accent); text-decoration: underline; text-decoration-color: color-mix(in srgb, var(--accent) 40%, transparent); text-underline-offset: 0.18em; font: inherit; padding: 0; }
  .bottom { position: sticky; bottom: 0; border-top: 1px solid var(--border); background: var(--bg-elevated); }
  .linked { display: flex; align-items: center; gap: 2px; margin: 6px 8px 0; padding: 2px 2px 2px 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-sunken); font-size: 12.5px; }
  .linked-open { display: flex; flex: 1; min-width: 0; align-items: center; gap: 6px; padding: 4px 0; text-align: left; color: var(--text-muted); }
  .linked-open :global(svg) { flex: none; color: var(--accent); }
  .linked-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .linked-title { font-weight: 600; color: var(--text); }
  .linked-wiki { display: inline-flex; flex: none; padding: 5px; border-radius: 6px; color: var(--text-faint); }
  .linked-wiki:hover, .linked-open:hover .linked-title { color: var(--accent-bold); }
  .linked-wiki:hover { background: var(--bg-hover); }
  .foot { display: flex; align-items: center; gap: 4px; width: 100%; padding: 7px 12px; text-align: left; font-size: 12.5px; font-weight: 500; color: var(--accent-bold); }
  .foot:hover { background: var(--bg-hover); }
  .more { font-weight: 400; color: var(--text-faint); }
</style>
