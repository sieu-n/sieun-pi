<script lang="ts">
  import { api } from "./api.ts";
  import { store } from "./store.svelte.ts";
  import { clockTime, duration } from "./format.ts";
  import { elapsed, modelShort, pulseOf, statusOf, STATUS_LABEL } from "./organize.ts";
  import { childDetail } from "./children.ts";
  import { readPulse } from "../shared/pulse.ts";
  import type { ChildPulse } from "../shared/types.ts";
  import { isActiveJob, type JobReport, type JobView } from "./jobs.ts";
  import { renderMarkdown, copyFromClick } from "./markdown.ts";
  import StatusMark from "./StatusMark.svelte";
  import Icon from "./Icon.svelte";

  /**
   * One job of a chat, over the side panel: what it is, what it is doing, every message it sent the chat in full (newest first), the brief
   * it got, and the way into its own thread. Esc closes.
   */
  let { name, job, reports, brief, pulses, now, cwd = "", onclose }: {
    name: string; job: JobView | null; reports: readonly JobReport[]; brief: string | null; pulses: ReadonlyMap<string, ChildPulse>; now: number; cwd?: string; onclose: () => void;
  } = $props();

  const reading = $derived(job?.kind === "child" && job.child.status === "running" ? (pulses.get(job.child.id) ? readPulse(pulses.get(job.child.id)!, now) : null) : null);
  const head = $derived.by(() => {
    if (!job) return { lead: "Not started yet", text: "", tone: "quiet" as const };
    if (job.kind === "child") return job.child.status === "done" ? { lead: "Done", text: "", tone: "" as const } : childDetail(job.child, reading);
    const { row } = job;
    if (!row) return { lead: "Not listed", text: "", tone: "quiet" as const };
    const pulse = pulseOf(row, now);
    if (pulse?.level === "failed") return { lead: "Failed", text: pulse.text, tone: "failed" as const };
    if (!row.working && row.failure) return { lead: STATUS_LABEL[statusOf(row, now)], text: row.failure, tone: "failed" as const };
    return { lead: STATUS_LABEL[statusOf(row, now)], text: pulse && pulse.level !== "live" ? pulse.text : row.statusLabel ?? "", tone: "" as const };
  });
  const active = $derived(job ? isActiveJob(job) : false);
  const time = $derived.by(() => {
    if (!job) return "";
    if (job.kind === "child") return job.child.durationMs === undefined ? "" : duration(job.child.durationMs);
    const started = Date.parse(job.row?.created ?? "");
    const last = Date.parse(job.row?.lastActivityAt ?? "");
    return Number.isFinite(started) && Number.isFinite(last) ? elapsed(Math.max(0, (job.row?.working ? now : last) - started)) : "";
  });
  const model = $derived(job ? modelShort(job.kind === "child" ? job.child.model : job.row?.model) : "");
  const sessionId = $derived(job?.sessionId ?? null);
  const status = $derived(job ? job.kind === "child" ? job.child.status : job.row ? statusOf(job.row, now) : "saved" : "");

  let stopping = $state(false);
  async function stop(): Promise<void> {
    if (!sessionId || stopping) return;
    stopping = true;
    try { await store.run(api.abort(sessionId)); } finally { stopping = false; }
  }
  function onKey(event: KeyboardEvent): void {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if (event.target instanceof HTMLElement && event.target.closest("input, textarea, [contenteditable]")) return;
    event.preventDefault();
    onclose();
  }
  let briefOpen = $state(false);
</script>

<svelte:window onkeydown={onKey} />

<aside class="drawer fade-in" aria-label="Job {name}">
  <header class="drawer-head">
    <button type="button" class="icon-button" aria-label="Close" onclick={onclose}><Icon name="chevronLeft" /></button>
    <div class="who">
      <div class="name-line">
        <span class="state">
          {#if job?.kind === "child" && job.child.status === "running"}<StatusMark status="working" level={reading?.level ?? "live"} />
          {:else if job?.kind === "session" && job.row}<StatusMark status={statusOf(job.row, now)} level={pulseOf(job.row, now)?.level ?? "live"} />
          {:else}<span class="mark {status}" aria-hidden="true"></span>{/if}
        </span>
        <span class="name">{name}</span>
        {#if job?.kind === "session"}<span class="kind">session</span>{/if}
      </div>
      <div class="meta {head.tone}">
        {#if head.lead}<span class="lead">{head.lead}</span>{/if}
        {#if head.text}<span class="meta-text">{head.text}</span>{/if}
        {#if time}<span class="dot-sep"></span><span>{time}</span>{/if}
        {#if model}<span class="dot-sep"></span><span>{model}</span>{/if}
      </div>
    </div>
    <div class="actions">
      {#if sessionId}<button type="button" class="button small" onclick={() => store.select(sessionId)}>Open full thread</button>{/if}
      {#if active && sessionId}<button type="button" class="button small danger" disabled={stopping} onclick={() => void stop()}><Icon name="stop" size={12} />Stop</button>{/if}
    </div>
  </header>
  <div class="drawer-body">
    {#if job?.kind === "child" && job.child.error}<div class="failure">{job.child.error}</div>{/if}
    <section>
      <h3>Messages to the chat{#if reports.length}<span class="count">{reports.length}</span>{/if}</h3>
      {#each reports as report (report.id)}
        <article class="report">
          <div class="stamp">{clockTime(report.at)}</div>
          <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
          <div class="prose small" onclick={copyFromClick}>{@html renderMarkdown(report.body, cwd)}</div>
        </article>
      {/each}
      {#if !reports.length}<p class="none">{active ? "Nothing sent yet." : "It sent nothing to the chat."}</p>{/if}
    </section>
    {#if brief}
      <section>
        <h3><button type="button" class="fold" aria-expanded={briefOpen} onclick={() => { briefOpen = !briefOpen; }}><span class="chev" class:open={briefOpen}><Icon name="chevronDown" size={11} /></span>Brief it got</button></h3>
        {#if briefOpen}<pre class="brief">{brief}</pre>{/if}
      </section>
    {/if}
  </div>
</aside>

<style>
  .drawer { position: absolute; top: 0; right: 0; bottom: 0; z-index: 30; display: flex; flex-direction: column; width: min(460px, 100%); background: var(--bg); border-left: 1px solid var(--border); box-shadow: var(--shadow); }
  .drawer-head { display: flex; align-items: flex-start; gap: 6px; padding: 8px 10px 8px 6px; border-bottom: 1px solid var(--border); }
  .drawer-head .icon-button { width: 28px; height: 28px; flex: none; margin-top: 2px; }
  .who { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; padding-top: 4px; }
  .name-line { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .state { display: inline-flex; width: 12px; justify-content: center; flex: none; }
  .mark { width: 7px; height: 7px; border-radius: 50%; background: var(--text-faint); }
  .mark.done { background: var(--success); }
  .mark.queued { background: transparent; border: 1.5px solid var(--accent); }
  .mark.error { background: var(--danger); }
  .name { font-weight: 600; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .kind { flex: none; font-size: 10.5px; color: var(--text-faint); padding: 0 4px; border: 1px solid var(--border); border-radius: 999px; line-height: 14px; }
  .meta { display: flex; align-items: center; flex-wrap: wrap; gap: 5px; font-size: 12px; color: var(--text-faint); line-height: 16px; }
  .lead { color: var(--text-muted); font-weight: 500; }
  .meta.failed .lead, .meta.failed .meta-text { color: var(--danger); }
  .meta.stalled .lead { color: var(--warning); }
  .meta.quiet .lead { color: var(--text-faint); font-weight: 400; }
  .meta-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
  .dot-sep { width: 3px; height: 3px; border-radius: 50%; background: var(--text-faint); }
  .actions { display: flex; flex: none; flex-direction: column; align-items: flex-end; gap: 4px; padding-top: 2px; }
  .drawer-body { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 14px 24px; display: flex; flex-direction: column; gap: 18px; }
  .failure { padding: 8px 10px; border-radius: var(--radius-small); background: var(--danger-soft); color: var(--danger); font-size: 12.5px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
  h3 { display: flex; align-items: baseline; gap: 8px; margin: 0 0 8px; font-size: 11.5px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .count { font-size: 11px; font-weight: 500; color: var(--text-faint); }
  .fold { display: inline-flex; align-items: center; gap: 4px; font: inherit; color: inherit; text-transform: inherit; letter-spacing: inherit; border-radius: 4px; }
  .fold:hover { color: var(--text); }
  .chev { display: inline-flex; transform: rotate(-90deg); transition: transform 0.12s; }
  .chev.open { transform: none; }
  .report { padding: 10px 12px; margin-bottom: 8px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-elevated); }
  .stamp { margin-bottom: 6px; font-size: 11px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
  .prose.small { font-size: 13.5px; line-height: 1.55; }
  .prose.small :global(h1), .prose.small :global(h2), .prose.small :global(h3), .prose.small :global(h4) { font-size: 1.06em; margin: 1em 0 0.4em; }
  .none { margin: 0; font-size: 12.5px; color: var(--text-faint); }
  .brief { margin: 0; padding: 10px 12px; border-radius: var(--radius); background: var(--bg-sunken); border: 1px solid var(--border); font-size: 12px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--mono); color: var(--text-muted); }
  @container app (max-width: 899px) {
    .drawer { width: 100%; border-left: 0; box-shadow: none; }
    .actions { flex-direction: row; }
  }
</style>
