<script lang="ts">
  import { SvelteMap, SvelteSet } from "svelte/reactivity";
  import { api } from "./api.ts";
  import { store } from "./store.svelte.ts";
  import { duration } from "./format.ts";
  import { clock } from "./clock.svelte.ts";
  import { renderMarkdown, copyFromClick } from "./markdown.ts";
  import { messageText, toolDurationMs, triggerSummary, workCounts, type SystemMessage, type Turn, type WorkItem } from "../shared/turns.ts";
  import Icon from "./Icon.svelte";
  import { span, STALLED_AFTER_MS } from "../shared/pulse.ts";

  type ToolItem = Extract<WorkItem, { kind: "tool" }>;
  type Output = { text: string; isError: boolean | null; loading: boolean; error: string | null };

  let { turn, threadId }: { turn: Turn; threadId: string } = $props();

  const live = $derived(turn.live);
  const trigger = $derived(turn.trigger ? triggerSummary(turn.trigger.message) : null);
  const counts = $derived(workCounts(turn.work));
  const worked = $derived(turn.work.some(item => item.kind === "tool" || item.kind === "thinking"));
  const tools = $derived(turn.work.filter((item): item is ToolItem => item.kind === "tool"));
  const runningTool = $derived(tools.find(item => item.run?.status === "running"));
  const step = $derived.by(() => {
    if (!live) return "";
    if (runningTool) return runningTool.call.name + " " + summary(runningTool);
    if (turn.reply?.live) return "Writing the reply";
    if (turn.work.at(-1)?.kind === "thinking") return "Thinking";
    return "";
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
  const elapsedMs = $derived(live ? Math.max(0, now - turn.startedAt) : Math.max(0, turn.endedAt - turn.startedAt));
  const label = $derived(live ? "Working " + duration(elapsedMs) : worked ? "Worked " + duration(elapsedMs) : firstSystem ? systemTitle(firstSystem.message) : "");

  let open = $state(false);

  const expanded = new SvelteSet<string>();
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
    const result = await store.run(api.part(threadId, item.messageIndex, item.partIndex));
    if (result) fullParts.set(partKey(item), result.text);
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
  <button class="head" aria-expanded={open} onclick={() => { open = !open; }}>
    <span class="chevron" class:down={open}><Icon name="chevronRight" size={14} /></span>
    {#if trigger}
      <Icon name="bolt" size={13} />
      <span class="trigger-label">{trigger.label}</span>
      {#if trigger.detail}<span class="trigger-detail">{trigger.detail}</span>{/if}
      {#if !live && !worked && trigger.body}<span class="trigger-inline">{trigger.body.split("\n", 1)[0]}</span>{/if}
    {/if}
    {#if live}<span class="spinner tiny"></span>{/if}
    {#if label}<span class="label" class:sep={trigger !== null}>{label}</span>{/if}
    {#if live && step}<span class="step">{step}</span>{/if}
    {#if live && (toolMs !== null || quietMs >= 10_000)}
      <span class="pulse" class:stalled title={stalled ? "No event from this thread for " + span(quietMs) + ". The run may be stuck." : undefined}>
        {toolMs !== null ? "tool " + duration(toolMs) : ""}{toolMs !== null && quietMs >= 10_000 ? " · " : ""}{quietMs >= 10_000 ? (stalled ? "no event for " : "last event ") + span(quietMs) + (stalled ? "" : " ago") : ""}
      </span>
    {/if}
    {#if !(live && step) && countText}<span class="count" class:sep={label !== "" || trigger !== null}>{countText}</span>{/if}
  </button>
  {#if open}
    <div class="items">
      {#if trigger?.body}<div class="item trigger-body">{trigger.body}</div>{/if}
      {#each turn.work as item, itemIndex (item.kind === "tool" ? item.call.id : item.kind + ":" + item.messageIndex + ":" + ("partIndex" in item ? item.partIndex : itemIndex))}
        {#if item.kind === "thinking"}
          <div class="item thinking">
            <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
            <div class="prose thinking-text" onclick={copyFromClick}>{@html renderMarkdown(fullParts.get(partKey(item)) ?? item.part.thinking)}{#if live && itemIndex === turn.work.length - 1}<span class="caret"></span>{/if}</div>
            {#if item.part.truncated && !fullParts.has(partKey(item))}
              <button class="more" onclick={() => void showMore(item)}>Show more</button>
            {/if}
          </div>
        {:else if item.kind === "note"}
          <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
          <div class="item note prose" onclick={copyFromClick}>{@html renderMarkdown(item.text)}</div>
        {:else if item.kind === "trigger"}
          {@const inner = triggerSummary(item.message)}
          <details class="item system">
            <summary><Icon name="bolt" size={12} /> <span class="system-title">{inner.label}</span> <span class="faint">{inner.detail}</span></summary>
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
              <span class="status-dot {toolState}"></span>
              <span class="tool-name">{item.call.name}</span>
              <span class="tool-summary">{summary(item)}</span>
              {#if toolState === "running"}<span class="spinner tiny"></span>{/if}
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
  .work { margin: 2px 0 8px; border: 1px solid transparent; border-radius: var(--radius); overflow: hidden; }
  .work.open { border-color: var(--border); background: var(--bg-elevated); margin-bottom: 12px; }
  .head { display: flex; align-items: center; gap: 6px; width: 100%; min-width: 0; padding: 4px 8px; border-radius: var(--radius-small); font-size: 13px; color: var(--text-muted); text-align: left; }
  .head:hover { color: var(--text); background: var(--bg-hover); }
  .work.open .head { border-radius: 0; padding: 7px 10px; }
  .head > :global(svg) { flex: none; }
  .chevron { display: inline-flex; flex: none; transition: transform 0.15s ease; color: var(--text-faint); }
  .chevron.down { transform: rotate(90deg); }
  .label { white-space: nowrap; flex: none; }
  .sep::before { content: "·"; margin-right: 6px; color: var(--text-faint); }
  .count { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; color: var(--text-faint); }
  .step { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-faint); font-family: var(--mono); font-size: 12px; }
  .trigger-label { font-weight: 500; flex: none; }
  .pulse { flex: none; white-space: nowrap; font-size: 12px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
  .pulse.stalled { color: var(--warning); font-weight: 500; }
  .trigger-detail { color: var(--text-faint); flex: none; white-space: nowrap; }
  .trigger-inline { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-faint); }
  .trigger-body { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 360px; overflow: auto; color: var(--text-muted); }
  .system summary { cursor: pointer; color: var(--text-muted); }
  .system-title { font-weight: 500; text-transform: capitalize; }
  .system-title.mono { font-family: var(--mono); text-transform: none; font-weight: 400; }
  .system pre { margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--mono); font-size: 12px; max-height: 320px; overflow: auto; }
  .summary { margin-top: 6px; }
  .mono { font-family: var(--mono); }
  .items { border-top: 1px solid var(--border); padding: 4px 0; }
  .item { padding: 6px 12px 6px 14px; font-size: 13px; }
  .item + .item { border-top: 1px solid var(--border); }
  .thinking { color: var(--text-muted); line-height: 1.5; }
  .thinking-text :global(p) { margin: 0 0 0.4em; }
  .thinking-text :global(strong) { font-weight: 600; color: var(--text); }
  .more { color: var(--accent); font-size: 12px; }
  .note { color: var(--text-muted); font-size: 14px; }
  .tool { padding: 0; }
  .tool-head { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 12px 7px 14px; text-align: left; font-size: 13px; }
  .tool-head:hover { background: var(--bg-hover); }
  .tool-name { font-family: var(--mono); font-weight: 500; white-space: nowrap; }
  .tool-summary { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); font-family: var(--mono); font-size: 12px; }
  .tool-time { color: var(--text-faint); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .tool-body { padding: 4px 12px 10px 34px; }
  .section-label { display: flex; align-items: center; gap: 8px; margin: 6px 0 4px; font-size: 11.5px; font-weight: 600; color: var(--text-muted); }
  .danger { color: var(--danger); font-weight: 400; }
  .block { margin: 0; padding: 8px 10px; border-radius: var(--radius-small); background: var(--bg-sunken); font-family: var(--mono); font-size: 12px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 420px; overflow: auto; }
  .block.error { color: var(--danger); }
</style>
