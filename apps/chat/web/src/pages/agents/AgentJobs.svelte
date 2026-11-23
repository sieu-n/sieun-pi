<script lang="ts">
  import { jobs as liveJobs, type AgentConfig, type RunStatus } from "$lib/api";
  import { Button, Chip, EmptyState, IconButton, Menu, SearchField, StatusDot, Tabs, stampLabel, type MenuEntry } from "$lib/ui";
  import { hrefFor, router } from "$lib/router.svelte";
  import { archiveAgent, messageAgent, onAgentsChanged, stopAgent, unarchiveAgent } from "./agent-actions.svelte";
  import { JOB_KIND_LABEL, STATUS_LABEL, jobFilterCounts, jobFilterOf, jobsShown, type JobFilter } from "./agents-model";
  import { capped, ROWS_SHOWN } from "./threads-tab";

  type Job = AgentConfig["swarm"]["jobs"][number];
  type Props = {
    jobs: readonly Job[];
    /** Reads the agent's configuration again after an archive, restore or stop. */
    onchanged: () => void;
  };
  let { jobs, onchanged }: Props = $props();

  /** An archive or restore moves its row at once, until the next read of the configuration says where it stands. */
  let archived = $state<Record<string, boolean>>({});
  $effect.pre(() => {
    void jobs;
    archived = {};
  });
  $effect(() => onAgentsChanged(onchanged));
  const list = $derived(jobs.map((job) => (job.id in archived ? { ...job, archived: archived[job.id]! } : job)));

  /** The filter and the search live in the URL, so Back from a job's page lands on the same view. */
  const query = $derived(router.route.params.jobq ?? "");
  const counts = $derived(jobFilterCounts(list, query));
  const filter = $derived(jobFilterOf(router.route.params.jobs, jobFilterCounts(list, "")));
  const shown = $derived(jobsShown(list, filter, query));
  /** The view whose whole list shows; another filter or search starts again at 10 rows (owner rule c123). */
  let allOf = $state<string | null>(null);
  const view = $derived(`${filter}\u0000${query}`);
  const rows = $derived(capped(shown, allOf === view));
  const names = $derived(new Map(list.map((job) => [job.id, job.name])));
  /** Each count shows in full, as a string, since a number badge stops at 99+ and agent factory has over 300 finished jobs. */
  const count = (n: number) => (n ? String(n) : null);
  const tabs = $derived([
    { id: "active" as const, label: "Active", badge: count(counts.active) },
    { id: "finished" as const, label: "Finished", badge: count(counts.finished) },
    { id: "archived" as const, label: "Archived", badge: count(counts.archived) },
  ]);
  const setFilter = (next: JobFilter) => router.setParams({ jobs: next }, { replace: true });
  const setQuery = (next: string) => router.setParams({ jobq: next || null }, { replace: true });

  const dotOf = (status: RunStatus) => (status === "working" ? "online" : status === "sleeping" ? "away" : status === "failed" ? "busy" : "offline");
  const running = (job: Job) => job.status === "working" || job.status === "sleeping";

  function setArchived(job: Job, next: boolean) {
    archived = { ...archived, [job.id]: next };
    void (next ? archiveAgent(job) : unarchiveAgent(job)).then(() => onchanged());
  }
  /** Its conversation opens in a pane beside the DM of the agent it works for, as Message does on its page. */
  function message(job: Job) {
    const live = liveJobs.byId(job.id);
    if (live) messageAgent(live);
    else router.openConversation(job.id);
  }

  let menu = $state<{ job: Job; anchor: HTMLElement } | null>(null);
  let menuOpen = $state(false);
  const menuItems = $derived.by((): MenuEntry[] => {
    if (!menu) return [];
    const job = menu.job;
    const items: MenuEntry[] = [
      { id: "open", label: "Open job", icon: "robot", onselect: () => router.navigate(hrefFor("agents", [job.id])) },
      { id: "message", label: "Open conversation", icon: "chat", onselect: () => message(job) },
    ];
    if (running(job)) items.push({ id: "stop", label: "Stop", icon: "stop", onselect: () => stopAgent(job) });
    items.push({ type: "separator" });
    items.push(job.archived
      ? { id: "unarchive", label: "Unarchive", icon: "unarchive", onselect: () => void setArchived(job, false) }
      : { id: "archive", label: "Archive", icon: "archive", onselect: () => void setArchived(job, true) });
    return items;
  });
  function openMenu(job: Job, anchor: HTMLElement) {
    menu = { job, anchor };
    menuOpen = true;
  }
</script>

<section class="jobs" aria-label="Jobs" data-testid="agent-jobs" data-filter={filter}>
  <div class="bar">
    <Tabs items={tabs} value={filter} variant="segmented" size="sm" label="Show jobs" onchange={setFilter} />
    <div class="search">
      <SearchField value={query} placeholder="Search jobs" label="Search jobs" oninput={setQuery} onkeydown={(e) => e.key === "Escape" && query && (e.preventDefault(), setQuery(""))} />
    </div>
  </div>
  {#if shown.length}
    <ul class="list">
      {#each rows as job (job.id)}
        {@const parent = job.depth > 1 && job.parent ? names.get(job.parent) : undefined}
        <li data-job-id={job.id} data-status={job.status} data-archived={job.archived || undefined} class:open={menuOpen && menu?.job.id === job.id}>
          <StatusDot status={dotOf(job.status)} label={STATUS_LABEL[job.status]} />
          <span class="grow">
            <a href={hrefFor("agents", [job.id])}>{job.name}</a>
            {#if parent}<span class="t-caption meta">under {parent}</span>{/if}
            {#if liveJobs.byId(job.id)?.retrying}<span class="t-caption meta" data-retrying>{liveJobs.byId(job.id)?.retrying}</span>{/if}
          </span>
          {#if job.kind !== "job"}<Chip size="sm" label={JOB_KIND_LABEL[job.kind]} />{/if}
          <span class="t-caption meta when">{job.createdAt ? stampLabel(job.createdAt) : ""}</span>
          <span class="row-actions">
            {#if filter === "finished"}
              <IconButton icon="archive" label="Archive {job.name}" size="xs" onclick={() => void setArchived(job, true)} />
            {:else if filter === "archived"}
              <IconButton icon="unarchive" label="Unarchive {job.name}" size="xs" onclick={() => void setArchived(job, false)} />
            {/if}
            <IconButton icon="more" label="Actions for {job.name}" size="xs" onclick={(e: MouseEvent) => openMenu(job, e.currentTarget as HTMLElement)} />
          </span>
        </li>
      {/each}
      {#if shown.length > ROWS_SHOWN}
        <li><button type="button" class="more t-caption" data-testid="jobs-show-all" onclick={() => (allOf = allOf === view ? null : view)}>{allOf === view ? "Show fewer" : `Show all ${shown.length.toLocaleString("en-US")} jobs`}</button></li>
      {/if}
    </ul>
  {:else if query}
    <EmptyState icon="search" title="No {filter} job matches “{query}”" description="Search looks at job names." size="sm">
      {#snippet action()}<Button size="sm" onclick={() => setQuery("")}>Clear search</Button>{/snippet}
    </EmptyState>
  {:else if filter === "active"}
    <EmptyState icon="robot" title="No job is running" description={counts.finished ? "Every job has finished." : "It has started no jobs yet."} size="sm">
      {#snippet action()}{#if counts.finished}<Button size="sm" onclick={() => setFilter("finished")}>Show {counts.finished} finished</Button>{/if}{/snippet}
    </EmptyState>
  {:else if filter === "finished"}
    <EmptyState icon="check" title="No finished jobs" description={counts.archived ? "Every finished job is archived." : "A job shows here once it ends."} size="sm">
      {#snippet action()}{#if counts.archived}<Button size="sm" onclick={() => setFilter("archived")}>Show {counts.archived} archived</Button>{/if}{/snippet}
    </EmptyState>
  {:else}
    <EmptyState icon="archive" title="No archived jobs" description="Archive a finished job from its menu to clear it from Finished." size="sm">
      {#snippet action()}{#if counts.finished}<Button size="sm" onclick={() => setFilter("finished")}>Show finished</Button>{/if}{/snippet}
    </EmptyState>
  {/if}
</section>
<Menu bind:open={menuOpen} anchor={menu?.anchor} items={menuItems} label="Actions for {menu?.job.name ?? 'job'}" placement="bottom-end" onclose={() => (menu = null)} />

<style>
  .jobs {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
  }
  .search {
    flex: 0 1 240px;
    min-width: 160px;
  }
  .list {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .list li {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
    min-height: 32px;
    padding: 0 var(--space-2);
    border-radius: var(--radius-row);
    font: var(--text-body-sm);
  }
  .list li:hover,
  .list li:focus-within,
  .list li.open {
    background: var(--affordance-ghost-hover);
  }
  .list li[data-archived] a {
    color: var(--text-subtle);
  }
  .grow {
    display: flex;
    flex: 1;
    align-items: baseline;
    gap: var(--space-2);
    min-width: 0;
  }
  .grow a {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-standard);
    text-decoration: none;
  }
  .grow a:hover {
    text-decoration: underline;
  }
  .meta {
    flex: none;
    color: var(--text-metadata);
  }
  .when {
    min-width: 72px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  /* The row's actions show while the row is hovered or holds focus, as Slack's hover menu does. */
  .row-actions {
    display: flex;
    flex: none;
    gap: var(--space-1);
    visibility: hidden;
  }
  .list li:hover .row-actions,
  .list li:focus-within .row-actions,
  .list li.open .row-actions {
    visibility: visible;
  }
  @media (hover: none) {
    .row-actions {
      visibility: visible;
    }
  }
</style>
