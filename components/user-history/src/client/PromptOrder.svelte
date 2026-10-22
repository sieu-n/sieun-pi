<script lang="ts">
  import { DUTY_BRIEF, type PromptPart, type PromptView } from "../shared/prompt-view.ts";
  import Icon from "./Icon.svelte";
  import { clip, preview, share, speakerOf, type Speaker } from "./prompt-parts.ts";
  import { API_ORDER, briefTurn, orderTree, stepLabel, turnLabel, when, type HeadRow, type Turn } from "./prompt-order.ts";
  import { tooltip } from "./ui/tooltip.ts";

  /**
   * The prompt in the order the provider reads it, for debugging the harness: the parts before the conversation, each named by where it comes
   * from, then one row per incoming message that opens into the blocks the context hook added to it and the model's work after it, each tool
   * call with its result under it. A turn renders its rows only when open, and a closed turn is skipped by layout (content-visibility).
   */
  let { view }: { view: PromptView } = $props();

  const tree = $derived(orderTree(view));
  const total = $derived(view.totalTokens);
  const rebuilt = $derived(view.origin.kind === "rebuild");

  /** Open rows by key: sections, head rows, turns and parts all share it. */
  let open = $state<Record<string, boolean>>({});
  let whole = $state<Record<string, boolean>>({});
  /** Open and close in place, so a click updates only the rows that read that key. */
  const flip = (key: string) => { open[key] = !open[key]; };

  /**
   * The top-level rows drawn so far: the first screen at once, the rest in chunks on idle, so a session with hundreds of messages draws its first
   * screen without waiting for the rest. Rows only append below, so scroll position and the sticky open row hold; an open key opens a row
   * drawn later too, so Expand all holds.
   */
  const FIRST = 40;
  const CHUNK = 80;
  let drawn = $state(FIRST);
  $effect(() => {
    const count = tree.turns.length;
    drawn = FIRST;
    if (count <= FIRST) return;
    const idle = (step: () => void): (() => void) => {
      if (typeof requestIdleCallback === "function") { const id = requestIdleCallback(step, { timeout: 50 }); return () => cancelIdleCallback(id); }
      const id = setTimeout(step, 0);
      return () => clearTimeout(id);
    };
    // The chunks start after the first screen is painted, so they never delay it.
    let cancel = (): void => {};
    const frame = requestAnimationFrame(() => { cancel = idle(function more() { drawn += CHUNK; if (drawn < count) cancel = idle(more); }); });
    return () => { cancelAnimationFrame(frame); cancel(); };
  });

  $effect(() => {
    const brief = briefTurn(tree);
    open = { ...Object.fromEntries(tree.head.map(section => [section.key, true])), ...brief ? { [brief.key]: true, [brief.lead!.id]: true } : {} };
    whole = {};
  });

  export function expandAll(): void {
    const keys = [...tree.head.flatMap(section => [section.key, ...section.rows.filter(row => row.children).map(row => row.key)]), ...tree.turns.map(turn => turn.key)];
    for (const key of keys) open[key] = true;
  }
  export function collapseAll(): void { open = {}; whole = {}; }

  const tokens = (value: number) => value.toLocaleString();
  const SPEAKER: Record<Speaker, string> = { prompt: "", owner: "owner", injected: "injected", model: "model", tool: "tool" };
  const number = (part: PromptPart | null) => part?.message !== undefined ? `#${part.message + 1}` : "";
  const resultLabel = (part: PromptPart) => part.label.endsWith("(error)") ? "Result, error" : "Result";
</script>

{#snippet bar(value: number)}
  <span class="share"><span class="track"><span class="fill" style:width="{total ? Math.max(1, value / total * 100) : 0}%"></span></span><span class="pct">{share(value, total)}</span></span>
{/snippet}

{#snippet text(key: string, body: string, speaker: Speaker)}
  {@const shown = whole[key] ? { text: body, more: 0 } : clip(body)}
  <div class="text {speaker}">
    <pre>{shown.text}</pre>
    {#if shown.more}<button type="button" class="more" onclick={() => { whole[key] = true; }}>Show all, {shown.more.toLocaleString()} more {shown.more === 1 ? "line" : "lines"}</button>
    {:else if whole[key]}<button type="button" class="more" onclick={() => { whole[key] = false; }}>Show less</button>{/if}
  </div>
{/snippet}

{#snippet headRow(row: HeadRow, depth: number)}
  {#if row.placeholder}
    <div class="row line missing" style:--depth={depth}>
      <span class="lead"><span class="chev blank"></span><span class="name">{row.label}</span><span class="tag missing" use:tooltip={"A rebuild reads only the session file, so this part of the payload is not shown."}>not captured</span><span class="source">{row.source}</span></span>
      <span class="tok faint">?</span><span></span><span></span>
    </div>
  {:else}
    {@const isOpen = open[row.key] === true}
    <button type="button" class="row line" style:--depth={depth} aria-expanded={isOpen} onclick={() => flip(row.key)}>
      <span class="lead"><span class="chev" class:open={isOpen}><Icon name="chevronDown" size={10} /></span><span class="name" title={row.label}>{row.label}</span>{#if row.children}<span class="count">{row.children.length - 1} skills</span>{/if}<span class="source" title={row.source}>{row.source}</span></span>
      <span class="tok">{tokens(row.tokens)}</span>{@render bar(row.tokens)}<span></span>
    </button>
    {#if isOpen}
      {#if row.children}{#each row.children as child (child.key)}{@render headRow(child, depth + 1)}{/each}
      {:else}<div class="indent" style:--depth={depth}>{@render text(row.key, row.part?.text ?? row.text ?? "", "prompt")}</div>{/if}
    {/if}
  {/if}
{/snippet}

{#snippet partRow(part: PromptPart, label: string, depth: number, source?: string)}
  {@const isOpen = open[part.id] === true}
  {@const who = speakerOf(part)}
  <button type="button" class="row line" style:--depth={depth} aria-expanded={isOpen} onclick={() => flip(part.id)}>
    <span class="lead"><span class="chev" class:open={isOpen}><Icon name="chevronDown" size={10} /></span>{#if SPEAKER[who]}<span class="dot {who}"></span>{/if}<span class="name">{label}</span>{#if part.hook}<span class="tag hook" use:tooltip={part.source}>added by the context hook</span>{/if}{#if source}<span class="source short" title={source}>{source}</span>{/if}<span class="gist">{preview(part)}</span></span>
    <span class="tok">{tokens(part.tokens)}</span>{@render bar(part.tokens)}<span class="at">{part.at ? when(part.at) : ""}</span>
  </button>
  {#if isOpen}<div class="indent" style:--depth={depth}>{@render text(part.id, part.text, who)}</div>{/if}
{/snippet}

{#snippet turnRows(turn: Turn)}
  {#if turn.lead}{@render partRow(turn.lead, "Message", 1, turn.lead.hook ? undefined : turn.lead.source)}{/if}
  {#each turn.added as part (part.id)}{@render partRow(part, part.label, 1)}{/each}
  {#each turn.steps as step (step.part.id)}
    {@render partRow(step.part, step.part.role === "toolResult" ? resultLabel(step.part) : stepLabel(step.part), 1)}
    {#each step.results as result (result.id)}{@render partRow(result, resultLabel(result), 2)}{/each}
  {/each}
{/snippet}

<div class="order">
  <p class="how">{#if tree.api}{API_ORDER[tree.api]}{" "}{/if}Each row names where its part comes from.{#if rebuilt}{" "}<span class="warn">Rebuilt from the session file:</span> rows marked not captured stand where the payload holds parts a rebuild cannot know.{/if}</p>

  <div class="group-head"><span>Before the conversation</span><span class="tok">{tokens(tree.headTokens)}</span>{@render bar(tree.headTokens)}<span></span></div>
  {#each tree.head as section (section.key)}
    {@const isOpen = open[section.key] === true}
    <div class="head-section">
      <button type="button" class="row section" aria-expanded={isOpen} onclick={() => flip(section.key)}>
        <span class="lead"><span class="chev" class:open={isOpen}><Icon name="chevronDown" size={11} /></span><span class="name">{section.title}</span></span>
        {#if section.rows.every(row => row.placeholder)}<span class="tok faint">?</span><span></span>{:else}<span class="tok">{tokens(section.tokens)}</span>{@render bar(section.tokens)}{/if}<span></span>
      </button>
      {#if isOpen}{#each section.rows as row (row.key)}{@render headRow(row, 1)}{/each}{/if}
    </div>
  {/each}
  {#if !tree.head.length}<div class="row empty"><span class="lead">None in this payload.</span></div>{/if}

  <div class="group-head"><span>Conversation, {tree.turns.length.toLocaleString()} incoming {tree.turns.length === 1 ? "message" : "messages"}</span><span class="tok">{tokens(tree.turnTokens)}</span>{@render bar(tree.turnTokens)}<span></span></div>
  {#each tree.turns.slice(0, drawn) as turn (turn.key)}
    {@const isOpen = open[turn.key] === true}
    {@const who = turn.lead ? speakerOf(turn.lead) : "model"}
    <section class="turn" class:open={isOpen}>
      <button type="button" class="row top" aria-expanded={isOpen} onclick={() => flip(turn.key)}>
        <span class="lead"><span class="chev" class:open={isOpen}><Icon name="chevronDown" size={11} /></span><span class="dot {who}"></span><span class="num">{number(turn.lead)}</span><span class="name" title={turnLabel(turn)}>{turnLabel(turn)}</span>{#if turn.lead?.hook}<span class="tag hook" use:tooltip={turn.lead.source}>added by the context hook</span>{/if}{#if turn.midTurn}<span class="tag mid" use:tooltip={"It arrived while the model was in a tool loop; the work after it continues that loop."}>mid-turn</span>{/if}{#if turn.steps.length}<span class="count">{turn.steps.length} {turn.steps.length === 1 ? "step" : "steps"}</span>{/if}{#if turn.lead}<span class="gist">{preview(turn.lead)}</span>{/if}</span>
        <span class="tok">{tokens(turn.tokens)}</span>{@render bar(turn.tokens)}<span class="at">{turn.at ? when(turn.at) : ""}</span>
      </button>
      {#if isOpen}<div class="children">{@render turnRows(turn)}</div>{/if}
    </section>
  {/each}
  {#if !tree.turns.length}<div class="row empty"><span class="lead">No messages.</span></div>{/if}
</div>

<style>
  .order { --cols: minmax(0, 1fr) 64px 112px 104px; font-size: 12.5px; }
  .how { margin: 0 0 6px; padding: 0 6px; color: var(--text-faint); line-height: 1.5; }
  .warn { font-weight: 600; color: var(--warning); }
  .group-head, .row { display: grid; grid-template-columns: var(--cols); column-gap: 12px; align-items: center; }
  .group-head { padding: 8px 6px 3px; font-weight: 600; color: var(--text); }
  .row { width: 100%; min-height: 24px; padding: 0 6px; border-radius: var(--radius-small); text-align: left; color: var(--text); }
  button.row:hover { background: var(--bg-hover); }
  .row.empty { color: var(--text-faint); }
  .row.top[aria-expanded="true"], .row.section[aria-expanded="true"] { position: sticky; top: 0; z-index: 1; font-weight: 500; background: var(--bg-elevated); }
  .row.top[aria-expanded="true"]:hover, .row.section[aria-expanded="true"]:hover { background: color-mix(in srgb, var(--bg-hover) 100%, var(--bg-elevated)); }
  .turn { content-visibility: auto; contain-intrinsic-size: auto 24px; }
  .turn.open { padding-bottom: 6px; }
  .lead { display: flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; white-space: nowrap; }
  .line { min-height: 22px; padding-left: calc(6px + var(--depth, 0) * 18px); color: var(--text-muted); }
  .line .name { color: var(--text); }
  .name { flex: none; max-width: 45%; overflow: hidden; text-overflow: ellipsis; }
  .source.short { flex: none; max-width: 28%; }
  .source { min-width: 0; overflow: hidden; text-overflow: ellipsis; font-weight: 400; color: var(--text-faint); }
  .gist { min-width: 0; overflow: hidden; text-overflow: ellipsis; font-family: var(--mono); font-size: 11.5px; font-weight: 400; color: var(--text-muted); }
  .num, .count { flex: none; font-weight: 400; font-variant-numeric: tabular-nums; color: var(--text-faint); }
  .num:empty { display: none; }
  .chev { display: inline-flex; flex: none; color: var(--text-faint); transform: rotate(-90deg); transition: transform 0.12s; }
  .chev.open { transform: none; }
  .chev.blank { width: 10px; }
  .tok { text-align: right; font-weight: 400; font-variant-numeric: tabular-nums; color: var(--text-muted); }
  .tok.faint { color: var(--text-faint); }
  .at { text-align: right; font-weight: 400; font-variant-numeric: tabular-nums; color: var(--text-faint); white-space: nowrap; }
  .share { display: flex; align-items: center; gap: 8px; }
  .track { flex: 1; height: 3px; border-radius: 2px; background: var(--border); overflow: hidden; }
  .fill { display: block; height: 100%; background: var(--accent); }
  .pct { width: 40px; text-align: right; font-weight: 400; font-variant-numeric: tabular-nums; color: var(--text-faint); }
  .dot { width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--border-strong); }
  .dot.owner { background: var(--accent); }
  .dot.injected { background: var(--warning); }
  .dot.model { background: var(--text-muted); }
  .tag { flex: none; padding: 0 6px; border-radius: 999px; font-size: 11px; font-weight: 400; line-height: 17px; color: var(--text-muted); background: var(--bg-hover); max-width: 30%; overflow: hidden; text-overflow: ellipsis; }
  .tag.hook, .tag.mid { color: light-dark(#8a4b00, #fbbf24); background: color-mix(in srgb, var(--warning) 14%, transparent); }
  .tag.missing { color: var(--text-faint); background: transparent; border: 1px dashed var(--border-strong); line-height: 15px; }
  .missing .name { font-style: italic; color: var(--text-faint); }
  .children { position: relative; }
  .children::before { content: ""; position: absolute; top: 0; bottom: 4px; left: 11px; border-left: 1px solid var(--border); }
  .indent { padding-left: calc(28px + var(--depth, 0) * 18px); }
  .text { margin: 2px 0 8px; padding-left: 10px; border-left: 2px solid var(--border); }
  .text.owner { border-left-color: var(--accent); }
  .text.injected { border-left-color: var(--warning); }
  .text pre { margin: 0; font-family: var(--mono); font-size: 12px; line-height: 18px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text); tab-size: 4; }
  .text.model pre, .text.tool pre { color: var(--text-muted); }
  .more { margin-top: 2px; font-size: 12px; color: var(--accent); }
  .more:hover { text-decoration: underline; }
  @container app (max-width: 899px) {
    .order { --cols: minmax(0, 1fr) 56px 84px; }
    .row > .at, .group-head > span:last-child, .row > span:last-child:empty { display: none; }
    .source { display: none; }
    .line { padding-left: calc(6px + var(--depth, 0) * 10px); }
  }
</style>
