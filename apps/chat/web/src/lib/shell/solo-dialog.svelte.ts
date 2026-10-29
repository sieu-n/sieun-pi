/** Whether the create-Solo dialog is open. The sidebar's Solo + and the top bar's New menu open it; App mounts the dialog once. */
class SoloDialog {
  isOpen = $state(false);

  open(): void {
    this.isOpen = true;
  }

  close(): void {
    this.isOpen = false;
  }
}

export const soloDialog = new SoloDialog();
