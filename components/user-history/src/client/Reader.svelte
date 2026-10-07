<script lang="ts">
  import { untrack } from "svelte";
  import { api, type LocalFile, type WikiPage } from "./api.ts";
  import { store } from "./store.svelte.ts";
  import { clockTime } from "./format.ts";
  import { renderMarkdown, renderInline } from "./markdown.ts";
  import { diagrams } from "./diagrams.ts";
  import { brokenImage, proseClick } from "./prose.ts";
  import { chatFeed, chatLines, updatesLabel, type ChatItem, type ChatLine, type Update } from "../shared/chat-feed.ts";
  import { parseArtifactTarget } from "../shared/artifact-link.ts";
  import { createdSessions } from "./children.ts";
  import { findJob, jobName, jobViews, reportsFor, type JobReport } from "./jobs.ts";
  import { triggerBody } from "../shared/turns.ts";
  import { anchorStamp, permalink } from "./permalink.ts";
  import { diffLines, wikiBlocks, wikiUrl, type ReaderView } from "./reader.ts";
  import type { ChildUsage } from "../shared/types.ts";
  import Modal from "./Modal.svelte";
  import Icon, { type IconName } from "./Icon.svelte";
  import Lightbox from "./ui/Lightbox.svelte";

  /**
   * The one place an artifact opens: a job's latest report with its earlier messages behind a fold, a text file (markdown rendered, a diff
   * with line colors, code with line numbers), a wiki page's text through the service, one message of a thread, or a folded run of a chat's
   * updates as a list (who wrote, when, the whole text; the chat's own hidden text as "VP notes"). The header names the source, copies a
   * link that pastes back as a note link, and offers the way to the full thing (the job's thread, the wiki, the message).
   */
  let { view, narrow, onclose }: { view: ReaderView; narrow: boolean; onclose: () => void } = $props();

  const ICON: Record<ReaderView["kind"], IconName> = { job: "bolt", file: "file", wiki: "book", message: "message", updates: "list" };
  const thread = $derived(view.kind === "job" || view.kind === "message" || view.kind === "updates" ? view.thread : null);
  const snapshot = $derived(thread ? store.thread(thread)?.state ?? null : null);
  const entry = $derived(thread ? store.thread(thread) : undefined);
  const cwd = $derived(snapshot?.info.cwd ?? "");
  /** A message of another thread needs that thread open; it is let go on close unless it is the one on screen. */
  $effect(() => {
    const id = thread;
    if (!id) return;
    untrack(() => store.open(id));
    return () => { if (store.selectedId !== id) store.release(id); };
  });
  const nameOf = (sessionId: string): string | undefined => store.session(sessionId)?.name;
  const lines = $derived(snapshot ? chatLines(snapshot.messages, nameOf) : []);
  /** The folded run the chat line opened, found by the time of its first line. */
  const updates = $derived.by((): Extract<ChatItem, { kind: "updates" }> | null => {
    if (view.kind !== "updates" || !snapshot) return null;
    const at = view.at;
    return chatFeed(snapshot, [], nameOf).find((item): item is Extract<ChatItem, { kind: "updates" }> => item.kind === "updates" && item.at === at) ?? null;
  });

  const reports = $derived(view.kind === "job" ? reportsFor(lines, view.name) : []);
  const latest = $derived(reports[0] ?? null);
  const earlier = $derived(reports.slice(1));
  let earlierOpen = $state(false);
  let usage = $state<ChildUsage[]>([]);
  const message = $derived.by((): ChatLine | null => {
    if (view.kind !== "message" || !lines.length) return null;
    const at = anchorStamp(lines.map(line => line.at), view.at);
    return lines.find(line => line.at === at) ?? null;
  });
  /** The snapshot clips a job's message at 2 KiB; the full text of each one on screen is fetched once and shown instead. */
  let full = $state.raw<Record<string, string>>({});
  const shown = $derived.by((): JobReport[] => view.kind === "job" ? [...(latest ? [latest] : []), ...(earlierOpen ? earlier : [])]
    : view.kind === "updates" ? (updates?.entries ?? []).filter((entry): entry is JobReport => entry.kind === "job") : message?.kind === "job" ? [message] : []);
  const body = (report: JobReport): string => full[report.id] ?? report.body;
  const fetching = new Set<string>();
  $effect(() => {
    const id = thread;
    if (!id) return;
    for (const report of shown) {
      const clipped = report.clipped;
      if (!clipped || report.id in full || fetching.has(report.id)) continue;
      fetching.add(report.id);
      api.part(id, clipped.message, clipped.part).then(result => { full = { ...full, [report.id]: triggerBody(result.text) }; }, () => {}).finally(() => fetching.delete(report.id));
    }
  });
  /** The job behind what is shown (the job itself, or a job's message), so the header can open its thread. */
  const jobOf = $derived(view.kind === "job" ? view.name : message?.kind === "job" ? message.from : null);
  $effect(() => {
    const id = thread;
    if (!id || !jobOf) return;
    let cancelled = false;
    api.childUsage(id).then(entries => { if (!cancelled) usage = entries; }, () => {});
    return () => { cancelled = true; };
  });
  const jobSession = $derived.by(() => {
    if (!jobOf || !snapshot) return null;
    return findJob(jobViews(snapshot.children, createdSessions(snapshot.messages), usage, id => store.session(id)), jobOf)?.sessionId ?? null;
  });

  let file = $state.raw<{ path: string; result: LocalFile | null; error: string | null } | null>(null);
  $effect(() => {
    if (view.kind !== "file") { file = null; return; }
    const path = view.path;
    const loading = { path, result: null, error: null };
    file = loading;
    api.localFile(path).then(result => { if (file === loading) file = { path, result, error: null }; },
      error => { if (file === loading) file = { path, result: null, error: error instanceof Error ? error.message : String(error) }; });
  });
  let wiki = $state.raw<{ path: string; result: WikiPage | null; error: string | null } | null>(null);
  $effect(() => {
    if (view.kind !== "wiki") { wiki = null; return; }
    const path = view.path;
    const loading = { path, result: null, error: null };
    wiki = loading;
    api.wikiPage(path).then(result => { if (wiki === loading) wiki = { path, result, error: null }; },
      error => { if (wiki === loading) wiki = { path, result: null, error: error instanceof Error ? error.message : String(error) }; });
  });

  const fileName = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;
  const title = $derived.by(() => {
    switch (view.kind) {
      case "job": return jobName(view.name);
      case "file": return fileName(view.path);
      case "wiki": return wiki?.result?.title ?? fileName(view.path);
      case "message": return message ? (message.kind === "user" ? "You" : message.kind === "job" ? "From " + message.from : message.kind === "agent" ? store.session(view.thread)?.name ?? "Chat" : message.kind === "notes" ? "VP notes" : "Notice") + ", " + clockTime(message.at) : "Message";
      case "updates": return updates ? updatesLabel(updates).count : "Updates";
    }
  });
  const span = (entries: readonly Update[]): string => {
    const first = entries[0];
    const last = entries.at(-1);
    return first && last ? (first === last ? clockTime(first.at) : clockTime(first.at) + " to " + clockTime(last.at)) : "";
  };
  const source = $derived.by(() => {
    switch (view.kind) {
      case "job": return latest ? "Sent to the chat at " + clockTime(latest.at) + (reports.length > 1 ? `, ${reports.length} messages` : "") : "job:" + view.name;
      case "file": return view.path;
      case "wiki": return wikiUrl(view.path);
      case "message": return (store.session(view.thread)?.name ?? view.thread) + (message ? ", " + new Date(message.at).toLocaleString() : "");
      case "updates": return (store.session(view.thread)?.name ?? view.thread) + (updates ? ", " + span(updates.entries) : "");
    }
  });
  /** What Copy link puts on the clipboard: a form the Add a note field turns back into the same link. */
  const link = $derived.by(() => {
    switch (view.kind) {
      case "job": return latest ? permalink(view.thread, latest.at) : null;
      case "file": return view.path;
      case "wiki": return wikiUrl(view.path);
      case "message": return permalink(view.thread, view.at);
      case "updates": return permalink(view.thread, view.at);
    }
  });
  async function copyLink(): Promise<void> {
    if (!link) return;
    try { await navigator.clipboard.writeText(link); store.toast("Link copied", "info"); } catch { store.toast("Could not copy the link", "info"); }
  }
  type Action = { label: string; run: () => void };
  const fullThread = $derived.by((): Action | null => { const id = jobSession; return id ? { label: "Open full thread", run: () => { onclose(); store.select(id); } } : null; });
  const actions = $derived.by((): Action[] => {
    switch (view.kind) {
      case "job": return fullThread ? [fullThread] : [];
      case "file": return [];
      case "wiki": { const url = wikiUrl(view.path); return [{ label: "Open in wiki", run: () => window.open(url, "_blank", "noopener") }]; }
      case "message": {
        const { thread: id, at } = view;
        return [...(fullThread ? [fullThread] : []), { label: "Go to message", run: () => { onclose(); store.select(id, at); } }];
      }
      case "updates": return [];
    }
  });

  let image = $state<{ src: string; alt: string } | null>(null);
  function onProseClick(event: MouseEvent): void {
    const click = proseClick(event);
    if (click?.kind === "image") image = { src: click.src, alt: click.alt };
    else if (click?.kind === "artifact") { const target = parseArtifactTarget(click.target); if (target) store.openArtifact(target, thread ?? store.selectedId ?? ""); }
  }
  const dirOf = (path: string) => path.replace(/\/[^/]*$/, "");
</script>

{#snippet prose(text: string, base: string)}
  <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
  <div class="prose reader-prose" onclick={onProseClick} onerrorcapture={brokenImage} use:diagrams={{ html: renderMarkdown(text, base), live: false }}>{@html renderMarkdown(text, base)}</div>
{/snippet}

{#snippet loading()}<p class="snapshot"><span class="spinner tiny"></span> Opening</p>{/snippet}
{#snippet failure(text: string)}<p class="snapshot error">{text}</p>{/snippet}

<Modal {title} icon={ICON[view.kind]} width="min(960px, 92vw)" tall full={narrow} {onclose}>
  {#snippet header()}
    <span class="source" title={source}>{source}</span>
    <span class="actions">
      {#if link}<button type="button" class="button small" onclick={() => void copyLink()}><Icon name="link" size={12} />Copy link</button>{/if}
      {#each actions as action (action.label)}<button type="button" class="button small" onclick={action.run}>{action.label}</button>{/each}
    </span>
  {/snippet}
  <div class="reader {view.kind}">
    {#if view.kind === "job"}
      {#if entry?.error && !snapshot}{@render failure(entry.error)}
      {:else if !snapshot}{@render loading()}
      {:else if !latest}<p class="snapshot">This job has sent nothing to the chat yet.</p>
      {:else}
        {@render prose(body(latest), cwd)}
        {#if earlier.length}
          <button type="button" class="fold" aria-expanded={earlierOpen} onclick={() => { earlierOpen = !earlierOpen; }}>
            <span class="chev" class:open={earlierOpen}><Icon name="chevronDown" size={12} /></span>{earlier.length} earlier {earlier.length === 1 ? "message" : "messages"}
          </button>
          {#if earlierOpen}
            {#each earlier as report (report.id)}
              <article class="earlier">
                <div class="stamp">{clockTime(report.at)}</div>
                {@render prose(body(report), cwd)}
              </article>
            {/each}
          {/if}
        {/if}
      {/if}
    {:else if view.kind === "file"}
      {#if !file || file.path !== view.path || (!file.result && !file.error)}{@render loading()}
      {:else if file.error}{@render failure(file.error)}
      {:else if file.result}
        {@const result = file.result}
        {#if result.kind === "markdown"}{@render prose(result.text, dirOf(result.path))}
        {:else if result.kind === "diff"}
          <pre class="lines diff">{#each diffLines(result.text) as line, index (index)}<span class="line {line.kind}">{line.text}{"\n"}</span>{/each}</pre>
        {:else}
          <pre class="lines code" data-language={result.language}>{#each result.text.replace(/\n$/, "").split("\n") as line, index (index)}<span class="line"><span class="num">{index + 1}</span>{line}{"\n"}</span>{/each}</pre>
        {/if}
      {/if}
    {:else if view.kind === "wiki"}
      {#if !wiki || wiki.path !== view.path || (!wiki.result && !wiki.error)}{@render loading()}
      {:else if wiki.error}{@render failure(wiki.error)}
      {:else if wiki.result}
        <div class="wiki-text">
          {#each wikiBlocks(wiki.result.text, wiki.result.headings) as block, index (index)}
            {#if block.kind === "heading"}<h3>{block.text}</h3>{:else}<p>{block.text}</p>{/if}
          {/each}
        </div>
      {/if}
    {:else if view.kind === "message"}
      {#if entry?.error && !snapshot}{@render failure(entry.error)}
      {:else if !snapshot}{@render loading()}
      {:else if !message}<p class="snapshot">That link points at a message this thread does not have.</p>
      {:else if message.kind === "user"}<div class="said">{@html renderInline(message.text)}</div>
      {:else if message.kind === "agent" || message.kind === "notes"}{@render prose(message.text, cwd)}
      {:else if message.kind === "job"}{@render prose(body(message), cwd)}
      {:else}<p class="snapshot">{message.text}</p>{/if}
    {:else if view.kind === "updates"}
      {#if entry?.error && !snapshot}{@render failure(entry.error)}
      {:else if !snapshot}{@render loading()}
      {:else if !updates}<p class="snapshot">These updates are no longer in the chat.</p>
      {:else}
        {#each updates.entries as update (update.id)}
          <article class="update {update.kind}">
            <div class="update-head"><span class="update-from">{update.kind === "job" ? update.from : "VP notes"}</span><span class="stamp">{clockTime(update.at)}</span></div>
            {@render prose(update.kind === "job" ? body(update) : update.text, cwd)}
          </article>
        {/each}
      {/if}
    {/if}
  </div>
</Modal>
{#if image}
  <Lightbox images={[image]} index={0} onclose={() => { image = null; }} />
{/if}

<style>
  .source { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); font-size: 11.5px; color: var(--text-faint); }
  .actions { display: flex; flex: none; align-items: center; gap: 6px; }
  .actions .button { display: inline-flex; align-items: center; gap: 5px; }
  .reader { padding: 16px 24px 32px; font-size: 14px; }
  .snapshot { display: flex; align-items: center; gap: 8px; margin: 0; padding: 8px 0; color: var(--text-faint); font-size: 13px; }
  .snapshot.error { color: var(--danger); }
  .reader-prose { font-size: 14.5px; }
  .reader-prose :global(.artifact-link) { color: var(--accent); text-decoration: underline; text-decoration-color: color-mix(in srgb, var(--accent) 40%, transparent); text-underline-offset: 0.18em; font: inherit; padding: 0; }
  .fold { display: inline-flex; align-items: center; gap: 5px; margin-top: 18px; padding: 3px 6px 3px 2px; border-radius: 4px; font-size: 12.5px; color: var(--text-faint); }
  .fold:hover { color: var(--text); background: var(--bg-hover); }
  .chev { display: inline-flex; transform: rotate(-90deg); transition: transform 0.12s; }
  .chev.open { transform: none; }
  .earlier { margin-top: 12px; padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-sunken); }
  .stamp { margin-bottom: 6px; font-size: 11px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
  .update { padding: 12px 0 14px; border-top: 1px solid var(--border); }
  .update:first-child { padding-top: 0; border-top: 0; }
  .update-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; }
  .update-head .stamp { margin: 0; }
  .update-from { font-size: 13px; font-weight: 600; color: var(--text); }
  .update.notes .update-from { color: var(--accent-bold); }
  .lines { margin: 0; font-family: var(--mono); font-size: 12.5px; line-height: 1.55; white-space: pre; overflow-x: auto; tab-size: 4; }
  .line { display: block; }
  .diff .add { background: color-mix(in srgb, var(--success) 14%, transparent); color: light-dark(#0a5a2a, #8fe3ad); }
  .diff .del { background: color-mix(in srgb, var(--danger) 12%, transparent); color: light-dark(#8a1c1c, #f2a0a0); }
  .diff .file { font-weight: 600; margin-top: 0.8em; color: var(--text); }
  .diff .hunk { color: var(--accent-bold); background: var(--accent-soft); }
  .diff .meta { color: var(--text-faint); }
  .code .num { display: inline-block; width: 3.2em; margin-right: 1em; text-align: right; color: var(--text-faint); user-select: none; }
  .wiki-text h3 { margin: 1.4em 0 0.4em; font-size: 15px; font-weight: 600; }
  .wiki-text h3:first-child { margin-top: 0; }
  .wiki-text p { margin: 0 0 0.8em; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
  .said { line-height: 1.5; overflow-wrap: anywhere; }
  .said :global(code) { font-family: var(--mono); font-size: 0.88em; background: var(--bg-sunken); border: 1px solid var(--border); padding: 0.08em 0.35em; border-radius: 5px; }
  @container app (max-width: 899px) {
    .reader { padding: 12px 14px 32px; }
    .source { display: none; }
  }
</style>
