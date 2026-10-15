<script lang="ts">
  import { tick } from "svelte";
  import { api } from "./api.ts";
  import { compactNumber } from "./format.ts";
  import { outline, share, speakerOf, groupName, textHeight, type Speaker } from "./prompt-parts.ts";
  import type { PromptPart, PromptView } from "../shared/prompt-view.ts";
  import Modal from "./Modal.svelte";
  import Icon from "./Icon.svelte";

  let { threadId, narrow, onclose }: { threadId: string; narrow: boolean; onclose: () => void } = $props();

  let view = $state.raw<PromptView | null>(null);
  let error = $state<string | null>(null);
  $effect(() => {
    const id = threadId;
    let cancelled = false;
    view = null;
    error = null;
    api.promptView(id).then(result => { if (!cancelled) view = result; }, failure => { if (!cancelled) error = failure instanceof Error ? failure.message : String(failure); });
    return () => { cancelled = true; };
  });

  const parts = $derived(view ? outline(view) : null);
  const total = $derived(view?.totalTokens ?? 0);
  const number = $derived(new Map(parts?.messages.map((part, index) => [part.id, index + 1]) ?? []));
  let only = $state<string | null>(null);
  const shown = $derived(parts ? (only ? parts.messages.filter(part => groupName(part.label) === only) : parts.messages) : []);
  const SPEAKER: Record<Speaker, string> = { prompt: "", owner: "owner", injected: "injected", model: "model", tool: "tool" };

  let root: HTMLElement | undefined = $state();
  async function jump(id: string): Promise<void> {
    await tick();
    const target = document.getElementById("prompt-" + id);
    if (!target) return;
    target.scrollIntoView({ block: "start" });
    requestAnimationFrame(() => target.scrollIntoView({ block: "start" }));
    target.classList.remove("flash");
    void target.offsetWidth;
    target.classList.add("flash");
  }
  function pick(name: string): void {
    only = only === name ? null : name;
    void jump("conversation");
  }
  const tokens = (value: number) => value.toLocaleString();
  const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });
</script>

{#snippet bar(value: number)}
  <span class="share"><span class="track"><span class="fill" style:width="{total ? Math.max(1, value / total * 100) : 0}%"></span></span><span class="pct">{share(value, total)}</span></span>
{/snippet}

{#snippet block(part: PromptPart)}
  {@const who = speakerOf(part)}
  <section class="part {who}" id="prompt-{part.id}" style:contain-intrinsic-size="auto {textHeight(part.text) + 28}px">
    <div class="part-head">
      {#if part.role}<span class="num">#{number.get(part.id)}</span>{/if}
      <span class="label" title={part.label}>{part.label}</span>
      {#if SPEAKER[who]}<span class="who {who}">{SPEAKER[who]}</span>{/if}
      <span class="source" title={part.source}>{part.source}</span>
      <span class="tok">{tokens(part.tokens)}</span>
    </div>
    <pre class="text">{part.text}</pre>
  </section>
{/snippet}

<Modal title="Prompt" icon="layers" width="min(1120px, 94vw)" height="90vh" tall full={narrow} {onclose}>
  {#snippet header()}
    {#if view}
      <span class="summary">{compactNumber(view.totalTokens)} tokens, {view.origin.kind === "exact" ? "captured payload" : "rebuilt"}</span>
      <button type="button" class="button small" onclick={() => root?.scrollIntoView({ block: "start" })}><Icon name="chevronUp" size={12} />Parts</button>
    {/if}
  {/snippet}
  <div class="prompt" bind:this={root}>
    {#if error}<p class="note error">{error}</p>
    {:else if !view || !parts}<p class="note"><span class="spinner tiny"></span> Reading the prompt</p>
    {:else}
      <div class="facts">
        <div><strong>{tokens(view.totalTokens)}</strong> tokens in {view.parts.length} parts, counted as characters / 4{#if view.measuredInputTokens !== undefined}. The last call measured <strong>{tokens(view.measuredInputTokens)}</strong> input tokens{/if}.</div>
        {#if view.origin.kind === "exact"}
          <div class="origin">The exact payload sent to {view.origin.provider} {view.origin.model} at {when(view.origin.capturedAt)}.</div>
        {:else}
          <div class="origin"><span class="rebuild">Rebuilt, not the captured payload.</span> {view.origin.reason}</div>
        {/if}
        <div class="path" title={view.sessionFile}>{view.sessionFile}</div>
      </div>

      <nav class="outline" aria-label="Prompt parts">
        <div class="group-head"><span>Before the conversation</span><span class="tok">{tokens(parts.headTokens)}</span>{@render bar(parts.headTokens)}</div>
        {#each parts.head as part (part.id)}
          <button type="button" class="row" onclick={() => void jump(part.id)}>
            <span class="label" title={part.label}>{part.label}</span><span class="source" title={part.source}>{part.source}</span><span class="tok">{tokens(part.tokens)}</span>{@render bar(part.tokens)}
          </button>
        {/each}
        {#if !parts.head.length}<div class="row empty">None in this view.</div>{/if}
        <div class="group-head"><span>Conversation, {parts.messages.length} parts</span><span class="tok">{tokens(parts.messageTokens)}</span>{@render bar(parts.messageTokens)}</div>
        {#each parts.groups as group (group.name)}
          <button type="button" class="row" class:on={only === group.name} aria-pressed={only === group.name} onclick={() => pick(group.name)}>
            <span class="label"><span class="dot {group.speaker}"></span>{group.name}</span><span class="source">{group.count} {group.count === 1 ? "part" : "parts"}{only === group.name ? ", shown alone" : ""}</span><span class="tok">{tokens(group.tokens)}</span>{@render bar(group.tokens)}
          </button>
        {/each}
      </nav>

      {#each parts.head as part (part.id)}{@render block(part)}{/each}
      <div class="convo" id="prompt-conversation">
        <span>Conversation</span>
        {#if only}
          <span class="filter">{shown.length} of {parts.messages.length} parts, only {only}</span>
          <button type="button" class="button small" onclick={() => { only = null; }}>Show all</button>
        {/if}
      </div>
      {#each shown as part (part.id)}{@render block(part)}{/each}
    {/if}
  </div>
</Modal>

<style>
  .summary { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; color: var(--text-muted); font-variant-numeric: tabular-nums; }
  .prompt { padding: 12px 20px 40px; font-size: 13px; }
  .note { display: flex; align-items: center; gap: 8px; margin: 0; padding: 8px 0; color: var(--text-faint); }
  .note.error { color: var(--danger); }
  .facts { display: flex; flex-direction: column; gap: 2px; margin-bottom: 14px; color: var(--text-muted); line-height: 1.5; }
  .facts strong { font-weight: 600; color: var(--text); font-variant-numeric: tabular-nums; }
  .rebuild { font-weight: 600; color: var(--warning); }
  .path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); font-size: 11px; color: var(--text-faint); }
  .outline { display: grid; grid-template-columns: minmax(140px, 1.1fr) minmax(0, 2fr) 64px 132px; column-gap: 12px; margin-bottom: 18px; font-size: 12.5px; }
  .group-head, .row { display: grid; grid-column: 1 / -1; grid-template-columns: subgrid; align-items: center; }
  .group-head { padding: 8px 6px 3px; font-weight: 600; color: var(--text); }
  .group-head > span:first-child { grid-column: 1 / 3; }
  .row { min-height: 24px; padding: 0 6px; border-radius: var(--radius-small); text-align: left; color: var(--text); }
  .row:hover { background: var(--bg-hover); }
  .row.on { background: var(--accent-soft); }
  .row.empty { color: var(--text-faint); }
  .row .label { display: flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row .source { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-faint); }
  .tok { text-align: right; font-variant-numeric: tabular-nums; color: var(--text-muted); }
  .share { display: flex; align-items: center; gap: 8px; }
  .track { flex: 1; height: 3px; border-radius: 2px; background: var(--border); overflow: hidden; }
  .fill { display: block; height: 100%; background: var(--accent); }
  .pct { width: 40px; text-align: right; font-variant-numeric: tabular-nums; color: var(--text-faint); }
  .dot { width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--border-strong); }
  .dot.owner { background: var(--accent); }
  .dot.injected { background: var(--warning); }
  .dot.model { background: var(--text-muted); }
  .convo { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 10px; min-height: 36px; margin-top: 18px; border-bottom: 1px solid var(--border); background: var(--bg-elevated); font-weight: 600; }
  .filter { font-weight: 400; color: var(--text-muted); }
  .part { content-visibility: auto; padding: 10px 0 10px 12px; border-left: 2px solid transparent; scroll-margin-top: 44px; }
  .part + .part { border-top: 1px solid var(--border); }
  .part.owner { border-left-color: var(--accent); }
  .part.injected { border-left-color: var(--warning); }
  .part.tool { border-left-color: var(--border-strong); }
  .part-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; font-size: 12.5px; }
  .part-head .num { flex: none; font-variant-numeric: tabular-nums; color: var(--text-faint); }
  .part-head .label { flex: none; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
  .part-head .source { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-faint); }
  .part-head .tok { flex: none; }
  .who { flex: none; padding: 0 6px; border-radius: 999px; font-size: 11px; line-height: 17px; }
  .who.owner { color: var(--accent-bold); background: var(--accent-soft); }
  .who.injected { color: light-dark(#8a4b00, #fbbf24); background: color-mix(in srgb, var(--warning) 14%, transparent); }
  .who.model, .who.tool { color: var(--text-muted); background: var(--bg-hover); }
  .text { margin: 0; font-family: var(--mono); font-size: 12px; line-height: 18px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text); tab-size: 4; }
  .part.model .text, .part.tool .text { color: var(--text-muted); }
  .part:global(.flash) { animation: flash 1.2s ease-out; }
  @keyframes flash { from { background: var(--accent-soft); } to { background: transparent; } }
  @container app (max-width: 899px) {
    .prompt { padding: 10px 12px 32px; }
    .outline { grid-template-columns: minmax(0, 1fr) 56px 84px; }
    .row .source { display: none; }
    .group-head > span:first-child { grid-column: 1; }
    .part-head .source { display: none; }
  }
</style>
