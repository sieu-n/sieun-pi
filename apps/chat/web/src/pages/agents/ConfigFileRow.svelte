<script lang="ts">
  import type { ConfigFile } from "$lib/api";
  import { Chip, stampLabel } from "$lib/ui";
  import { bytesLabel } from "./agents-model";
  import { plural } from "./agent-tab";
  import CopyPath from "./CopyPath.svelte";

  /** One file the agent loads or keeps: its label, whether it loads, its path, size, last change and a preview. */
  let { item }: { item: ConfigFile } = $props();
</script>

<li class="file" data-path={item.path}>
  <div class="file-head">
    <span class="t-label-sm">{item.label}</span>
    {#if item.loaded === false}<Chip size="sm" label="Not loaded" />{:else if item.loaded}<Chip size="sm" label="Loaded" selected />{/if}
    {#if !item.exists}<Chip size="sm" label="Missing" />{/if}
  </div>
  <CopyPath value={item.path} label={item.label} />
  <span class="t-caption meta">
    {[item.count !== undefined ? plural(item.count, "entry", "entries") : "", bytesLabel(item.size), item.modifiedAt ? `changed ${stampLabel(item.modifiedAt)}` : ""].filter(Boolean).join(" · ")}
  </span>
  {#if item.preview}<pre class="preview t-mono">{item.preview}</pre>{/if}
  {#if item.note}<p class="t-caption note">{item.note}</p>{/if}
</li>
