<script lang="ts">
  import type { AgentSummary, ModelCatalog, ThinkingLevel } from "$lib/api";
  import { ModelPicker, IconButton, TypingDots, ageLabel, mascotSvg } from "$lib/ui";
    import { STATUS_LABEL, levelsFor, modelKey, modelOptions } from "./agents-model";

  type Props = {
    agent: AgentSummary;
    catalog: ModelCatalog | null;
    focusable: boolean;
    now: number;
    onopen: () => void;
    onmenu: (anchor: HTMLElement | { x: number; y: number }) => void;
    onmodel: (model: string, level: ThinkingLevel | undefined) => void;
    onfocus: () => void;
    element?: HTMLElement;
  };
  let { agent, catalog, focusable, now, onopen, onmenu, onmodel, onfocus, element = $bindable() }: Props = $props();

  const art = $derived(mascotSvg(agent.name, `card-${agent.id.replace(/[^a-z0-9]/gi, "")}`));
  const backdrop = $derived(`url("data:image/svg+xml;utf8,${encodeURIComponent(mascotSvg(agent.name, "bd"))}")`);
  const current = $derived(agent.model ? modelKey(agent.model) : "");
  const options = $derived.by(() => {
    const list = modelOptions(catalog);
    if (agent.model && !list.some((option) => option.id === current)) list.push({ id: current, label: agent.model.label, family: "Other" });
    return list;
  });
  const status = $derived(agent.status === "idle" ? `Idle · ${ageLabel(agent.updatedAt, now)}` : STATUS_LABEL[agent.status]);
  let menuButton = $state<HTMLButtonElement>();
  let pickerOpen = $state(false);

  function inControl(event: Event): boolean {
    return !!(event.target as Element).closest("button, input, [data-card-control]");
  }
  function onclick(event: MouseEvent) {
    if (!inControl(event)) onopen();
  }
  function oncontextmenu(event: MouseEvent) {
    if ((event.target as Element).closest("[data-card-control]")) return;
    event.preventDefault();
    onmenu({ x: event.clientX, y: event.clientY });
  }
  function onkeydown(event: KeyboardEvent) {
    if (event.target !== element) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onopen();
    } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      if (menuButton) onmenu(menuButton);
    }
  }
  /** Change model in the card menu opens the same picker as the pill. */
  export function openModelPicker() {
    pickerOpen = true;
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  bind:this={element}
  class="card"
  role="gridcell"
  tabindex={focusable ? 0 : -1}
  aria-label="{agent.name}, {agent.kind === 'job' ? 'job' : 'chat'}, {STATUS_LABEL[agent.status]}"
  data-agent-id={agent.id}
  data-status={agent.status}
  style:--backdrop={backdrop}
  {onclick}
  {oncontextmenu}
  {onkeydown}
  onfocus={onfocus}
>
  <span class="wash" aria-hidden="true"></span>
  <div class="menu">
    <IconButton bind:element={menuButton} icon="more" label="Actions for {agent.name}" variant="ghost" size="sm" onclick={() => menuButton && onmenu(menuButton)} />
  </div>
  <span class="portrait" aria-hidden="true">{@html art}</span>
  <span class="identity">
    <span class="name-row">
      <span class="name t-label" title={agent.name}>{agent.name}</span>
    </span>
    <span class="status t-caption" data-status={agent.status}>
      {#if agent.status === "working" || agent.status === "sleeping"}
        <TypingDots mode={agent.status === "working" ? "working" : "waiting"} size={4} />
      {:else if agent.status === "failed"}
        <span class="fail-dot" aria-hidden="true"></span>
      {/if}
      <span class="status-text">{status}</span>
      {#if agent.parent}<span class="sep">·</span><span class="parent" title="Started by {agent.parent.name}">in {agent.parent.name}</span>{/if}
    </span>
    <span class="model" data-card-control>
      {#if agent.model}
        <ModelPicker
          bind:open={pickerOpen}
          models={options}
          value={current}
          efforts={levelsFor(catalog, current)}
          effort={agent.thinkingLevel ?? undefined}
          onchange={(next) => onmodel(next.model, next.effort as ThinkingLevel | undefined)}
        />
      {:else}
        <span class="t-caption no-model">No model yet</span>
      {/if}
    </span>
  </span>
</div>

<style>
  .card {
    position: relative;
    isolation: isolate;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-5);
    min-width: 0;
    min-height: 244px;
    padding: calc(var(--space-8) * 2 + var(--space-2)) var(--space-4) var(--space-5);
    border-radius: var(--radius-container);
    background: var(--surface-inset);
    text-align: center;
    user-select: none;
    cursor: pointer;
    outline: none;
  }
  .card:focus-visible {
    box-shadow: 0 0 0 2px var(--border-focus);
  }
  .card:hover .wash {
    opacity: 0.76;
  }
  /* The mascot itself, blurred and saturated, gives each card its color and fades out toward the bottom. */
  .wash {
    position: absolute;
    inset: 0;
    z-index: -1;
    background: var(--backdrop) center 30% / cover no-repeat;
    filter: blur(40px) saturate(4);
    transform: scale(2);
    opacity: 0.64;
    mask-image: linear-gradient(to bottom, black, 25%, transparent);
    pointer-events: none;
  }
  .menu {
    position: absolute;
    top: var(--space-2);
    right: var(--space-2);
  }
  .portrait {
    display: grid;
    place-items: center;
    flex-shrink: 0;
    width: clamp(64px, 16cqw, 128px);
    height: clamp(64px, 16cqw, 128px);
  }
  .portrait :global(svg) {
    width: 100%;
    height: 100%;
  }
  .card[data-status="failed"] .portrait,
  .card[data-status="idle"] .portrait {
    filter: saturate(0.85);
  }
  .identity {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-1);
    min-width: 0;
    max-width: 100%;
  }
  .name-row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    min-width: 0;
    max-width: 100%;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-standard);
  }
  .status {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-1);
    max-width: 100%;
    color: var(--text-subtle);
    white-space: nowrap;
  }
  .status[data-status="failed"] .status-text {
    color: var(--text-danger);
  }
  .parent {
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .fail-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--border-danger);
  }
  .model {
    display: flex;
    justify-content: center;
    max-width: 100%;
    margin-top: var(--space-1);
  }
  .no-model {
    color: var(--text-metadata);
  }
</style>
