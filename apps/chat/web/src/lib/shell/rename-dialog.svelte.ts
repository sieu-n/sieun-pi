/**
 * The rename dialog's target, a channel, a Solo room, an agent or a wiki page, whose rename is a move to a new path. A room's header menu,
 * a sidebar row's menu, an agent's menu and the wiki pane's menu open it; App mounts the dialog once.
 */
export type RenameKind = "channel" | "solo" | "agent" | "page";
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
