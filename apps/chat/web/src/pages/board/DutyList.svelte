<script lang="ts">
  import { api, type DutyRow } from "$lib/api";
  import { Button, EmptyState, Icon, IconButton, IdChip, Menu, Switch, toast, type MenuEntry } from "$lib/ui";
  import { hrefFor } from "$lib/router.svelte";
  import { boardHref } from "./chips";
  import DutyDialog from "./DutyDialog.svelte";
  import { lastLabel, nextLabel, scheduleLabel, VERDICT_WORDS, whenLabel, type Verdict } from "./schedule";

  /** A chat's duties, on its board and on its agent page: run now, pause, edit, remove with Undo, add, and each run's measure. */
  let { chatId, duties, onchange, now, focus = null }: { chatId: string; duties: DutyRow[]; onchange: (duties: DutyRow[]) => void; now: number; focus?: string | null } = $props();

  type Run = DutyRow["runs"][number];
  const RUNS_SHOWN = 8;
  /** How long a removed duty waits for Undo before the server deletes it with its runs. */
  const UNDO_MS = 6000;
  const TRIGGER_WORDS: Record<Run["trigger"], string> = {
    schedule: "on its schedule", "catch-up": "catching up a missed slot", owner: "you ran it", verify: "re-measure after a fix",
    push: "push while off target", rerun: "rerun of a cut run", "host-back": "rerun once its box was back",
  };

  let busy = $state<string | null>(null);
  let opened = $state<string | null>(null);
  let allRuns = $state<string | null>(null);
  let openRun = $state<string | null>(null);
  let removed = $state<ReadonlySet<string>>(new Set());
  let menu = $state<{ duty: DutyRow; anchor: HTMLElement } | null>(null);
  let menuOpen = $state(false);
  let editing = $state<DutyRow | null>(null);
  let dialogOpen = $state(false);

  const shown = $derived(duties.filter(duty => !removed.has(duty.duty.id)));

  $effect(() => {
    if (focus && duties.some(duty => duty.duty.id === focus)) opened = focus;
  });

  async function act(duty: DutyRow, action: "run" | "pause" | "resume") {
    busy = `${duty.duty.id}:${action}`;
    try {
      onchange((await api.dutyAction(chatId, { duty: duty.duty.id, action })).duties);
      if (action === "run") toast.success(`Started a run of ${duty.duty.name}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The duty did not change.");
    } finally {
      busy = null;
    }
  }

  const without = (set: ReadonlySet<string>, id: string) => new Set([...set].filter(entry => entry !== id));

  /** Hides the duty at once and deletes it, runs and all, once the toast's Undo has gone unused. */
  function remove(duty: DutyRow) {
    const id = duty.duty.id;
    let undone = false;
    removed = new Set([...removed, id]);
    toast.show(`Removed ${duty.duty.name}`, { duration: UNDO_MS, action: { label: "Undo", run: () => { undone = true; removed = without(removed, id); } } });
    setTimeout(async () => {
      if (undone) return;
      try {
        onchange((await api.dutyAction(chatId, { action: "remove", duty: id })).duties);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : `Could not remove ${duty.duty.name}`);
      } finally {
        removed = without(removed, id);
      }
    }, UNDO_MS);
  }

  function edit(duty: DutyRow | null) {
    editing = duty;
    dialogOpen = true;
  }

  const menuItems = (duty: DutyRow): MenuEntry[] => [
    { id: "edit", label: "Edit goal and schedule…", icon: "edit", onselect: () => edit(duty) },
    { id: "run", label: "Run now", icon: "play", disabled: duty.running, onselect: () => void act(duty, "run") },
    { id: "pause", label: duty.paused ? "Resume" : "Pause", icon: duty.paused ? "play" : "pause", onselect: () => void act(duty, duty.paused ? "resume" : "pause") },
    { type: "separator" },
    { id: "remove", label: "Remove duty", icon: "trash", tone: "danger", onselect: () => remove(duty) },
  ];

  const last = (duty: DutyRow) => duty.last ? { ...duty.last, verdict: duty.last.verdict as Verdict } : null;
  const metricLabel = (duty: DutyRow, key: string) => duty.duty.metrics.find(metric => metric.key === key);
  const runKey = (duty: DutyRow, run: Run) => `${duty.duty.id}:${run.at}`;
  const seconds = (ms: number) => ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`;
</script>

{#if shown.length}
  <ul class="duties">
    {#each shown as duty (duty.duty.id)}
      {@const isOpen = opened === duty.duty.id}
      {@const lastRun = last(duty)}
      {@const runs = allRuns === duty.duty.id ? duty.runs : duty.runs.slice(0, RUNS_SHOWN)}
      <li class="duty" data-board-id={duty.duty.id} data-verdict={duty.last?.verdict ?? "none"}>
        <div class="card" class:paused={duty.paused}>
          <button type="button" class="summary" aria-expanded={isOpen} onclick={() => { opened = isOpen ? null : duty.duty.id; }}>
            <span class="flow" aria-hidden="true"><span class="node"><Icon name="clock" size={14} /></span><Icon name="arrow-right" size={12} /><span class="node"><Icon name="messages" size={14} /></span></span>
            <span class="text">
              <span class="name t-body-sm">{duty.duty.name}</span>
              <span class="meta t-caption">{scheduleLabel(duty.schedule)} · {lastLabel(lastRun, now)}</span>
            </span>
          </button>
          <IdChip id={duty.duty.id} {chatId} href={boardHref(chatId, duty.duty.id)} title="{duty.duty.id} · {duty.duty.name}" />
          <IconButton size="sm" icon="play" label="Run {duty.duty.name} now" loading={busy === `${duty.duty.id}:run`} disabled={duty.running} onclick={() => act(duty, "run")} />
          <Switch label="{duty.duty.name} on" checked={!duty.paused} disabled={busy !== null} onchange={(on: boolean) => act(duty, on ? "resume" : "pause")} />
          <IconButton size="sm" icon="more" label="More actions for {duty.duty.name}" onclick={(event: MouseEvent) => { menu = { duty, anchor: event.currentTarget as HTMLElement }; menuOpen = true; }} />
        </div>
        {#if isOpen}
          <div class="detail t-body-sm">
            <p class="goal">{duty.duty.goal}</p>
            {#if duty.card.headline}<p>{duty.card.headline}</p>{/if}
            {#if duty.card.headlineMiss}<p class="miss">{duty.card.headlineMiss.text}{duty.card.headlineMiss.misses > 1 ? `, off target ${duty.card.headlineMiss.misses} runs in a row` : ""}</p>{/if}
            {#each duty.card.misses as miss (miss.key)}<p class="miss">{miss.text}</p>{/each}
            {#if duty.card.onTarget.length}<p class="ok">On target: {duty.card.onTarget.join(", ")}</p>{/if}
            {#if duty.card.job}<p class="t-caption">Its job <a href={hrefFor("agents", [duty.card.job.id])}>{duty.card.job.name}</a> {duty.card.job.live ? "works now" : "is not working"}.</p>{/if}
            <p class="t-caption next">{nextLabel(duty, now)}</p>
            {#if duty.runs.length}
              <h4 class="t-label-sm runs-title">Runs</h4>
              <ol class="runs">
                {#each runs as run (run.at)}
                  {@const key = runKey(duty, run)}
                  <li class="run t-caption">
                    <button type="button" class="run-row" aria-expanded={openRun === key} onclick={() => { openRun = openRun === key ? null : key; }}>
                      <span class="dot {run.verdict}"></span><span class="run-text">{VERDICT_WORDS[run.verdict as Verdict] ?? run.verdict} · {whenLabel(run.at, now)}{run.summary ? ` · ${run.summary}` : ""}</span>
                    </button>
                    {#if openRun === key}
                      <div class="run-detail" data-run-detail>
                        <p>{TRIGGER_WORDS[run.trigger] ?? run.trigger} · took {seconds(run.ms)}</p>
                        {#if run.summary}<p class="run-summary">{run.summary}</p>{/if}
                        {#if Object.keys(run.metrics).length}
                          <ul class="metrics">
                            {#each Object.entries(run.metrics) as [metricKey, result] (metricKey)}
                              {@const metric = metricLabel(duty, metricKey)}
                              <li class:missed={!result.met}><Icon name={result.met ? "check" : "close"} size={12} />{metric?.label ?? metricKey}: {result.value}{metric?.unit ?? ""}, target {result.op} {result.target}{metric?.unit ?? ""}</li>
                            {/each}
                          </ul>
                        {/if}
                        {#if run.error}<p class="miss">{run.error}</p>{/if}
                        {#if run.job}<p>Job <a href={hrefFor("agents", [run.job.id])}>{run.job.name}</a></p>{/if}
                      </div>
                    {/if}
                  </li>
                {/each}
              </ol>
              {#if duty.runs.length > RUNS_SHOWN}
                <button type="button" class="more-runs t-caption" onclick={() => { allRuns = allRuns === duty.duty.id ? null : duty.duty.id; }}>
                  {allRuns === duty.duty.id ? "Show fewer runs" : `Show all ${duty.runs.length} runs`}
                </button>
              {/if}
            {:else}
              <p class="t-caption next">No runs yet.</p>
            {/if}
          </div>
        {/if}
      </li>
    {/each}
    <li><button type="button" class="add t-body-sm" onclick={() => edit(null)}><Icon name="plus" size={14} />Add duty</button></li>
  </ul>
{:else}
  <EmptyState size="sm" icon="clock" title="No duties yet" description="A duty checks something on a schedule and starts a job when it is off target.">
    {#snippet action()}<Button size="sm" icon="plus" onclick={() => edit(null)}>Add duty</Button>{/snippet}
  </EmptyState>
{/if}

{#if menu}
  <Menu bind:open={menuOpen} anchor={menu.anchor} items={menuItems(menu.duty)} label="Actions for {menu.duty.duty.name}" placement="bottom-end" />
{/if}
<DutyDialog bind:open={dialogOpen} {chatId} duty={editing} {onchange} />

<style>
  .duties { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
  .card { display: grid; grid-template-columns: minmax(0, 1fr) auto auto auto auto; align-items: center; gap: var(--space-2); padding: var(--space-1) var(--space-2) var(--space-1) var(--space-1); border: 1px solid var(--border-standard); border-radius: var(--radius-container); }
  .summary { display: flex; align-items: center; gap: var(--space-3); min-width: 0; padding: var(--space-2); border: 0; border-radius: var(--radius-row); background: none; color: inherit; font: inherit; text-align: start; cursor: pointer; }
  .summary:hover { background: var(--affordance-ghost-hover); }
  .paused .summary { opacity: 0.7; }
  .flow { display: inline-flex; align-items: center; gap: 4px; color: var(--text-subtle); flex: none; }
  .node { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; background: var(--surface-inset); color: var(--text-standard); }
  .text { display: grid; min-width: 0; }
  .name { color: var(--text-standard); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { color: var(--text-subtle); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .detail { display: grid; gap: var(--space-1); padding: var(--space-3) var(--space-3) var(--space-1); }
  .detail p { margin: 0; }
  .goal { color: var(--text-standard); }
  .miss { color: var(--text-danger); }
  .ok, .next { color: var(--text-subtle); }
  .runs-title { margin: var(--space-2) 0 0; }
  .runs { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; color: var(--text-subtle); }
  .run-row { display: flex; align-items: center; gap: var(--space-2); width: 100%; padding: 2px var(--space-1); border: 0; border-radius: var(--radius-row); background: none; color: inherit; font: inherit; text-align: start; cursor: pointer; }
  .run-row:hover { background: var(--affordance-ghost-hover); color: var(--text-standard); }
  .run-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .run-row[aria-expanded="true"] .run-text { white-space: normal; }
  .run-detail { display: grid; gap: 2px; padding: var(--space-1) var(--space-2) var(--space-2) var(--space-5); }
  .run-summary { color: var(--text-standard); }
  .metrics { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
  .metrics li { display: flex; align-items: center; gap: var(--space-1); }
  .metrics li.missed { color: var(--text-danger); }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--status-offline); }
  .dot.met { background: var(--status-online); }
  .dot.missed, .dot.error { background: var(--border-danger); }
  .more-runs, .add { justify-self: start; display: inline-flex; align-items: center; gap: var(--space-1); padding: var(--space-1) var(--space-2); border: 0; border-radius: var(--radius-row); background: none; color: var(--text-subtle); font: inherit; cursor: pointer; }
  .more-runs:hover, .add:hover { background: var(--affordance-ghost-hover); color: var(--text-standard); }
  .add { padding-block: var(--space-2); }
</style>
