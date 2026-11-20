<script lang="ts" module>
  /** Whether the sidebar a SidebarFrame draws is the one on the screen, for a sidebar the shell keeps mounted behind another. */
  export const NAV_PAGE = Symbol("nav-page");
  export type NavPageState = { readonly active: boolean };
</script>

<script lang="ts">
  import { setContext, type Component } from "svelte";

  /**
   * One root's sidebar, kept mounted while another root's shows. On 11-20 a switch from a DM to an agent's page spent 16 to 40 ms of its
   * 104 to 177 ms taking the Messages sidebar's 624 nodes out and 8 to 26 ms building the Agents one (~/work/p106-panel-open/summary.md),
   * on every switch; a kept sidebar only hides and shows.
   */
  let { Side, active }: { Side: Component; active: boolean } = $props();
  setContext<NavPageState>(NAV_PAGE, {
    get active() {
      return active;
    },
  });
</script>

<div class="nav-page" hidden={!active} inert={!active}><Side /></div>

<style>
  .nav-page {
    display: contents;
  }
  .nav-page[hidden] {
    display: none;
  }
</style>
