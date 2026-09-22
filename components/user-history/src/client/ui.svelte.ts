class Ui {
  renameTick = $state(0);
  requestRename(): void { this.renameTick++; }
}
export const ui = new Ui();
