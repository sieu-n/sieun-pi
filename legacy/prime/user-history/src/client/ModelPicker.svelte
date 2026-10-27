<script lang="ts">
  import type { ModelCatalog, ModelInfo, ThinkingLevel } from "../shared/types.ts";
  import ModelMenu from "./ModelMenu.svelte";
  import Popover from "./Popover.svelte";
  import Icon from "./Icon.svelte";

  let { label, disabled = false, catalog, error, current, effort, levels, onopen, onchoose, oneffort, defaultLabel = null, ondefault, defaultEffort = false }: {
    label: string; disabled?: boolean; catalog: ModelCatalog | null; error: string | null; current: { provider: string; id: string } | null;
    effort: ThinkingLevel | null; levels: readonly ThinkingLevel[]; onopen?: () => void; onchoose: (model: ModelInfo) => void; oneffort: (level: ThinkingLevel | null) => void;
    defaultLabel?: string | null; ondefault?: () => void; defaultEffort?: boolean;
  } = $props();
  let open = $state(false);

  function toggle(): void {
    open = !open;
    if (open) onopen?.();
  }
</script>

<Popover {open} onclose={() => { open = false; }} align="end" width={340} label="Model and effort">
  {#snippet trigger()}
    <button type="button" class="bar-button" {disabled} aria-haspopup="dialog" aria-expanded={open} aria-label="Model: {label}" onclick={toggle}>
      <span class="label">{label}</span><Icon name="chevronDown" size={12} />
    </button>
  {/snippet}
  <ModelMenu {catalog} {error} {current} {effort} {levels} {oneffort} {defaultLabel} {defaultEffort}
    onchoose={model => { open = false; onchoose(model); }} ondefault={() => { open = false; ondefault?.(); }} />
</Popover>
