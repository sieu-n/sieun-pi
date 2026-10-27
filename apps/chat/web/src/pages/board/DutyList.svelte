<script lang="ts">
  import { api, type DutyRow } from "$lib/api";
  import { Icon, IconButton, IdChip, Switch, toast } from "$lib/ui";
  import { boardHref } from "./chips";
  import { lastLabel, nextLabel, VERDICT_WORDS, whenLabel, type Verdict } from "./schedule";

  let { chatId, duties = $bindable(), now, focus = null }: { chatId: string; duties: DutyRow[]; now: number; focus?: string | null } = $props();

  let busy = $state<string | null>(null);
  let opened = $state<string | null>(null);

  $effect(() => {
    if (focus && duties.some(duty => duty.duty.id === focus)) opened = focus;
  });

  async function act(duty: DutyRow, action: "run" | "pause" | "resume") {
    busy = `${duty.duty.id}:${action}`;
    try {
      duties = (await api.dutyAction(chatId, { duty: duty.duty.id, action })).duties;
      if (action === "run") toast.success(`Started a run of ${duty.duty.id}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The duty did not change.");
    } finally {
      busy = null;
    }
  }

  function schedule(duty: DutyRow): string {
    const s = duty.schedule as { kind: "daily"; at: string } | { kind: "every"; minutes: number };
    return s.kind === "daily" ? `Daily at ${s.at}` : `Every ${s.minutes} min`;
  }
  const last = (duty: DutyRow) => duty.last ? { ...duty.last, verdict: duty.last.verdict as Verdict } : null;
</script>

<ul class="duties">
  {#each duties as duty (duty.duty.id)}
    {@const isOpen = opened === duty.duty.id}
    {@const lastRun = last(duty)}
    <li class="duty" data-board-id={duty.duty.id} data-verdict={duty.last?.verdict ?? "none"}>
      <div class="card" class:paused={duty.paused}>
        <button type="button" class="summary" aria-expanded={isOpen} onclick={() => { opened = isOpen ? null : duty.duty.id; }}>
          <span class="flow" aria-hidden="true"><span class="node"><Icon name="clock" size={14} /></span><Icon name="arrow-right" size={12} /><span class="node"><Icon name="messages" size={14} /></span></span>
          <span class="text">
            <span class="name t-body-sm">{duty.duty.name}</span>
            <span class="meta t-caption">{schedule(duty)} · {lastLabel(lastRun, now)}</span>
          </span>
        </button>
        <IdChip id={duty.duty.id} {chatId} href={boardHref(chatId, duty.duty.id)} title="{duty.duty.id} · {duty.duty.name}" />
        <IconButton size="sm" icon="play" label="Run {duty.duty.name} now" loading={busy === `${duty.duty.id}:run`} disabled={duty.running} onclick={() => act(duty, "run")} />
        <Switch label="{duty.duty.name} on" checked={!duty.paused} disabled={busy !== null} onchange={(on: boolean) => act(duty, on ? "resume" : "pause")} />
      </div>
      {#if isOpen}
        <div class="detail t-body-sm">
          <p class="goal">{duty.duty.goal}</p>
          {#if duty.card.headline}<p>{duty.card.headline}</p>{/if}
          {#if duty.card.headlineMiss}<p class="miss">{duty.card.headlineMiss.text}{duty.card.headlineMiss.misses > 1 ? `, off target ${duty.card.headlineMiss.misses} runs in a row` : ""}</p>{/if}
          {#each duty.card.misses as miss (miss.key)}<p class="miss">{miss.text}</p>{/each}
          {#if duty.card.onTarget.length}<p class="ok">On target: {duty.card.onTarget.join(", ")}</p>{/if}
          {#if duty.card.job}<p class="t-caption">Its job {duty.card.job.name} {duty.card.job.live ? "works now" : "is not working"}.</p>{/if}
          <p class="t-caption next">{nextLabel(duty, now)}</p>
          {#if duty.runs.length}
            <h4 class="t-label-sm runs-title">Runs</h4>
            <ol class="runs">
              {#each duty.runs.slice(0, 8) as run (run.at)}
                <li class="run t-caption"><span class="dot {run.verdict}"></span>{VERDICT_WORDS[run.verdict as Verdict] ?? run.verdict} · {whenLabel(run.at, now)}{run.summary ? ` · ${run.summary}` : ""}</li>
              {/each}
            </ol>
          {:else}
            <p class="t-caption next">No runs yet.</p>
          {/if}
        </div>
      {/if}
    </li>
  {/each}
</ul>

<style>
  .duties { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
  .card { display: grid; grid-template-columns: minmax(0, 1fr) auto auto auto; align-items: center; gap: var(--space-2); padding: var(--space-1) var(--space-2) var(--space-1) var(--space-1); border: 1px solid var(--border-standard); border-radius: var(--radius-container); }
  .summary { display: flex; align-items: center; gap: var(--space-3); min-width: 0; padding: var(--space-2); border: 0; border-radius: var(--radius-row); background: var(--surface-inset); color: inherit; font: inherit; text-align: start; cursor: pointer; }
  .summary:hover { background: var(--affordance-subtle-hover); }
  .paused .summary { opacity: 0.7; }
  .flow { display: inline-flex; align-items: center; gap: 4px; color: var(--text-subtle); flex: none; }
  .node { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; background: var(--surface-panel); color: var(--text-standard); }
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
  .run { display: flex; align-items: center; gap: var(--space-2); }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--status-offline); }
  .dot.met { background: var(--status-online); }
  .dot.missed, .dot.error { background: var(--border-danger); }
</style>
