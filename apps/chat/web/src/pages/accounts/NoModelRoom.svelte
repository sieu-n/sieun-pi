<script lang="ts">
  import type { NoModelRoom, NoModelRoomSetting } from "$lib/api/shared/types.ts";
  import { Select, toast } from "$lib/ui";
  import { stampLabel } from "$lib/ui/datetime";
  import { accountsApi } from "./api";

  /** The pool's `no_model_room`: what a sw factory agent's turn does when no account has room for its model. Prime sessions keep Prime's own wait. */
  const OPTIONS: { value: NoModelRoom; label: string }[] = [
    { value: "wait", label: "Wait for an account" },
    { value: "switch", label: "Switch to a model the account has" },
    { value: "fail", label: "Fail the turn" },
  ];

  let setting = $state<NoModelRoomSetting | null>(null);
  let error = $state<string | null>(null);
  let saving = $state(false);
  let value = $state<NoModelRoom>("wait");

  const message = (caught: unknown): string => (caught instanceof Error ? caught.message : String(caught));

  function show(next: NoModelRoomSetting): void {
    setting = next;
    value = next.value;
    error = null;
  }

  $effect(() => {
    accountsApi.noModelRoom().then(show, caught => (error = message(caught)));
  });

  async function save(next: NoModelRoom): Promise<void> {
    saving = true;
    try {
      show(await accountsApi.setNoModelRoom(next));
    } catch (caught) {
      if (setting) value = setting.value;
      toast.error(message(caught));
    } finally {
      saving = false;
    }
  }

  const setBy = $derived(setting?.set ? `Set by ${setting.set.by ?? "an unnamed writer"}, ${stampLabel(setting.set.at)}.` : "pi-pool's default.");
</script>

<section class="setting" data-testid="no-model-room" aria-labelledby="no-model-room-label">
  <div class="text">
    <span class="label" id="no-model-room-label">When no account has room for an agent's model</span>
    <span class="hint">This applies to sw factory agents. Prime chats keep their own setting.</span>
  </div>
  <div class="control">
    {#if error && !setting}
      <span class="failed" data-testid="no-model-room-error">{error}</span>
    {:else}
      <Select label="When no account has room for an agent's model" size="sm" options={OPTIONS} bind:value disabled={!setting || saving} onchange={next => void save(next)} />
      <span class="by" data-testid="no-model-room-by">{setting ? setBy : ""}</span>
    {/if}
  </div>
</section>

<style>
  .setting { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-4); padding: var(--space-3) 0; border-top: 1px solid var(--border-standard); }
  .text { display: flex; flex: 1 1 20rem; flex-direction: column; gap: 2px; min-width: 0; }
  .label { color: var(--text-standard); font: var(--text-body); }
  .hint, .by { color: var(--text-subtle); font: var(--text-body-sm); }
  .control { display: flex; flex-direction: column; align-items: flex-end; gap: var(--space-1); }
  .failed { color: var(--text-danger); font: var(--text-body-sm); }
</style>
