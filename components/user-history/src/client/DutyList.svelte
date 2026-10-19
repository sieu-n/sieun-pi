<script lang="ts">
    import { type DutyView, overrunWords, verdictMetrics } from "../shared/chat-duties.ts";
  import { CHANGE_APPROACH_MISSES, effectiveRun } from "../shared/duty-streak.ts";
  import type { PromptTarget } from "../shared/prompt-view.ts";
  import type { ChatAgent } from "../shared/types.ts";
  import { type CadenceDraft, cadenceDraft, cadenceSchedule, classesLabel, flaggedLabel, headlineWords } from "./duty-cadence.ts";
  import { dutyCard, dutyState, dutyStatus, dutyStatusLine, judgedRun, type MissLine } from "./duty-card.ts";
  import { history, lastLabel, metricValue, nextLabel, VERDICT_WORDS, type ChatDuties } from "./duties.svelte.ts";
  import Icon from "./Icon.svelte";
  import IdChip from "./IdChip.svelte";
  import { store } from "./store.svelte.ts";
  import { tooltip } from "./ui/tooltip.ts";

  /**
   * The Duties card body: one line per duty with its state dot, its name and one plain sentence with its headline number in words and what is
   * being done about it (`dutyStatusLine`), and nothing else (owner 10-16: "if human can't read it it's pointless", "too much slop"). A click on the line opens the rest: the goal, the headline
   * metric and each missed metric with its streak, stuck and gap marks and fix job (`dutyCard`), the shape warning, the metrics on target, the last
   * verdict with the run history as dots (oldest first; green met, amber missed, red failed, grey skipped), the check-in's open steps and what it
   * flagged in plain words, the duty job, schedule, priority, Run now and Pause, the metrics table, the last run's summary and output file, the
   * cadence editor and the owner's words. The check-in is a built-in duty whose cadence and pause are the chat's check-in setting.
   */
  let { chat, duties, now, agents }: { chat: string; duties: ChatDuties; now: number; agents: readonly ChatAgent[] } = $props();

  const STUCK_TIP = `Missed ${CHANGE_APPROACH_MISSES} or more runs in a row with no move toward the target. The next run must try a new root-cause fix, not the same one.`;
  const GAP_TIP = "No job is working on this miss now. The next run must start or steer one.";
  const streakTip = (line: MissLine) => `Missed ${line.misses} measured run${line.misses === 1 ? "" : "s"} in a row`;

  const PRIORITY_TIP = "The chat's priority, from its sidebar label (none is high). A new duty runs daily in its morning band: high from 06:00, normal from 07:40, " +
    "low from 09:20. Duty jobs wait in the low class of the agent queue, and a check-in job in the normal class.";

  let open = $state<Record<string, boolean>>({});
  const toggle = (id: string) => { open = { ...open, [id]: !open[id] }; };

  const runTitle = (view: DutyView, index: number): string => {
    const run = history(view)[index]!;
    const judged = judgedRun(run, view.duty.metrics);
    return `${new Date(run.at).toLocaleString()}: ${VERDICT_WORDS[judged.verdict]}${run.after ? " after its job" : ""}. ${run.error ?? judged.summary}${run.overrun ? `; ${overrunWords(run.overrun)}` : ""}`;
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
{#snippet promptLink(target: PromptTarget, label?: string)}
  <button type="button" class="link-chip" aria-label={label} onclick={() => { store.prompt = target; }}><Icon name="layers" size={11} /><span class="chip-label">Prompt</span></button>
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
    {@const card = dutyCard(view, agents)}
    {@const status = dutyStatus(view, card)}
    <li class="duty">
      <div class="duty-line">
        <button type="button" class="duty-main" aria-expanded={open[duty.id] === true} onclick={() => toggle(duty.id)}>
          <span class="duty-state">{#if state === "running"}<span class="spinner tiny"></span>{:else}<span class="duty-dot {state}"></span>{/if}</span>
          <span class="duty-text"><span class="duty-name">{duty.name}</span> <span class="duty-status {status.kind}">{dutyStatusLine(status, headlineWords(view), card.headlineMiss !== null || card.headline === null)}</span></span>
        </button>
        {@render promptLink(card.job ? card.job.id : { chat, duty: duty.id }, card.job ? `The prompt ${card.job.name} got` : `The brief the next ${duty.name} run sends`)}
      </div>
      {#if open[duty.id]}
        {@const found = flaggedLabel(view)}
        {@const classes = view.builtin ? classesLabel(last) : ""}
        <div class="duty-detail">
          <p class="goal">{duty.goal}</p>
          {#if card.headline}<p class="duty-headline">{card.headline}{#if card.headlineMiss}{@render marks(card.headlineMiss)}{/if}</p>{/if}
          {#each card.misses as line (line.key)}<p class="duty-miss">{line.text}{@render marks(line)}</p>{/each}
          {#if card.shape}<p class="duty-shape">{card.shape}</p>{/if}
          {#if card.onTarget.length}<p class="duty-ok">{card.onTarget.join(", ")} {card.onTarget.length === 1 ? "is" : "are"} on target.</p>{/if}
          <p class="duty-last">
            <span class="duty-verdict {state}">{lastLabel(view, now)}</span>
            {#if view.runs.length}
              <span class="history" aria-label="Last {view.runs.length} runs, oldest first">
                {#each history(view) as run, index (run.at)}
                  {@const job = run.job}
                  {#if job}<button type="button" class="run {judgedRun(run, duty.metrics).verdict}" aria-label="The prompt of {job.name}" use:tooltip={runTitle(view, index) + " Click for its prompt."} onclick={() => { store.prompt = job.id; }}></button>
                  {:else}<span class="run {judgedRun(run, duty.metrics).verdict}" use:tooltip={runTitle(view, index)}></span>{/if}
                {/each}
              </span>
            {/if}
          </p>
          {#if last?.overrun}<p class="duty-overrun">In its last run {overrunWords(last.overrun)}.</p>{/if}
          {#if classes}<p>{classes}</p>{/if}
          {#if view.builtin && found}<p>The last check-in flagged {found}</p>{/if}
          {#if card.job}
            {@const job = card.job}
            <p>Its last run started {@render jobLink(job.name)}, which {job.live ? "is working" : "has ended"}. {@render promptLink(job.id)}</p>
          {/if}
          <p class="duty-when">
            <span>{nextLabel(view, now)}</span>
            <span use:tooltip={PRIORITY_TIP}>Priority is {view.priority}.</span>
            {#if view.builtin}<span use:tooltip={"Its cadence and pause are the header's Check-in control"}>Built in.</span>{/if}
            <button type="button" class="duty-act" disabled={view.running} onclick={() => void duties.act(duty.id, "run")}>Run now</button>
            <button type="button" class="duty-act" onclick={() => void duties.act(duty.id, view.paused ? "resume" : "pause")}>{view.paused ? "Resume" : "Pause"}</button>
          </p>
          <table class="metrics">
            <thead><tr><th>Metric</th><th>Target</th><th>Last</th><th>Runs</th></tr></thead>
            <tbody>
              {#each verdictMetrics(duty.metrics) as metric (metric.key)}
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
  .duties { list-style: none; margin: 0 -6px; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .duty { padding: 0 6px; }
  .duty-line { display: flex; align-items: flex-start; gap: 6px; }
  .duty-main { display: flex; flex: 1; min-width: 0; align-items: flex-start; gap: 6px; padding: 3px 6px; margin: 0 -6px; border-radius: var(--radius-small); text-align: left; line-height: 18px; }
  .duty-main:hover { background: var(--bg-hover); }
  .duty-state { display: inline-flex; flex: none; width: 12px; height: 18px; align-items: center; justify-content: center; }
  .duty-line > .link-chip { flex: none; padding-top: 3px; }
  .duty-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--border-strong); }
  .duty-dot.met { background: var(--success); }
  .duty-dot.missed { background: var(--warning); }
  .duty-dot.error { background: var(--danger); }
  .duty-text { min-width: 0; overflow-wrap: anywhere; }
  .duty-name { font-weight: 500; }
  .duty-status { margin-left: 4px; font-size: 12px; color: var(--text-muted); }
  .duty-status.unfixed { color: var(--warning); }
  .duty-status.error { color: var(--danger); }
  .duty-act { padding: 0 4px; border-radius: 4px; font-size: 11.5px; color: var(--text-faint); }
  .duty-act:hover:not(:disabled) { color: var(--accent-bold); background: var(--bg-hover); }
  .duty-act:disabled { opacity: 0.5; }
  .duty-detail { margin: 2px 0 6px 18px; display: flex; flex-direction: column; gap: 3px; font-size: 12px; line-height: 18px; color: var(--text-muted); }
  .duty-detail p { margin: 0; overflow-wrap: anywhere; }
  .duty-detail .link-chip { vertical-align: bottom; }
  .goal { color: var(--text); }
  .duty-headline { color: var(--text); font-weight: 500; }
  .miss-runs, .miss-mark, .duty-miss .link-chip, .duty-headline .link-chip { margin-left: 6px; }
  .miss-runs { font-size: 11px; color: var(--warning); font-variant-numeric: tabular-nums; font-weight: 400; white-space: nowrap; }
  .miss-mark { display: inline-block; padding: 0 5px; border-radius: 4px; font-size: 10.5px; line-height: 15px; font-weight: 400; white-space: nowrap; }
  .miss-mark.stuck { color: var(--danger); border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent); }
  .miss-mark.gap { color: var(--warning); border: 1px solid color-mix(in srgb, var(--warning) 45%, transparent); }
  .duty-shape { color: var(--danger); }
  .duty-overrun { color: var(--warning); }
  .duty-ok { color: var(--text-faint); }
  .duty-last { display: flex; align-items: center; gap: 8px; }
  .duty-verdict { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .duty-verdict.missed { color: var(--warning); }
  .duty-verdict.error { color: var(--danger); }
  .history { display: inline-flex; flex: none; gap: 2px; align-items: center; margin-left: auto; }
  .run { width: 6px; height: 10px; border-radius: 2px; background: var(--border-strong); }
  .run.met { background: var(--success); }
  .run.missed { background: var(--warning); }
  .run.error { background: var(--danger); }
  button.run { padding: 0; }
  button.run:hover { outline: 1px solid var(--text-faint); outline-offset: 1px; }
  .duty-when { display: flex; flex-wrap: wrap; align-items: center; column-gap: 6px; color: var(--text-faint); }
  .metrics { width: 100%; border-collapse: collapse; font-size: 12px; }
  .metrics th { text-align: left; font-weight: 500; color: var(--text-faint); padding: 1px 6px 1px 0; border-bottom: 1px solid var(--border); }
  .metrics td { padding: 1px 6px 1px 0; color: var(--text-muted); vertical-align: middle; }
  .metrics .num { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .metrics .miss { color: var(--warning); font-weight: 500; }
  .metrics .history { margin-left: 0; }
  .summary.before { color: var(--text-faint); }
  .link-chip { align-self: flex-start; }
  .owner-words, .board-goal { color: var(--text-faint); }
  .duty-error { margin: 6px 0 0; font-size: 12px; color: var(--danger); }
  .cadence { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
  .cadence-label { color: var(--text-faint); }
  .cadence input[type="number"] { width: 6ch; }
  .cadence input, .cadence select { font: inherit; font-size: 12px; padding: 0 4px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg); color: var(--text); }
  .cadence-error { color: var(--danger); }
</style>
