<script lang="ts">
  import { duration } from "./format.ts";
  import { pulseOf, statusOf, STATUS_LABEL } from "./organize.ts";
  import { childDetail, type ChildDetail } from "./children.ts";
  import { readPulse } from "../shared/pulse.ts";
  import type { ChildAgent, ChildPulse } from "../shared/types.ts";
  import type { JobView } from "./jobs.ts";
  import StatusMark from "./StatusMark.svelte";
  import Icon from "./Icon.svelte";

  /** The jobs of a chat, running first: each row opens the job drawer. `pulses` are the chat row's running subagent pulses by rlm child id. */
  let { jobs, pulses, now, checkIn, onopen }: {
    jobs: readonly JobView[]; pulses: ReadonlyMap<string, ChildPulse>; now: number; checkIn: { text: string; on: boolean }; onopen: (job: JobView) => void;
  } = $props();

  const readingOf = (child: ChildAgent) => { const pulse = child.status === "running" ? pulses.get(child.id) : undefined; return pulse ? readPulse(pulse, now) : null; };
  /** Line two of a started session: the catalog's status, then what it is doing or how it failed; "Not listed" when the catalog has no row for it. */
  function sessionDetail(job: Extract<JobView, { kind: "session" }>): ChildDetail {
    const { row } = job;
    if (!row) return { lead: "Not listed", text: "", tone: "quiet" };
    const status = statusOf(row, now);
    const pulse = pulseOf(row, now);
    if (pulse?.level === "failed") return { lead: "Failed", text: pulse.text, tone: "failed" };
    if (!row.working && row.failure) return { lead: STATUS_LABEL[status], text: row.failure, tone: "failed" };
    const text = pulse && pulse.level !== "live" ? pulse.text : row.status === "running" && row.statusLabel ? row.statusLabel
      : row.working && row.subagentsRunning > 0 ? `${row.subagentsRunning} ${row.subagentsRunning === 1 ? "subagent" : "subagents"} running` : "";
    return { lead: STATUS_LABEL[status], text, tone: status === "stalled" ? "stalled" : "" };
  }
</script>

<ul class="jobs" aria-label="Jobs">
  {#each jobs as job (job.key)}
    {#if job.kind === "child"}
    {@const child = job.child}
    {@const detail = childDetail(child, readingOf(child))}
    <li>
      <button type="button" class="job {child.status}" title={[job.name, detail.lead, detail.text].filter(Boolean).join("\n")}
        aria-label="{job.name}, {detail.lead || child.status}, open" onclick={() => onopen(job)}>
        <span class="job-line">
          <span class="state">
            {#if child.status === "running"}<StatusMark status="working" level={readingOf(child)?.level ?? "live"} />{:else}<span class="mark {child.status}" aria-hidden="true"></span>{/if}
          </span>
          <span class="job-name">{job.name}</span>
          {#if child.durationMs !== undefined}<span class="job-time">{duration(child.durationMs)}</span>{/if}
        </span>
        <span class="job-line detail {detail.tone}">
          {#if detail.lead}<span class="lead">{detail.lead}</span>{/if}
          {#if detail.text}<span class="detail-text">{detail.text}</span>{/if}
        </span>
      </button>
    </li>
    {:else}
    {@const detail = sessionDetail(job)}
    <li>
      <button type="button" class="job session" class:running={job.row?.working} title={[job.name, detail.lead, detail.text].filter(Boolean).join("\n")}
        aria-label="{job.name}, session, {detail.lead}, open" onclick={() => onopen(job)}>
        <span class="job-line">
          <span class="state">{#if job.row}<StatusMark status={statusOf(job.row, now)} level={pulseOf(job.row, now)?.level ?? "live"} />{:else}<span class="mark cancelled" aria-hidden="true"></span>{/if}</span>
          <span class="job-name">{job.name}</span>
          <span class="job-kind">session</span>
        </span>
        <span class="job-line detail {detail.tone}">
          {#if detail.lead}<span class="lead">{detail.lead}</span>{/if}
          {#if detail.text}<span class="detail-text">{detail.text}</span>{/if}
        </span>
      </button>
    </li>
    {/if}
  {/each}
  {#if !jobs.length}<li class="none">No jobs yet</li>{/if}
  <li class="check-in" class:on={checkIn.on}><Icon name="bolt" size={12} /><span>{checkIn.text}</span></li>
</ul>

<style>
  .jobs { list-style: none; margin: 0; padding: 8px 6px; display: flex; flex-direction: column; gap: 2px; }
  .job { display: flex; flex-direction: column; gap: 1px; width: 100%; padding: 5px 8px; border-radius: var(--radius-small); text-align: left; font-size: 12.5px; }
  .job:hover { background: var(--bg-hover); }
  .job-line { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .state { display: inline-flex; width: 12px; justify-content: center; flex: none; }
  .mark { width: 7px; height: 7px; border-radius: 50%; background: var(--success); }
  .mark.queued { background: transparent; border: 1.5px solid var(--accent); }
  .mark.error { background: var(--danger); }
  .mark.cancelled { background: var(--text-faint); }
  .job-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
  .job-time { flex: none; font-size: 11.5px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
  .job-kind { flex: none; font-size: 10.5px; color: var(--text-faint); padding: 0 4px; border: 1px solid var(--border); border-radius: 999px; line-height: 14px; }
  .detail { padding-left: 18px; font-size: 11.5px; line-height: 16px; color: var(--text-faint); }
  .detail.quiet .lead { color: var(--text-faint); font-weight: 400; }
  .lead { flex: none; color: var(--text-muted); font-weight: 500; }
  .running .lead, .queued .lead { color: var(--accent-bold); }
  .error .lead, .error .detail-text, .detail.failed .lead, .detail.failed .detail-text { color: var(--danger); }
  .detail.stalled .lead { color: var(--warning); }
  .detail-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .none { padding: 4px 8px; font-size: 12.5px; color: var(--text-faint); }
  .check-in { display: flex; align-items: center; gap: 6px; margin-top: 6px; padding: 5px 8px; border-top: 1px solid var(--border); font-size: 11.5px; color: var(--text-faint); }
  .check-in.on { color: var(--text-muted); }
</style>
