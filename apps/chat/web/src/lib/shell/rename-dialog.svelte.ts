/**
 * The rename dialog's target, a channel, a Solo room or an agent. A room's header menu, a sidebar row's menu and an agent's menu open it; App mounts
 * the dialog once.
 */
export type RenameKind = "channel" | "solo" | "agent";
class RenameDialog {
  target = $state<{ id: string; name: string; kind: RenameKind } | null>(null);

  open(id: string, name: string, kind: RenameKind = "channel"): void {
    this.target = { id, name, kind };
  }

  close(): void {
    this.target = null;
  }
}

export const renameDialog = new RenameDialog();
