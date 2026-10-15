<script lang="ts">
  import type { DutyView } from "../shared/chat-duties.ts";
  import { CHANGE_APPROACH_MISSES, effectiveRun } from "../shared/duty-streak.ts";
  import type { ChatAgent } from "../shared/types.ts";
  import { type CadenceDraft, cadenceDraft, cadenceSchedule, classesLabel, flaggedLabel, metricsHeadlineFirst } from "./duty-cadence.ts";
  import { dutyCard, type MissLine } from "./duty-card.ts";
  import { dutyState, history, lastLabel, metricValue, nextLabel, scheduleLabel, VERDICT_WORDS, type ChatDuties } from "./duties.svelte.ts";
  import Icon from "./Icon.svelte";
  import IdChip from "./IdChip.svelte";
  import { store } from "./store.svelte.ts";
  import { tooltip } from "./ui/tooltip.ts";

  /**
   * The Duties card body: one row per duty with its state dot, name, schedule, next run, the last verdict and the pass and fail history as dots
   * (oldest first; green met, amber missed, red failed, grey skipped). A click on the row opens its goal, the owner's words, each metric against
   * its target over the last runs, the last run's output file, and the cadence editor (every N minutes or a daily time). Run now and Pause or
   * Resume act through the server. Each run starts one duty job, named under the row. The check-in is a built-in duty: it carries a Built-in
   * tag and its last run's open steps per class and what it flagged, and its cadence and pause are the chat's check-in setting (the header's control).
   * Each row names the chat's priority, which picks a new duty's morning band. Under the row the headline metric comes first, then one line per
   * missed metric with its miss streak, a stuck mark when it must change approach, and its fix job as a link or a gap mark when no live job fixes
   * it (`dutyCard`). Every verdict is the run's after-job measure when it has one; the detail keeps the measure from before the job.
   */
  let { chat, duties, now, agents }: { chat: string; duties: ChatDuties; now: number; agents: readonly ChatAgent[] } = $props();

  const STUCK_TIP = `Missed ${CHANGE_APPROACH_MISSES} or more runs in a row with no move toward the target. The next run must try a new root-cause fix, not the same one.`;
  const GAP_TIP = "No job is working on this miss now. The next run must start or steer one.";
  const streakTip = (line: MissLine) => `Missed ${line.misses} measured run${line.misses === 1 ? "" : "s"} in a row`;

  const PRIORITY_TIP = "The chat's priority, from its sidebar label (none is high). A new duty runs daily in its morning band: high from 06:00, normal from 07:40, " +
    "low from 09:20. Duty jobs always wait in the low class of the agent queue.";

  let open = $state<Record<string, boolean>>({});
  const toggle = (id: string) => { open = { ...open, [id]: !open[id] }; };

  const runTitle = (view: DutyView, index: number): string => {
    const run = history(view)[index]!;
    const judged = effectiveRun(run);
    return `${new Date(run.at).toLocaleString()}: ${VERDICT_WORDS[judged.verdict]}${run.after ? " after its job" : ""}. ${run.error ?? judged.summary}`;
  };
  const lastRun = (view: DutyView) => view.runs.find(run => run.verdict !== "skipped");

  let drafts = $state<Record<string, CadenceDraft>>({});
  let cadenceError = $state<Record<string, string>>({});
  const draftOf = (view: DutyView): CadenceDraft => drafts[view.duty.id] ?? cadenceDraft(view.schedule);
  const setDraft = (view: DutyView, change: Partial<CadenceDraft>) => { drafts = { ...drafts, [view.duty.id]: { ...draftOf(view), ...change } }; };
  const saveCadence = async (view: DutyView) => {
    const schedule = cadenceSchedule(draftOf(view), view.builtin !== undefined);
    if ("error" in schedule) { cadenceError = { ...cadenceError, [view.duty.id]: schedule.error }; return; }
    cadenceError = { ...cadenceError, [view.duty.id]: "" };
    await duties.act(view.duty.id, "schedule", schedule);
    const { [view.duty.id]: _saved, ...rest } = drafts;
    drafts = rest;
  };
</script>

{#snippet jobLink(name: string)}
  <button type="button" class="link-chip job" data-preview-chat={chat} data-preview-job={name} onclick={() => store.openArtifact({ kind: "job", name }, chat)}><Icon name="briefcase" size={11} /><span class="chip-label">{name}</span></button>
{/snippet}
{#snippet marks(line: MissLine)}
  <span class="miss-runs" use:tooltip={streakTip(line)}>{line.misses} run{line.misses === 1 ? "" : "s"}</span>
  {#if line.stuck}<span class="miss-mark stuck" use:tooltip={STUCK_TIP}>stuck, change approach</span>{/if}
  {#if line.fix.kind !== "none" && line.fix.job}{@render jobLink(line.fix.job)}{/if}
  {#if line.fix.kind !== "live"}<span class="miss-mark gap" use:tooltip={GAP_TIP}>no live fix job</span>{/if}
{/snippet}

<ul class="duties">
  {#each duties.views as view (view.duty.id)}
    {@const duty = view.duty}
    {@const state = dutyState(view)}
    {@const last = lastRun(view)}
    {@const found = flaggedLabel(view)}
    {@const card = dutyCard(view, agents)}
    <li class="duty">
      <div class="duty-line">
        <button type="button" class="duty-main" aria-expanded={open[duty.id] === true} onclick={() => toggle(duty.id)}>
          <span class="duty-state">{#if state === "running"}<span class="spinner tiny"></span>{:else}<span class="duty-dot {state}"></span>{/if}</span>
          <span class="duty-name">{duty.name}</span>
          {#if view.builtin}<span class="duty-tag" use:tooltip={"Built in: the check-in. Its cadence and pause are the header's Check-in control"}>Built-in</span>{/if}
          <span class="duty-priority" use:tooltip={PRIORITY_TIP}>{view.priority} priority</span>
          <span class="duty-when">{scheduleLabel(view.schedule)} · {nextLabel(view, now)}</span>
        </button>
        <span class="duty-actions">
          <button type="button" class="duty-act" disabled={view.running} onclick={() => void duties.act(duty.id, "run")}>Run now</button>
          <button type="button" class="duty-act" onclick={() => void duties.act(duty.id, view.paused ? "resume" : "pause")}>{view.paused ? "Resume" : "Pause"}</button>
        </span>
      </div>
      {#if card.headline}
        <p class="duty-headline">{card.headline}{#if card.headlineMiss}{@render marks(card.headlineMiss)}{/if}</p>
      {/if}
      {#each card.misses as line (line.key)}<p class="duty-miss"><span class="miss-text">{line.text}</span>{@render marks(line)}</p>{/each}
      {#if card.onTarget.length}<p class="duty-ok" use:tooltip={card.onTarget.join("\n")}>On target: {card.onTarget.join(", ")}</p>{/if}
      <p class="duty-last">
        <span class="duty-verdict {state}">{lastLabel(view, now)}</span>
        {#if view.runs.length}
          <span class="history" aria-label="Last {view.runs.length} runs, oldest first">
            {#each history(view) as run, index (run.at)}<span class="run {run.verdict}" use:tooltip={runTitle(view, index)}></span>{/each}
          </span>
        {/if}
      </p>
      {#if view.builtin}
        {@const classes = classesLabel(last)}
        {#if classes}<p class="duty-found">{classes}</p>{/if}
        {#if found}<p class="duty-found">Flagged: {found}</p>{/if}
      {/if}
      {#if card.job}
        {@const job = card.job}
        <p class="duty-found">Duty job {@render jobLink(job.name)}<span class="job-state" class:live={job.live}>{job.live ? "working" : "ended"}</span></p>
      {/if}
      {#if open[duty.id]}
        <div class="duty-detail">
          <p class="goal">{duty.goal}</p>
          <table class="metrics">
            <thead><tr><th>Metric</th><th>Target</th><th>Last</th><th>Runs</th></tr></thead>
            <tbody>
              {#each metricsHeadlineFirst(duty.metrics) as metric (metric.key)}
                {@const result = last ? effectiveRun(last).metrics[metric.key] : undefined}
                <tr>
                  <td title={metric.key}>{metric.label}</td>
                  <td class="num">{metric.op === "<=" ? "≤" : "≥"} {metricValue(metric.target, metric.unit)}</td>
                  <td class="num" class:miss={result?.met === false}>{result ? metricValue(result.value, metric.unit) : "–"}</td>
                  <td><span class="history">{#each history(view, 7).filter(run => run.verdict !== "skipped") as run (run.at)}{@const mine = effectiveRun(run).metrics[metric.key]}<span class="run {mine ? (mine.met ? 'met' : 'missed') : 'error'}"></span>{/each}</span></td>
                </tr>
              {/each}
            </tbody>
          </table>
          {#if last}
            {#if last.after}
              <p class="summary">After its job, {new Date(last.after.at).toLocaleString()}: {last.after.summary}</p>
              <p class="summary before">Before its job, {new Date(last.at).toLocaleString()}: {last.error ?? last.summary}</p>
            {:else}
              <p class="summary">{last.error ?? last.summary}</p>
            {/if}
            {#if last.detail}
              {@const detail = last.detail}
              <button type="button" class="link-chip file" title={detail} onclick={() => store.openArtifact({ kind: "file", path: detail }, chat)}><Icon name="file" size={11} /><span class="chip-label">Last run output</span></button>
            {/if}
          {/if}
          <form class="cadence" onsubmit={event => { event.preventDefault(); void saveCadence(view); }}>
            <span class="cadence-label">Runs</span>
            {#if view.builtin}
              <span>every</span>
            {:else}
              <select aria-label="Cadence" value={draftOf(view).kind} onchange={event => setDraft(view, { kind: event.currentTarget.value === "daily" ? "daily" : "every" })}>
                <option value="every">every</option>
                <option value="daily">daily at</option>
              </select>
            {/if}
            {#if draftOf(view).kind === "every"}
              <input aria-label="Minutes" type="number" min="1" step="1" value={draftOf(view).minutes} oninput={event => setDraft(view, { minutes: event.currentTarget.valueAsNumber })} /><span>min</span>
            {:else}
              <input aria-label="Time" type="time" value={draftOf(view).at} oninput={event => setDraft(view, { at: event.currentTarget.value })} />
            {/if}
            <button type="submit" class="duty-act">Save</button>
            {#if cadenceError[duty.id]}<span class="cadence-error">{cadenceError[duty.id]}</span>{/if}
          </form>
          <p class="owner-words" use:tooltip={"The owner's words that started this duty"}>"{duty.ownerWords}"</p>
          {#if duty.boardGoal}<p class="board-goal">Fixes go under <IdChip {chat} id={duty.boardGoal} /></p>{/if}
        </div>
      {/if}
    </li>
  {/each}
</ul>
{#if duties.error}<p class="duty-error">{duties.error}</p>{/if}

<style>
  .duties { list-style: none; margin: 0 -6px; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .duty { padding: 0 6px; }
  .duty-line { display: flex; align-items: center; gap: 4px; }
  .duty-main { display: flex; flex: 1; min-width: 0; align-items: center; gap: 6px; padding: 3px 6px; margin: 0 -6px; border-radius: var(--radius-small); text-align: left; line-height: 18px; }
  .duty-main:hover { background: var(--bg-hover); }
  .duty-state { display: inline-flex; flex: none; width: 12px; justify-content: center; }
  .duty-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--border-strong); }
  .duty-dot.met { background: var(--success); }
  .duty-dot.missed { background: var(--warning); }
  .duty-dot.error { background: var(--danger); }
  .duty-name { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
  .duty-when { flex: 1; min-width: 3ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; color: var(--text-faint); }
  .duty-actions { display: inline-flex; flex: none; gap: 2px; }
  .duty-act { padding: 1px 6px; border-radius: 4px; font-size: 11.5px; color: var(--text-faint); }
  .duty-act:hover:not(:disabled) { color: var(--accent-bold); background: var(--bg-hover); }
  .duty-act:disabled { opacity: 0.5; }
  .duty-last { display: flex; align-items: center; gap: 8px; margin: 0; padding: 0 0 0 18px; font-size: 12px; line-height: 18px; color: var(--text-muted); }
  .duty-verdict { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .duty-verdict.missed { color: var(--warning); }
  .duty-verdict.error { color: var(--danger); }
  .history { display: inline-flex; flex: none; gap: 2px; align-items: center; margin-left: auto; }
  .run { width: 6px; height: 10px; border-radius: 2px; background: var(--border-strong); }
  .run.met { background: var(--success); }
  .run.missed { background: var(--warning); }
  .run.error { background: var(--danger); }
  .duty-detail { margin: 6px 0 2px 18px; display: flex; flex-direction: column; gap: 6px; font-size: 12.5px; line-height: 1.45; }
  .duty-detail p { margin: 0; }
  .goal { color: var(--text); }
  .metrics { width: 100%; border-collapse: collapse; font-size: 12px; }
  .metrics th { text-align: left; font-weight: 500; color: var(--text-faint); padding: 2px 6px 2px 0; border-bottom: 1px solid var(--border); }
  .metrics td { padding: 2px 6px 2px 0; color: var(--text-muted); vertical-align: middle; }
  .metrics .num { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .metrics .miss { color: var(--warning); font-weight: 500; }
  .metrics .history { margin-left: 0; }
  .summary { color: var(--text-muted); overflow-wrap: anywhere; }
  .link-chip { align-self: flex-start; }
  .owner-words { color: var(--text-faint); font-style: normal; overflow-wrap: anywhere; }
  .board-goal { color: var(--text-faint); }
  .duty-error { margin: 6px 0 0; font-size: 12px; color: var(--danger); }
  .duty-tag { flex: none; padding: 0 5px; border: 1px solid var(--border); border-radius: 4px; font-size: 10.5px; line-height: 15px; color: var(--text-faint); }
  .duty-priority { flex: none; font-size: 10.5px; line-height: 15px; color: var(--text-faint); }
  .duty-headline { margin: 0; padding: 0 0 0 18px; font-size: 12px; line-height: 18px; color: var(--text); font-weight: 500; }
  .duty-miss { display: flex; flex-wrap: wrap; align-items: center; column-gap: 6px; margin: 0; padding: 0 0 0 18px; font-size: 12px; line-height: 18px; color: var(--text-muted); }
  .duty-headline { display: flex; flex-wrap: wrap; align-items: center; column-gap: 6px; }
  .miss-text { min-width: 0; overflow-wrap: anywhere; }
  .miss-runs { flex: none; font-size: 11px; color: var(--warning); font-variant-numeric: tabular-nums; font-weight: 400; }
  .miss-mark { flex: none; padding: 0 5px; border-radius: 4px; font-size: 10.5px; line-height: 15px; font-weight: 400; }
  .miss-mark.stuck { color: var(--danger); border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent); }
  .miss-mark.gap { color: var(--warning); border: 1px solid color-mix(in srgb, var(--warning) 45%, transparent); }
  .duty-ok { margin: 0; padding: 0 0 0 18px; font-size: 11.5px; line-height: 17px; color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .duty-found .link-chip { vertical-align: bottom; }
  .job-state { margin-left: 6px; font-size: 11px; color: var(--text-faint); }
  .job-state.live { color: var(--success); }
  .summary.before { color: var(--text-faint); }
  .duty-found { margin: 0; padding: 0 0 0 18px; font-size: 12px; line-height: 18px; color: var(--text-muted); overflow-wrap: anywhere; }
  .cadence { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; color: var(--text-muted); }
  .cadence-label { color: var(--text-faint); }
  .cadence input[type="number"] { width: 6ch; }
  .cadence input, .cadence select { font: inherit; font-size: 12px; padding: 1px 4px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg); color: var(--text); }
  .cadence-error { color: var(--danger); }
</style>
