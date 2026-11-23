<script lang="ts">
  import { IconButton, toast } from "$lib/ui";
  import { shortPath } from "./agents-model";

  /** A path shown home-relative, or as `shown` gives it, with a button that copies the full path. */
  let { value, label, shown }: { value: string; label: string; shown?: string } = $props();

  function copy() {
    navigator.clipboard?.writeText(value).then(
      () => toast.success("Copied path"),
      () => toast.error("Copy failed"),
    );
  }
</script>

<span class="path">
  <code class="t-mono" title={value}>{shown ?? shortPath(value)}</code>
  <IconButton icon="copy" label="Copy {label}" size="xs" onclick={copy} />
</span>
