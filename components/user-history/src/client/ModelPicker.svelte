<script lang="ts">
  import type { ModelCatalog, ModelInfo, ThinkingLevel } from "../shared/types.ts";
  import ModelMenu from "./ModelMenu.svelte";
  import Popover from "./Popover.svelte";
  import Icon from "./Icon.svelte";

  let { label, title = "Model and effort", disabled = false, catalog, error, current, effort, levels, onopen, onchoose, oneffort, defaultLabel = null, ondefault, defaultEffort = false, note = "" }: {
    label: string; title?: string; disabled?: boolean; catalog: ModelCatalog | null; error: string | null; current: { provider: string; id: string } | null;
    effort: ThinkingLevel | null; levels: readonly ThinkingLevel[]; onopen?: () => void; onchoose: (model: ModelInfo) => void; oneffort: (level: ThinkingLevel | null) => void;
    defaultLabel?: string | null; ondefault?: () => void; defaultEffort?: boolean; note?: string;
  } = $props();
  let open = $state(false);

  function toggle(): void {
    open = !open;
    if (open) onopen?.();
  }
</script>

<Popover {open} onclose={() => { open = false; }} align="end" side="above" width="300px">
  {#snippet trigger()}
    <button class="bar-button" {disabled} {title} aria-expanded={open} onclick={toggle}>
      <span class="label">{label}</span><Icon name="chevronDown" size={12} />
    </button>
  {/snippet}
  <ModelMenu {catalog} {error} {current} {effort} {levels} {oneffort} {defaultLabel} {defaultEffort} {note}
    onchoose={model => { open = false; onchoose(model); }} ondefault={() => { open = false; ondefault?.(); }} />
</Popover>
