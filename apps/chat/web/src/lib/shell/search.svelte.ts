/**
 * Search popover state. The shell opens it from the top bar pill, Cmd K (global) and Cmd F (this conversation,
 * only while a conversation is open). pages/search/SearchDialog.svelte reads it.
 */
export type SearchScope = { kind: "global" } | { kind: "conversation"; id: string };

class SearchState {
  isOpen = $state(false);
  scope = $state<SearchScope>({ kind: "global" });
  /** Text to prefill, for example from a "Search for this" action. */
  query = $state("");

  open(scope: SearchScope = { kind: "global" }, query = ""): void {
    this.scope = scope;
    this.query = query;
    this.isOpen = true;
  }
  close(): void {
    this.isOpen = false;
  }
  toggle(scope: SearchScope = { kind: "global" }): void {
    if (this.isOpen && this.scope.kind === scope.kind) this.close();
    else this.open(scope);
  }
}

export const search = new SearchState();
