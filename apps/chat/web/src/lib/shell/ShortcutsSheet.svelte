<script lang="ts">
  import Dialog from "$lib/ui/Dialog.svelte";
  import ShortcutList from "./ShortcutList.svelte";
  import { shortcutsSheet } from "./shortcuts-sheet.svelte";
  import { shortcutLabel } from "$lib/shortcuts";
</script>

<Dialog
  open={shortcutsSheet.isOpen}
  title="Keyboard shortcuts"
  description="{shortcutLabel('shortcuts')} opens this list from anywhere."
  width={760}
  onclose={() => shortcutsSheet.close()}
>
  <ShortcutList />
</Dialog>
