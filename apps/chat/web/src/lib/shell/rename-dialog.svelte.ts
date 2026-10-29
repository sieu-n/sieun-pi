/** The channel rename dialog's target. The channel header menu and a sidebar row's menu open it; App mounts the dialog once. */
class RenameDialog {
  target = $state<{ id: string; name: string } | null>(null);

  open(id: string, name: string): void {
    this.target = { id, name };
  }

  close(): void {
    this.target = null;
  }
}

export const renameDialog = new RenameDialog();
