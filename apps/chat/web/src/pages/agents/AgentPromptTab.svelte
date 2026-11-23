<script lang="ts">
  import type { AgentTabProps } from "./agent-tab";

  /** The Prompt tab: the prompt each kind of its threads runs with. */
  let { config }: AgentTabProps = $props();
</script>

<section class="block" aria-label="System text">
  <h3 class="t-caption heading">System text its model runs with</h3>
  {#if config.identity.system.text}<pre class="preview t-mono">{config.identity.system.text}</pre>{/if}
  <span class="t-caption meta">{config.identity.system.source}</span>
</section>
