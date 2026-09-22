<script lang="ts">
  import { SvelteMap, SvelteSet } from "svelte/reactivity";
  import { api } from "./api.ts";
  import { store } from "./store.svelte.ts";
  import { duration } from "./format.ts";
  import { renderMarkdown, copyFromClick } from "./markdown.ts";
  import { toolDurationMs, type Turn, type WorkItem } from "../shared/turns.ts";
  import Icon from "./Icon.svelte";

  type ToolItem = Extract<WorkItem, { kind: "tool" }>;
  type Output = { text: string; isError: boolean | null; loading: boolean; error: string | null };

  let { turn, threadId }: { turn: Turn; threadId: string } = $props();

  const live = $derived(turn.live);
  const tools = $derived(turn.work.filter((item): item is ToolItem => item.kind === "tool"));
  const toolNames = $derived([...new Set(tools.map(item => item.call.name))]);
  const latest = $derived(tools.find(item => item.run?.status === "running") ?? (live ? tools.at(-1) : undefined));
  const lastThinking = $derived.by(() => {
    const item = turn.work.at(-1);
    return live && item?.kind === "thinking" ? item.part.thinking.slice(-240).trimStart() : "";
  });

  let now = $state(Date.now());
  $effect(() => {
    if (!live) return;
    const timer = setInterval(() => { now = Date.now(); }, 1000);
    return () => clearInterval(timer);
  });
  const elapsedMs = $derived(live ? Math.max(0, now - turn.startedAt) : Math.max(0, turn.endedAt - turn.startedAt));

  let userToggled = $state<boolean | null>(null);
  $effect(() => { if (!live) userToggled = null; });
  const open = $derived(userToggled ?? live);

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
</script>

<div class="work" class:live class:open>
  <button class="head" aria-expanded={open} onclick={() => { userToggled = !open; }}>
    <span class="chevron" class:down={open}><Icon name="chevronRight" size={14} /></span>
    {#if live}<span class="spinner"></span>{/if}
    <span class="label">{live ? "Working" : "Worked"} {duration(elapsedMs)}</span>
    {#if tools.length}<span class="count">{tools.length} tool {tools.length === 1 ? "call" : "calls"}</span>{/if}
    {#if toolNames.length}<span class="names">{toolNames.join(", ")}</span>{/if}
  </button>
  {#if live && !open}
    <div class="peek">
      {#if latest}<span class="peek-tool"><span class="status-dot running"></span>{latest.call.name} <span class="faint">{summary(latest)}</span></span>{/if}
    </div>
  {/if}
  {#if open}
    <div class="items">
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
      {#if live && lastThinking && turn.work.at(-1)?.kind !== "thinking"}
        <div class="item thinking"><div class="prose thinking-text">{@html renderMarkdown(lastThinking)}<span class="caret"></span></div></div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .work { margin: 6px 0 14px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-elevated); overflow: hidden; }
  .work.live { border-color: var(--accent-soft); }
  .head { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 12px; font-size: 13px; color: var(--text-muted); text-align: left; }
  .head:hover { background: var(--bg-hover); }
  .chevron { display: inline-flex; transition: transform 0.15s ease; color: var(--text-faint); }
  .chevron.down { transform: rotate(90deg); }
  .label { font-weight: 500; color: var(--text); white-space: nowrap; }
  .count { white-space: nowrap; }
  .count::before { content: "·"; margin-right: 8px; color: var(--text-faint); }
  .names { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-faint); font-family: var(--mono); font-size: 12px; }
  .peek { padding: 0 12px 10px 34px; font-size: 13px; color: var(--text-muted); }
  .peek-tool { display: inline-flex; align-items: center; gap: 8px; font-family: var(--mono); font-size: 12px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
  .spinner.tiny { width: 11px; height: 11px; border-width: 1.5px; }
  .tool-body { padding: 4px 12px 10px 34px; }
  .section-label { display: flex; align-items: center; gap: 8px; margin: 6px 0 4px; font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--text-faint); }
  .danger { color: var(--danger); text-transform: none; letter-spacing: 0; font-weight: 400; }
  .block { margin: 0; padding: 8px 10px; border-radius: var(--radius-small); background: var(--bg-sunken); font-family: var(--mono); font-size: 12px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 420px; overflow: auto; }
  .block.error { color: var(--danger); }
</style>
