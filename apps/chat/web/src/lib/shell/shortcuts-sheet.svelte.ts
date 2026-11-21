/** Whether the Keyboard shortcuts sheet is open. Cmd+/ and the profile menu open it; App mounts lib/shell/ShortcutsSheet.svelte once. */
class ShortcutsSheet {
  isOpen = $state(false);

  open(): void {
    this.isOpen = true;
  }

  close(): void {
    this.isOpen = false;
  }

  toggle(): void {
    this.isOpen = !this.isOpen;
  }
}

export const shortcutsSheet = new ShortcutsSheet();
