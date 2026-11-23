<script lang="ts">
  import { IconButton, toast } from "$lib/ui";
  import { shortPath } from "./agents-model";

  /** A path shown home-relative, with a button that copies the full path. */
  let { value, label }: { value: string; label: string } = $props();

  function copy() {
    navigator.clipboard?.writeText(value).then(
      () => toast.success("Copied path"),
      () => toast.error("Copy failed"),
    );
  }
</script>

<span class="path">
  <code class="t-mono" title={value}>{shortPath(value)}</code>
  <IconButton icon="copy" label="Copy {label}" size="xs" onclick={copy} />
</span>
