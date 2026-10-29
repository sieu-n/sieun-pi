/** Whether the Create agent dialog is open. The Agents sidebar's "+" and the page's New agent button open it; AgentsPage mounts the dialog once. */
class CreateAgent {
  isOpen = $state(false);

  open(): void {
    this.isOpen = true;
  }

  close(): void {
    this.isOpen = false;
  }
}

export const createAgent = new CreateAgent();
