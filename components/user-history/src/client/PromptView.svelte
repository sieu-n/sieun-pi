<script lang="ts">
  import Spinner from "./Spinner.svelte";
  import { api } from "./api.ts";
  import { compactNumber } from "./format.ts";
  import { clip, labelDetail, LEAD_KEY, outline, preview, share, speakerOf, type PromptRow, type Speaker } from "./prompt-parts.ts";
  import { DUTY_BRIEF, type PromptPart, type PromptTarget, type PromptView } from "../shared/prompt-view.ts";
  import Modal from "./Modal.svelte";
  import Icon from "./Icon.svelte";

  /**
   * The prompt a session's model gets, as the summary table: the parts before the conversation, then the conversation by source kind. Each row
   * opens in place: a source kind lists its parts in time order as one line each, and a part opens to its text. A job's subagents link to their
   * own view, opened through `via` so an ended subagent the daemon no longer lists still opens. A duty job's brief (`DUTY_BRIEF`) is listed first
   * and opens with the view; a duty with no job yet (`target` names the chat and duty) shows the brief its next run sends.
   */
  let { target, narrow, onclose }: { target: PromptTarget; narrow: boolean; onclose: () => void } = $props();
  const sessionId = $derived(typeof target === "string" ? target : `${target.chat}/${target.duty}`);

  /** The subagents opened from this view, each below the one before; the view shows the last. */
  let below = $state<{ id: string; name: string }[]>([]);
  const trail = $derived<{ id: string; name?: string }[]>([{ id: sessionId }, ...below]);
  const current = $derived(trail[trail.length - 1]!);
  let view = $state.raw<PromptView | null>(null);
  let error = $state<string | null>(null);
  $effect(() => {
    const id = current.id;
    const via = trail.slice(0, -1).map(step => step.id);
    let cancelled = false;
    view = null;
    error = null;
    collapseAll();
    const load = typeof target !== "string" && !via.length ? api.nextDutyBrief(target.chat, target.duty) : api.promptView(id, via);
    load.then(result => {
      if (cancelled) return;
      view = result;
      if (result.title) titles = { ...titles, [id]: result.title };
      if (result.parts.some(part => part.label === DUTY_BRIEF)) rows = { [LEAD_KEY]: true };
    }, failure => { if (!cancelled) error = failure instanceof Error ? failure.message : String(failure); });
    return () => { cancelled = true; };
  });

  const table = $derived(view ? outline(view) : null);
  const total = $derived(view?.totalTokens ?? 0);
  const number = $derived(new Map(view?.parts.filter(part => part.role).map((part, index) => [part.id, index + 1]) ?? []));
  let titles = $state<Record<string, string>>({});
  const nameOf = (step: { id: string; name?: string }): string => titles[step.id] ?? step.name ?? step.id.slice(0, 8);

  let rows = $state<Record<string, boolean>>({});
  let parts = $state<Record<string, boolean>>({});
  let whole = $state<Record<string, boolean>>({});
  let subagentsOpen = $state(false);
  function collapseAll(): void { rows = {}; parts = {}; whole = {}; subagentsOpen = false; }
  function expandAll(): void { if (table) rows = Object.fromEntries([...table.lead ? [table.lead] : [], ...table.rows, ...table.groups].map(row => [row.key, true])); }
  const flip = (record: Record<string, boolean>, key: string): Record<string, boolean> => ({ ...record, [key]: !record[key] });

  const SPEAKER: Record<Speaker, string> = { prompt: "", owner: "owner", injected: "injected", model: "model", tool: "tool" };
  const tokens = (value: number) => value.toLocaleString();
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  function when(iso: string, seconds = false): string {
    const date = new Date(iso);
    const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}) });
    return sameDay(date, new Date()) ? time : date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + time;
  }
</script>

{#snippet bar(value: number)}
  <span class="share"><span class="track"><span class="fill" style:width="{total ? Math.max(1, value / total * 100) : 0}%"></span></span><span class="pct">{share(value, total)}</span></span>
{/snippet}

{#snippet text(part: PromptPart)}
  {@const shown = whole[part.id] ? { text: part.text, more: 0 } : clip(part.text)}
  <div class="text {speakerOf(part)}">
    <pre>{shown.text}</pre>
    {#if shown.more}<button type="button" class="more" onclick={() => { whole = flip(whole, part.id); }}>Show all, {shown.more.toLocaleString()} more {shown.more === 1 ? "line" : "lines"}</button>
    {:else if whole[part.id]}<button type="button" class="more" onclick={() => { whole = flip(whole, part.id); }}>Show less</button>{/if}
  </div>
{/snippet}

{#snippet partLine(part: PromptPart, row: PromptRow)}
  {@const open = parts[part.id] === true}
  {@const detail = row.parts.length > 1 && row.key.startsWith("h:") ? part.label.replace(/^Tool: /, "") : labelDetail(part.label)}
  {@const who = speakerOf(part)}
  <button type="button" class="line" aria-expanded={open} onclick={() => { parts = flip(parts, part.id); }}>
    <span class="lead"><span class="chev" class:open><Icon name="chevronDown" size={10} /></span>{#if number.get(part.id)}<span class="num">#{number.get(part.id)}</span>{/if}{#if detail}<span class="detail">{detail}</span>{/if}{#if SPEAKER[who] && row.speaker !== who}<span class="who {who}">{SPEAKER[who]}</span>{/if}<span class="gist">{preview(part)}</span></span>
    <span class="tok">{tokens(part.tokens)}</span>
    <span class="at">{part.at ? when(part.at) : ""}</span>
  </button>
  {#if open}{@render text(part)}{/if}
{/snippet}

{#snippet tableRow(row: PromptRow)}
  {@const open = rows[row.key] === true}
  <button type="button" class="row" aria-expanded={open} onclick={() => { rows = flip(rows, row.key); }}>
    <span class="label" title={row.label}><span class="chev" class:open><Icon name="chevronDown" size={11} /></span>{#if row.speaker !== "prompt"}<span class="dot {row.speaker}"></span>{/if}{row.label}</span><span class="source" title={row.source}>{row.source}</span><span class="tok">{tokens(row.tokens)}</span>{@render bar(row.tokens)}
  </button>
  {#if open}
    <div class="body">
      {#if row.parts.length === 1 && (!row.parts[0]!.role || row.key === LEAD_KEY)}{@render text(row.parts[0]!)}
      {:else}{#each row.parts as part (part.id)}{@render partLine(part, row)}{/each}{/if}
    </div>
  {/if}
{/snippet}

<Modal title="Prompt" icon="layers" width="min(1120px, 94vw)" height="90vh" tall full={narrow} {onclose}>
  {#snippet header()}
    <span class="summary">{#if view}About {compactNumber(view.totalTokens)} tokens{#if view.measuredInputTokens !== undefined}, {compactNumber(view.measuredInputTokens)} measured{/if}, {view.origin.kind === "exact" ? "captured payload" : "rebuilt"}{/if}</span>
    {#if table}
      <button type="button" class="button small" onclick={expandAll}>Expand all</button>
      <button type="button" class="button small" onclick={collapseAll}>Collapse all</button>
    {/if}
  {/snippet}
  <div class="prompt">
    {#if trail.length > 1 || view?.title}
      <div class="crumbs">
        {#each trail as step, index (step.id)}
          {#if index}<Icon name="chevronRight" size={11} />{/if}
          {#if index === trail.length - 1}<span class="here">{nameOf(step)}</span>
          {:else}<button type="button" class="link-chip" onclick={() => { below = below.slice(0, index); }}><span class="chip-label">{nameOf(step)}</span></button>{/if}
        {/each}
      </div>
    {/if}
    {#if error}<p class="note error">{error}</p>
    {:else if !view || !table}<p class="note"><Spinner /> Reading the prompt</p>
    {:else}
      <div class="facts">
        <div>About <strong>{tokens(view.totalTokens)}</strong> tokens in {view.parts.length} parts, estimated as characters / 4{#if view.measuredInputTokens !== undefined}. The provider measured <strong>{tokens(view.measuredInputTokens)}</strong> input tokens on the last call{/if}. Every count below is the same estimate.</div>
        {#if view.origin.kind === "exact"}
          <div class="origin">The exact payload sent to {view.origin.provider} {view.origin.model} at {when(view.origin.capturedAt, true)}.</div>
        {:else}
          <div class="origin"><span class="rebuild">Rebuilt, not the captured payload.</span> {view.origin.reason}</div>
        {/if}
        {#if view.subagents?.length}
          <div class="subagents">
            <button type="button" class="fold" aria-expanded={subagentsOpen} onclick={() => { subagentsOpen = !subagentsOpen; }}><span class="chev" class:open={subagentsOpen}><Icon name="chevronDown" size={11} /></span>Spawned {view.subagents.length} {view.subagents.length === 1 ? "subagent" : "subagents"}, each with its own prompt</button>
            {#if subagentsOpen}
              {#each view.subagents as child (child.sessionId)}<button type="button" class="link-chip" title="Open its prompt" onclick={() => { below = [...below, { id: child.sessionId, name: child.name }]; }}><Icon name="layers" size={11} /><span class="chip-label">{child.name}</span></button>{/each}
            {/if}
          </div>
        {/if}
        <div class="path" title={view.sessionFile}>{view.sessionFile}</div>
      </div>

      <nav class="outline" aria-label="Prompt parts">
        {#if table.lead}{@render tableRow(table.lead)}{/if}
        <div class="group-head"><span>Before the conversation</span><span class="tok">{tokens(table.headTokens)}</span>{@render bar(table.headTokens)}</div>
        {#each table.rows as row (row.key)}{@render tableRow(row)}{/each}
        {#if !table.rows.length}<div class="row empty">None in this view.</div>{/if}
        <div class="group-head"><span>Conversation, {table.messageParts} parts</span><span class="tok">{tokens(table.messageTokens)}</span>{@render bar(table.messageTokens)}</div>
        {#each table.groups as row (row.key)}{@render tableRow(row)}{/each}
      </nav>
    {/if}
  </div>
</Modal>

<style>
  .summary { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; color: var(--text-muted); font-variant-numeric: tabular-nums; }
  .prompt { padding: 12px 20px 40px; font-size: 13px; }
  .crumbs { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; font-size: 12.5px; color: var(--text-faint); }
  .crumbs .here { font-weight: 600; color: var(--text); }
  .note { display: flex; align-items: center; gap: 8px; margin: 0; padding: 8px 0; color: var(--text-faint); }
  .note.error { color: var(--danger); }
  .facts { display: flex; flex-direction: column; gap: 2px; margin-bottom: 14px; color: var(--text-muted); line-height: 1.5; }
  .facts strong { font-weight: 600; color: var(--text); font-variant-numeric: tabular-nums; }
  .rebuild { font-weight: 600; color: var(--warning); }
  .subagents { display: flex; flex-wrap: wrap; align-items: center; column-gap: 10px; }
  .fold { display: inline-flex; align-items: center; gap: 4px; color: var(--text-muted); }
  .fold:hover { color: var(--text); }
  .path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); font-size: 11px; color: var(--text-faint); }
  .outline { display: grid; grid-template-columns: minmax(140px, 1.1fr) minmax(0, 2fr) 64px 132px; column-gap: 12px; font-size: 12.5px; }
  .group-head, .row, .line { display: grid; grid-column: 1 / -1; grid-template-columns: subgrid; align-items: center; }
  .group-head { padding: 8px 6px 3px; font-weight: 600; color: var(--text); }
  .group-head > span:first-child { grid-column: 1 / 3; }
  .row { min-height: 24px; padding: 0 6px; border-radius: var(--radius-small); text-align: left; color: var(--text); }
  .row:hover, .line:hover { background: var(--bg-hover); }
  .row[aria-expanded="true"] { position: sticky; top: 0; z-index: 1; font-weight: 500; background: var(--bg-elevated); }
  .row[aria-expanded="true"]:hover { background: color-mix(in srgb, var(--bg-hover) 100%, var(--bg-elevated)); }
  .row.empty { color: var(--text-faint); }
  .row .label { display: flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row .source { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 400; color: var(--text-faint); }
  .chev { display: inline-flex; flex: none; color: var(--text-faint); transform: rotate(-90deg); transition: transform 0.12s; }
  .chev.open { transform: none; }
  .tok { text-align: right; font-weight: 400; font-variant-numeric: tabular-nums; color: var(--text-muted); }
  .share { display: flex; align-items: center; gap: 8px; }
  .track { flex: 1; height: 3px; border-radius: 2px; background: var(--border); overflow: hidden; }
  .fill { display: block; height: 100%; background: var(--accent); }
  .pct { width: 40px; text-align: right; font-weight: 400; font-variant-numeric: tabular-nums; color: var(--text-faint); }
  .dot { width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--border-strong); }
  .dot.owner { background: var(--accent); }
  .dot.injected { background: var(--warning); }
  .dot.model { background: var(--text-muted); }
  .body { display: grid; grid-column: 1 / -1; grid-template-columns: subgrid; padding: 0 0 6px 22px; }
  .line { min-height: 22px; padding: 0 6px; border-radius: var(--radius-small); text-align: left; color: var(--text-muted); }
  .line .lead { grid-column: 1 / 3; display: flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; white-space: nowrap; }
  .line .num { flex: none; font-variant-numeric: tabular-nums; color: var(--text-faint); }
  .line .detail { flex: none; max-width: 30%; overflow: hidden; text-overflow: ellipsis; color: var(--text); }
  .line .gist { min-width: 0; overflow: hidden; text-overflow: ellipsis; font-family: var(--mono); font-size: 11.5px; }
  .line .at { font-variant-numeric: tabular-nums; text-align: right; color: var(--text-faint); white-space: nowrap; }
  .who { flex: none; padding: 0 6px; border-radius: 999px; font-size: 11px; line-height: 17px; }
  .who.owner { color: var(--accent-bold); background: var(--accent-soft); }
  .who.injected { color: light-dark(#8a4b00, #fbbf24); background: color-mix(in srgb, var(--warning) 14%, transparent); }
  .who.model, .who.tool { color: var(--text-muted); background: var(--bg-hover); }
  .text { grid-column: 1 / -1; margin: 2px 0 8px 6px; padding-left: 10px; border-left: 2px solid var(--border); }
  .text.owner { border-left-color: var(--accent); }
  .text.injected { border-left-color: var(--warning); }
  .text pre { margin: 0; font-family: var(--mono); font-size: 12px; line-height: 18px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text); tab-size: 4; }
  .text.model pre, .text.tool pre { color: var(--text-muted); }
  .more { margin-top: 2px; font-size: 12px; color: var(--accent); }
  .more:hover { text-decoration: underline; }
  @container app (max-width: 899px) {
    .prompt { padding: 10px 12px 32px; }
    .outline { grid-template-columns: minmax(0, 1fr) 56px 84px; }
    .row .source { display: none; }
    .group-head > span:first-child, .line .lead { grid-column: 1; }
    .line .at { display: none; }
    .body { padding-left: 10px; }
  }
</style>
