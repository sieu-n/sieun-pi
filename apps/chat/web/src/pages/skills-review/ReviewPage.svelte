<script lang="ts">
  import { tick, untrack } from "svelte";
  import { api } from "$lib/api";
  import { live } from "$lib/api/live.svelte";
  import type { ReviewItem, ReviewReport, ReviewResult } from "$lib/api/shared/skills-review";
  import { hrefFor, router } from "$lib/router.svelte";
  import { Badge, Button, EmptyState, IconButton, LoadingText, Meter, Page, PanelHeader, Select, toast } from "$lib/ui";
  import CopyCard from "./CopyCard.svelte";
  import {
    COMMANDS, STATUS_TONE, agoText, commandFor, editOf, editProblem, macText, neighbor, nextPending, overridesOf, pickItem, sizeText, statesText,
    type Command, type Edit,
  } from "./model";

  /**
   * Skills review: the cleanup items of the skills inventory one per screen, at #/settings/skills/review?set=&item=, so the owner decides
   * each with a key (For you todo t4, msg mwqukzwx). Approve applies the item's actions at once on the server (server/skills-review.ts),
   * Keep and Skip only record his choice, and Undo puts the last decision back. Change target edits a copy's action or fold target, and the
   * edits go along with Approve as overrides. The `skills-review` live event rereads the open item, and the `skills` event the whole set
   * after a scan.
   */
  let report = $state<ReviewReport | null>(null);
  let item = $state<ReviewItem | null>(null);
  let error = $state<string | null>(null);
  let itemError = $state<string | null>(null);
  let busy = $state<Command | null>(null);
  let editing = $state(false);
  let edits = $state<Record<string, Edit>>({});
  let scanning = $state(false);
  let names = $state<string[]>([]);
  let now = $state(Date.now());
  /** The items decided on this page, newest last, so Undo on an undecided item puts back the last one. */
  let decided = $state<string[]>([]);
  let page = $state<HTMLElement | undefined>();
  const suggestions = "skills-review-names";

  /** The set the address names; without one the server answers with its default set. */
  const wantedSet = $derived(router.route.params.set || undefined);
  const reportSet = $derived(report?.set ?? null);
  const items = $derived(report?.items ?? []);
  const current = $derived(pickItem(items, router.route.params.item));
  const position = $derived(items.findIndex(entry => entry.id === current) + 1);
  const counts = $derived(report?.counts ?? null);
  const done = $derived(counts ? counts.items - counts.pending : 0);
  const keeper = $derived(item?.copyRows.find(copy => copy.keeper) ?? null);
  const problem = $derived(item && editing ? editProblem(item.copyRows, edits) : null);
  const queuedCopies = $derived(item?.copyRows.filter(copy => copy.state === "queued").length ?? 0);

  /** Reads the set's list; a slow answer for another set is dropped. */
  async function readReport(): Promise<void> {
    const asked = wantedSet;
    try {
      const next = await api.skillsReview(asked);
      if (asked !== wantedSet) return;
      report = next;
      error = null;
      now = Date.now();
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
    }
  }

  /** Bumped by every decide or undo answer, so a read that started before it cannot put the older item back. */
  let shown = 0;

  /** Reads one item; an answer for an item the owner already left, or older than a decision, is dropped. */
  async function readItem(setName: string, id: string): Promise<void> {
    const at = shown;
    try {
      const next = await api.skillsReviewItem(setName, id);
      if (id !== current || at !== shown) return;
      if (item?.id !== id) resetEdits();
      item = next;
      itemError = null;
    } catch (reason) {
      if (id === current && at === shown) itemError = reason instanceof Error ? reason.message : String(reason);
    }
  }

  function resetEdits(): void {
    editing = false;
    edits = {};
  }

  $effect(() => {
    void wantedSet;
    untrack(() => void readReport());
  });

  $effect(() => {
    const id = current;
    const setName = reportSet;
    if (!id || !setName) return;
    if (router.route.params.item !== id) router.setParams({ item: id }, { replace: true });
    untrack(() => void readItem(setName, id));
  });

  $effect(() => {
    const off = live.on(event => {
      if (event.type === "skills-review") {
        if (report && event.set !== report.set) return;
        void readReport();
        if (current && (event.id === null || event.id === current) && !busy) void readItem(event.set, current);
      } else if (event.type === "skills") {
        scanning = event.scan.running;
        if (!event.scan.running) {
          void readReport();
          if (current && report) void readItem(report.set, current);
        }
      }
    });
    const timer = setInterval(() => (now = Date.now()), 60_000);
    return () => {
      off();
      clearInterval(timer);
    };
  });

  function go(id: string | null): void {
    if (!id || id === current) return;
    resetEdits();
    router.setParams({ item: id }, { replace: true });
    page?.querySelector<HTMLElement>(`[data-jump="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
  }

  /** Puts a decide or undo answer on the screen: the item, the list counts and the item's row in the list. */
  function show(result: ReviewResult): void {
    shown++;
    item = result.item;
    if (report) {
      const summary = result.item;
      report = {
        ...report,
        counts: result.counts,
        items: report.items.map(entry => (entry.id === summary.id ? { ...entry, status: summary.status, queued: summary.queued, toAct: summary.toAct } : entry)),
      };
    }
  }

  async function decide(action: "approve" | "keep" | "skip"): Promise<void> {
    if (!report || !item || busy) return;
    if (action === "approve" && problem) {
      toast.error(problem);
      return;
    }
    const id = item.id;
    const title = item.title;
    const overrides = action === "approve" && editing ? overridesOf(item.copyRows, edits) : {};
    busy = action;
    try {
      const result = await api.decideSkillsReview({ set: report.set, id, action, ...(Object.keys(overrides).length ? { overrides } : {}) });
      show(result);
      resetEdits();
      decided = [...decided.filter(entry => entry !== id), id];
      const verb = action === "approve" ? "Approved" : action === "keep" ? "Kept" : "Skipped";
      const states = action === "approve" ? statesText(result.item) : "";
      const failed = result.item.copyRows.some(copy => copy.state === "failed");
      const text = `${verb} ${title}${states ? `: ${states}` : ""}`;
      const undo = { label: "Undo", run: () => void undoItem(id) };
      if (failed) toast.error(text, { action: undo });
      else toast.success(text, { action: undo, duration: 6000 });
      if (!failed) {
        const next = report ? nextPending(report.items, id) : null;
        if (next) go(next);
        else toast.show("Every item has a decision");
      }
    } catch (reason) {
      toast.error(`${title}: ${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      busy = null;
    }
  }

  async function undoItem(id: string): Promise<void> {
    if (!report || busy) return;
    busy = "undo";
    try {
      go(id);
      const result = await api.undoSkillsReview({ set: report.set, id });
      show(result);
      decided = decided.filter(entry => entry !== id);
      toast.show(`Undid ${result.item.title}`);
    } catch (reason) {
      toast.error(`Undo failed: ${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      busy = null;
    }
  }

  function undo(): void {
    const id = item?.decision ? item.id : decided.at(-1);
    if (id) void undoItem(id);
    else toast.show("Nothing to undo here");
  }

  async function toggleTarget(): Promise<void> {
    if (!item) return;
    if (editing) {
      resetEdits();
      return;
    }
    edits = Object.fromEntries(item.copyRows.map(copy => [copy.id, editOf(copy)]));
    editing = true;
    if (names.length === 0) void loadNames();
    await tick();
    page?.querySelector<HTMLElement>("[data-testid='copy-edit'] select")?.focus();
  }

  async function loadNames(): Promise<void> {
    try {
      const skills = (await api.skills()).skills;
      names = [...new Set(skills.map(entry => entry.name))].sort((a, b) => a.localeCompare(b));
    } catch {
      names = [];
    }
  }

  async function scan(): Promise<void> {
    try {
      scanning = (await api.scanSkills()).scan.running;
    } catch (reason) {
      toast.error(`Scan failed to start: ${reason instanceof Error ? reason.message : String(reason)}`);
    }
  }

  function run(command: Command): void {
    if (command === "approve" || command === "keep" || command === "skip") void decide(command);
    else if (command === "undo") undo();
    else if (command === "target") void toggleTarget();
    else go(neighbor(items, current, command === "next" ? 1 : -1));
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented) return;
    const field = (event.target as Element | null)?.closest?.("input, textarea, select");
    if (event.key === "Escape" && editing) {
      event.preventDefault();
      if (field) (field as HTMLElement).blur();
      else resetEdits();
      return;
    }
    const command = commandFor(event);
    if (!command || !report) return;
    event.preventDefault();
    run(command);
  }

  function pickSet(next: string): void {
    resetEdits();
    item = null;
    router.setParams({ set: next, item: null }, { replace: true });
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#snippet key(command: Command)}<kbd>{COMMANDS[command].key}</kbd>{/snippet}

<div class="host" bind:this={page}>
  <Page measure="wide">
    {#snippet header()}
      <PanelHeader title="Review skills cleanup" icon="spark" level={1}>
        {#snippet actions()}
          <Button variant="ghost" size="sm" icon="arrow-left" href={hrefFor("settings", ["skills"])}>Skills</Button>
          <IconButton icon="refresh" label={scanning ? "Scanning the boxes" : "Scan again"} size="sm" loading={scanning} onclick={() => void scan()} />
        {/snippet}
      </PanelHeader>
    {/snippet}

    {#if !report && error}
      <EmptyState icon="spark" title="The review isn't available" description={error}>
        {#snippet action()}<Button variant="outline" size="sm" onclick={() => void readReport()}>Try again</Button>{/snippet}
      </EmptyState>
    {:else if !report}
      <LoadingText text="Reading the review…" />
    {:else if items.length === 0}
      <EmptyState icon="check" title="Nothing to review" description="No skill copy in this inventory is marked to merge or remove." />
    {:else}
      <div class="frame"><div class="layout">
        <nav class="jump" aria-label="Review items">
          <ol>
            {#each items as entry (entry.id)}
              <li>
                <button type="button" class="jump-row" class:current={entry.id === current} aria-current={entry.id === current ? "true" : undefined} data-jump={entry.id} data-status={entry.status} onclick={() => go(entry.id)}>
                  <Badge dot tone={STATUS_TONE[entry.status]} title={entry.status} />
                  <span class="jump-title">{entry.title}</span>
                  <span class="jump-count">{entry.toAct}</span>
                </button>
              </li>
            {/each}
          </ol>
        </nav>

        <div class="main">
          <section class="progress" aria-label="Progress">
            <div class="progress-line">
              <span class="nav">
                <Button size="sm" variant="ghost" icon="arrow-up" disabled={position <= 1} aria-keyshortcuts="k" onclick={() => run("previous")}>Previous {@render key("previous")}</Button>
                <span class="position" data-testid="review-position">{position} of {items.length}</span>
                <Button size="sm" variant="ghost" icon="arrow-down" disabled={position >= items.length} aria-keyshortcuts="j" onclick={() => run("next")}>Next {@render key("next")}</Button>
              </span>
              <span class="tallies" data-testid="review-counts">{counts?.approved ?? 0} approved · {counts?.kept ?? 0} kept · {counts?.skipped ?? 0} skipped · {counts?.pending ?? 0} pending</span>
            </div>
            <Meter percent={counts && counts.items > 0 ? (done / counts.items) * 100 : 0} label="Decided" value={`${done} of ${counts?.items ?? 0}`} warn={101} danger={101} compact />
            <p class="meta">
              {#if report.sets.length > 1}<Select size="sm" label="Review set" value={report.set} options={report.sets.map(name => ({ value: name, label: name }))} onchange={pickSet} />{/if}
              <span>Inventory scanned {report.generatedAt ? agoText(Date.parse(report.generatedAt), now) : "at an unknown time"}{scanning ? ", a scan runs now" : ""}</span>
              <span data-testid="review-mac">{macText(report.mac)}</span>
            </p>
          </section>

          {#if item && item.id === current}
            <section class="item" aria-labelledby="review-title" data-testid="review-item" data-item={item.id} data-status={item.status}>
              <header class="item-head">
                <h2 id="review-title">{item.title}</h2>
                <Badge tone={STATUS_TONE[item.status]}>{item.status}</Badge>
                <Badge tone="outline">{item.unit}</Badge>
                {#if item.group}<span class="group">{item.group}</span>{/if}
              </header>
              <p class="summary">
                {item.copies} {item.copies === 1 ? "copy" : "copies"} on {item.boxes.join(" and ")}, {item.toAct} to act on, {sizeText(item.bytes)} to free.
                {#if item.decision}Last decision: {item.decision.action}, {agoText(Date.parse(item.decision.at), now)}.{/if}
                {#if queuedCopies > 0}{queuedCopies} {queuedCopies === 1 ? "copy waits" : "copies wait"} for the Mac.{/if}
              </p>
              {#if item.description}<p class="description">{item.description}</p>{/if}

              <div class="controls" role="toolbar" aria-label="Decide this item">
                <Button variant="primary" size="sm" loading={busy === "approve"} disabled={!!problem} aria-keyshortcuts="a" onclick={() => run("approve")}>Approve {@render key("approve")}</Button>
                <Button size="sm" loading={busy === "keep"} aria-keyshortcuts="e" onclick={() => run("keep")}>Keep {@render key("keep")}</Button>
                <Button size="sm" loading={busy === "skip"} aria-keyshortcuts="s" onclick={() => run("skip")}>Skip {@render key("skip")}</Button>
                <Button size="sm" variant={editing ? "accent" : "outline"} aria-pressed={editing} aria-keyshortcuts="t" onclick={() => run("target")}>Change target {@render key("target")}</Button>
                <Button size="sm" variant="ghost" loading={busy === "undo"} aria-keyshortcuts="u" onclick={() => run("undo")}>Undo {@render key("undo")}</Button>
              </div>
              {#if editing}<p class="hint" role="status">{problem ?? "Set each copy's action, then Approve applies them. Esc leaves a field, and Esc again drops the changes."}</p>{/if}

              <div class="copies">
                {#each item.copyRows as copy (copy.id)}
                  <CopyCard
                    {copy}
                    diff={item.diffs[copy.id]}
                    text={item.texts[copy.id]}
                    hasKeeper={keeper !== null}
                    {editing}
                    edit={edits[copy.id] ?? editOf(copy)}
                    onedit={next => (edits = { ...edits, [copy.id]: next })}
                    {suggestions}
                    {now}
                  />
                {/each}
              </div>
            </section>
          {:else if itemError}
            <EmptyState icon="warning" title="This item didn't load" description={itemError}>
              {#snippet action()}<Button variant="outline" size="sm" onclick={() => current && reportSet && void readItem(reportSet, current)}>Try again</Button>{/snippet}
            </EmptyState>
          {:else}
            <LoadingText text="Reading the item…" />
          {/if}
        </div>
      </div></div>
      <datalist id={suggestions}>{#each names as name (name)}<option value={name}></option>{/each}</datalist>
    {/if}
  </Page>
</div>

<style>
  .host {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }
  .frame {
    container-type: inline-size;
  }
  .layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 24px;
  }
  .jump {
    display: none;
  }
  @container (width >= 56rem) {
    .layout {
      grid-template-columns: 15rem minmax(0, 1fr);
    }
    .jump {
      display: block;
      position: sticky;
      top: 0;
      align-self: start;
      max-height: 40rem;
      overflow: auto;
    }
  }
  .jump ol {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .jump-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 28px;
    padding: 0 8px;
    border: 0;
    border-radius: var(--radius-row);
    background: transparent;
    color: var(--text-subtle);
    font: var(--text-body-sm);
    text-align: left;
  }
  .jump-row:hover {
    background: var(--affordance-ghost-hover);
  }
  .jump-row.current {
    background: var(--surface-sidebar-selected);
    color: var(--text-sidebar-selected);
  }
  .jump-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .jump-count {
    color: var(--text-metadata);
    font: var(--text-caption);
    font-variant-numeric: tabular-nums;
  }
  .main {
    display: flex;
    flex-direction: column;
    gap: 20px;
    min-width: 0;
  }
  .progress {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .progress-line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .nav {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .position {
    font: var(--text-label-sm);
    font-variant-numeric: tabular-nums;
  }
  .tallies,
  .meta {
    color: var(--text-subtle);
    font: var(--text-body-sm);
    font-variant-numeric: tabular-nums;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 16px;
    margin: 0;
  }
  .item {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .item-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  h2 {
    margin: 0;
    font: var(--text-title);
    letter-spacing: var(--tracking-title);
    overflow-wrap: anywhere;
  }
  .group {
    color: var(--text-subtle);
    font: var(--text-body-sm);
  }
  .summary,
  .description,
  .hint {
    margin: 0;
    color: var(--text-subtle);
    font: var(--text-body);
  }
  .description {
    color: var(--text-standard);
  }
  .controls {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 8px 0;
    background: var(--surface-panel);
  }
  kbd {
    margin-left: 4px;
    padding: 0 4px;
    border-radius: 4px;
    box-shadow: inset 0 0 0 1px currentColor;
    font: var(--text-caption);
    opacity: 0.6;
  }
  .copies {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
</style>
