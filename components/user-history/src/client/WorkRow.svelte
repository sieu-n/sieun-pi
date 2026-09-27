<script lang="ts">
  import { SvelteMap, SvelteSet } from "svelte/reactivity";
  import { api } from "./api.ts";
  import { store } from "./store.svelte.ts";
  import { duration } from "./format.ts";
  import { clock } from "./clock.svelte.ts";
  import { renderMarkdown, copyFromClick } from "./markdown.ts";
  import { messageText, toolDurationMs, triggerSummary, workCounts, type SystemMessage, type Turn, type WorkItem } from "../shared/turns.ts";
  import Icon from "./Icon.svelte";
  import { span, QUIET_AFTER_MS, STALLED_AFTER_MS } from "../shared/pulse.ts";

  type ToolItem = Extract<WorkItem, { kind: "tool" }>;
  type Output = { text: string; isError: boolean | null; loading: boolean; error: string | null };

  let { turn, threadId }: { turn: Turn; threadId: string } = $props();

  const live = $derived(turn.live);
  const trigger = $derived(turn.trigger ? triggerSummary(turn.trigger.message) : null);
  const counts = $derived(workCounts(turn.work));
  const worked = $derived(turn.work.some(item => item.kind === "tool" || item.kind === "thinking"));
  const tools = $derived(turn.work.filter((item): item is ToolItem => item.kind === "tool"));
  const runningTool = $derived(tools.find(item => item.run?.status === "running"));
  const verb = $derived.by(() => {
    if (runningTool) return "Running " + runningTool.call.name;
    if (turn.reply?.live) return "Writing";
    if (turn.work.at(-1)?.kind === "thinking") return "Thinking";
    return "Working";
  });
  const firstSystem = $derived(turn.work.find((item): item is Extract<WorkItem, { kind: "system" }> => item.kind === "system"));
  const countText = $derived([
    counts.tools ? `${counts.tools} tool ${counts.tools === 1 ? "call" : "calls"}` : "",
    counts.notes ? `${counts.notes} ${counts.notes === 1 ? "note" : "notes"}` : "",
  ].filter(Boolean).join(" · "));

  const now = $derived(live ? clock.now : Date.now());
  /** Last live event for this thread: this tab's own stream, else the daemon's last activity for the row. */
  const lastEventAt = $derived.by(() => {
    const own = store.thread(threadId)?.lastEventAt ?? 0;
    const daemon = Date.parse(store.session(threadId)?.lastActivityAt ?? "");
    return Math.max(own, Number.isFinite(daemon) ? daemon : 0);
  });
  const quietMs = $derived(live && lastEventAt ? Math.max(0, now - lastEventAt) : 0);
  const toolMs = $derived(live && runningTool?.run ? Math.max(0, now - runningTool.run.startedAt) : null);
  const stalled = $derived(quietMs >= STALLED_AFTER_MS);
  const quiet = $derived(quietMs >= QUIET_AFTER_MS);
  const elapsedMs = $derived(live ? Math.max(0, now - turn.startedAt) : Math.max(0, turn.endedAt - turn.startedAt));
  const label = $derived(live ? verb : worked ? "Worked " + duration(elapsedMs) : firstSystem ? systemTitle(firstSystem.message) : "");
  const freshness = $derived.by(() => {
    if (!live) return "";
    const parts = [];
    if (runningTool && toolMs !== null) parts.push(runningTool.call.name + " running for " + duration(toolMs));
    if (lastEventAt) parts.push(stalled ? "no event from this thread for " + span(quietMs) + ", the run may be stuck" : "last event " + span(quietMs) + " ago");
    return parts.join(" · ");
  });

  let open = $state(false);

  const expanded = new SvelteSet<string>();
  const shownThinking = new SvelteSet<string>();
  const outputs = new SvelteMap<string, Output>();
  const fullParts = new SvelteMap<string, string>();

  const SUMMARY_KEYS = ["command", "cmd", "path", "file_path", "filePath", "pattern", "query", "url", "name", "message", "code"];
  function summary(item: ToolItem): string {
    const args = item.call.arguments;
    for (const key of SUMMARY_KEYS) {
      const value = args[key];
      if (typeof value === "string" && value.trim()) return value.replace(/\s+/g, " ").slice(0, 140);
    }
    const first = Object.values(args).find(value => typeof value === "string" && value.trim());
    if (typeof first === "string") return first.replace(/\s+/g, " ").slice(0, 140);
    const json = JSON.stringify(args);
    return json === "{}" ? "" : json.slice(0, 140);
  }

  function status(item: ToolItem): "running" | "done" | "error" {
    if (item.result) return item.result.isError ? "error" : "done";
    if (item.run) return item.run.status === "running" ? "running" : item.run.isError ? "error" : "done";
    return live ? "running" : "done";
  }

  function previewText(item: ToolItem): { text: string; truncated: boolean } {
    if (!item.result) return { text: item.run?.partial ?? "", truncated: false };
    const parts = item.result.content.filter(part => part.type === "text");
    return { text: parts.map(part => part.text).join("\n"), truncated: parts.some(part => part.truncated) };
  }

  function toggleTool(item: ToolItem): void {
    const id = item.call.id;
    if (expanded.has(id)) { expanded.delete(id); return; }
    expanded.add(id);
    const preview = previewText(item);
    if (outputs.has(id) || !item.result || (!preview.truncated && !item.call.truncated)) return;
    outputs.set(id, { text: preview.text, isError: item.result.isError, loading: true, error: null });
    api.toolOutput(threadId, id).then(
      full => outputs.set(id, { text: full.output, isError: full.isError, loading: false, error: null }),
      error => outputs.set(id, { text: preview.text, isError: item.result?.isError ?? null, loading: false, error: error instanceof Error ? error.message : String(error) }),
    );
  }

  function outputFor(item: ToolItem): Output {
    return outputs.get(item.call.id) ?? { ...previewText(item), isError: item.result?.isError ?? null, loading: false, error: null };
  }

  function partKey(item: { messageIndex: number; partIndex: number }): string { return item.messageIndex + ":" + item.partIndex; }
  async function showMore(item: Extract<WorkItem, { kind: "thinking" }>): Promise<void> {
    const key = partKey(item);
    shownThinking.add(key);
    if (!item.part.truncated || fullParts.has(key)) return;
    const result = await store.run(api.part(threadId, item.messageIndex, item.partIndex));
    if (result) fullParts.set(key, result.text);
  }

  function json(value: unknown): string { return JSON.stringify(value, null, 2); }
  function systemTitle(message: SystemMessage): string {
    if (message.role === "compactionSummary") return "Context compacted";
    if (message.role === "branchSummary") return "Branch summary";
    if (message.role === "bashExecution") return "$ " + message.command;
    return message.customType.replaceAll("_", " ");
  }
</script>

<div class="work" class:live class:open class:trigger-row={trigger !== null}>
  <button class="head" aria-expanded={open} title={freshness || undefined} onclick={() => { open = !open; }}>
    <span class="mark">
      {#if live}<span class="spinner tiny"></span>{:else}<span class="chevron" class:down={open}><Icon name="chevronRight" size={12} /></span>{/if}
    </span>
    {#if trigger}
      <Icon name="bolt" size={12} />
      <span class="trigger-label">{trigger.label}</span>
      {#if trigger.detail}<span class="trigger-detail">{trigger.detail}</span>{/if}
      {#if !live && !worked && trigger.body}<span class="trigger-inline">{trigger.body.split("\n", 1)[0]}</span>{/if}
    {/if}
    {#if label}<span class="label" class:shimmer={live} class:sep={trigger !== null}>{label}</span>{/if}
    {#if live}
      <span class="time">{duration(elapsedMs)}</span>
      {#if runningTool}<span class="args">{summary(runningTool)}</span>{/if}
      {#if quiet}<span class="fresh" class:stalled>{stalled ? "no event for " + span(quietMs) : "quiet " + span(quietMs)}</span>{/if}
    {:else if countText}
      <span class="count" class:sep={label !== "" || trigger !== null}>{countText}</span>
    {/if}
  </button>
  {#if open}
    <div class="items">
      {#if trigger?.body}<div class="item trigger-body">{trigger.body}</div>{/if}
      {#each turn.work as item, itemIndex (item.kind === "tool" ? item.call.id : item.kind + ":" + item.messageIndex + ":" + ("partIndex" in item ? item.partIndex : itemIndex))}
        {#if item.kind === "thinking"}
          {@const key = partKey(item)}
          {@const streaming = live && itemIndex === turn.work.length - 1}
          {@const clipped = item.part.truncated && !fullParts.has(key) && !streaming}
          <div class="item thinking" class:clipped>
            <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
            <div class="prose thinking-text" onclick={copyFromClick}>{@html renderMarkdown(fullParts.get(key) ?? item.part.thinking)}{#if streaming}<span class="caret"></span>{/if}</div>
            {#if clipped && !shownThinking.has(key)}
              <button class="more" onclick={() => void showMore(item)}>more</button>
            {/if}
          </div>
        {:else if item.kind === "note"}
          <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
          <div class="item note prose" onclick={copyFromClick}>{@html renderMarkdown(item.text)}</div>
        {:else if item.kind === "trigger"}
          {@const inner = triggerSummary(item.message)}
          <details class="item system">
            <summary><Icon name="bolt" size={12} /> <span class="system-title plain">{inner.label}</span> <span class="faint">{inner.detail}</span></summary>
            {#if inner.body}<pre>{inner.body}</pre>{/if}
          </details>
        {:else if item.kind === "system"}
          {@const message = item.message}
          <details class="item system">
            <summary>
              <span class="system-title" class:mono={message.role === "bashExecution"}>{systemTitle(message)}</span>
              {#if message.role === "bashExecution" && message.exitCode !== undefined && message.exitCode !== 0} <span class="danger">exit {message.exitCode}</span>{/if}
              {#if message.role === "bashExecution" && message.cancelled} <span class="danger">cancelled</span>{/if}
              {#if message.role === "compactionSummary"} <span class="faint">{message.tokensBefore.toLocaleString()} tokens before</span>{/if}
            </summary>
            {#if message.role === "bashExecution"}
              <pre>{message.output || "(no output)"}{#if message.truncated}
(truncated){/if}</pre>
            {:else if message.role === "compactionSummary" || message.role === "branchSummary"}
              <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
              <div class="prose summary" onclick={copyFromClick}>{@html renderMarkdown(message.summary)}</div>
            {:else}
              <pre>{messageText(message)}</pre>
            {/if}
          </details>
        {:else}
          {@const toolState = status(item)}
          {@const ms = toolDurationMs(item, now)}
          {@const isOpen = expanded.has(item.call.id)}
          <div class="item tool" class:expanded={isOpen}>
            <button class="tool-head" aria-expanded={isOpen} onclick={() => toggleTool(item)}>
              <span class="mark">
                {#if toolState === "running"}<span class="spinner tiny"></span>
                {:else if toolState === "error"}<span class="danger"><Icon name="x" size={11} /></span>
                {:else}<span class="done-dot"></span>{/if}
              </span>
              <span class="tool-name">{item.call.name}</span>
              <span class="tool-summary">{summary(item)}</span>
              {#if toolState === "error"}<span class="tool-failed">failed</span>{/if}
              {#if ms !== null}<span class="tool-time">{duration(ms)}</span>{/if}
            </button>
            {#if isOpen}
              {@const output = outputFor(item)}
              <div class="tool-body fade-in">
                <div class="section-label">Arguments{#if item.call.truncated} <span class="faint">(preview)</span>{/if}</div>
                <pre class="block">{json(item.call.arguments)}</pre>
                <div class="section-label">
                  {output.isError ? "Error output" : toolState === "running" ? "Output so far" : "Output"}
                  {#if output.loading}<span class="spinner tiny"></span>{/if}
                  {#if output.error}<span class="danger">{output.error}</span>{/if}
                </div>
                <pre class="block" class:error={output.isError === true}>{output.text || (toolState === "running" ? "Running" : "No output")}</pre>
              </div>
            {/if}
          </div>
        {/if}
      {/each}
    </div>
  {/if}
</div>

<style>
  .work { margin: 2px 0 8px; }
  .work.open { margin-bottom: 14px; }
  .head { display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; padding: 3px 0; font-size: 13px; line-height: 1.5; color: var(--text-faint); text-align: left; transition: color 0.12s; }
  .head:hover { color: var(--text-muted); }
  .head:hover .label { color: var(--text); }
  .head > :global(svg) { flex: none; }
  .mark { display: inline-flex; flex: none; align-items: center; justify-content: center; width: 14px; height: 14px; }
  .chevron { display: inline-flex; color: var(--text-faint); transition: transform 0.15s ease; }
  .chevron.down { transform: rotate(90deg); }
  .label { flex: none; white-space: nowrap; color: var(--text-muted); transition: color 0.12s; }
  .sep::before { content: "·"; margin-right: 8px; color: var(--text-faint); }
  .shimmer { color: transparent; background: linear-gradient(90deg, var(--text-muted) 0%, var(--text-muted) 38%, var(--text) 50%, var(--text-muted) 62%, var(--text-muted) 100%) 100% 0 / 250% 100%; -webkit-background-clip: text; background-clip: text; animation: shimmer 2.2s linear infinite; }
  .head:hover .shimmer { color: transparent; }
  @keyframes shimmer { to { background-position: -100% 0; } }
  .time { flex: none; font-variant-numeric: tabular-nums; }
  .args { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); font-size: 11.5px; opacity: 0.8; }
  .fresh { flex: none; margin-left: auto; padding-left: 8px; font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .fresh.stalled { color: var(--warning); }
  .count { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .trigger-label { flex: none; font-weight: 500; color: var(--text-muted); }
  .trigger-detail { flex: none; white-space: nowrap; }
  .trigger-inline { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .trigger-body { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 360px; overflow: auto; color: var(--text-muted); }

  .items { margin: 2px 0 0 6.5px; padding: 4px 0 2px 15px; border-left: 1px solid var(--border-strong); }
  .item { padding: 4px 0; font-size: 13px; line-height: 1.55; }
  .thinking { position: relative; color: var(--text-muted); }
  .thinking-text :global(p) { margin: 0 0 0.4em; }
  .thinking-text :global(strong) { font-weight: 600; color: var(--text); }
  .thinking.clipped .thinking-text { max-height: 4.6em; overflow: hidden; -webkit-mask-image: linear-gradient(to bottom, #000 45%, transparent 100%); mask-image: linear-gradient(to bottom, #000 45%, transparent 100%); }
  .more { display: block; margin-top: -2px; font-size: 12px; color: var(--text-faint); }
  .more:hover { color: var(--text); }
  .note { color: var(--text-muted); font-size: 13.5px; }
  .system summary { display: flex; align-items: center; gap: 6px; cursor: pointer; color: var(--text-faint); list-style: none; }
  .system summary::-webkit-details-marker { display: none; }
  .system summary:hover { color: var(--text-muted); }
  .system-title { font-weight: 500; text-transform: capitalize; }
  .system-title.mono { font-family: var(--mono); text-transform: none; font-weight: 400; }
  .system-title.plain { text-transform: none; }
  .system pre { margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--mono); font-size: 12px; max-height: 320px; overflow: auto; color: var(--text-muted); }
  .summary { margin-top: 6px; color: var(--text-muted); }
  .mono { font-family: var(--mono); }

  .tool { padding: 0; }
  .tool-head { display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; padding: 3px 0; text-align: left; font-size: 13px; color: var(--text-faint); border-radius: var(--radius-small); transition: color 0.12s; }
  .tool-head:hover { color: var(--text-muted); }
  .tool-head:hover .tool-name { color: var(--text); }
  .done-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--text-faint); opacity: 0.7; }
  .tool-name { flex: none; white-space: nowrap; color: var(--text-muted); transition: color 0.12s; }
  .tool-summary { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); font-size: 11.5px; opacity: 0.8; }
  .tool-failed { flex: none; font-size: 12px; color: var(--danger); }
  .tool-time { flex: none; font-size: 11.5px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .tool-body { padding: 2px 0 8px 22px; }
  .section-label { display: flex; align-items: center; gap: 8px; margin: 6px 0 4px; font-size: 11px; font-weight: 500; letter-spacing: 0.02em; text-transform: uppercase; color: var(--text-faint); }
  .danger { color: var(--danger); font-weight: 400; display: inline-flex; }
  .block { margin: 0; padding: 8px 10px; border-radius: var(--radius-small); background: var(--bg-sunken); color: var(--text-muted); font-family: var(--mono); font-size: 12px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 420px; overflow: auto; }
  .block.error { color: var(--danger); }

  @media (prefers-reduced-motion: reduce) {
    .shimmer { animation: none; background: none; color: var(--text-muted); }
  }
</style>
