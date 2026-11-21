<script lang="ts">
  import type { NoModelRoom, NoModelRoomSetting } from "$lib/api/shared/types.ts";
  import { Select, toast, tooltip } from "$lib/ui";
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
  const hint = $derived(`This applies to sw factory agents. Prime chats keep their own setting. ${setting ? setBy : ""}`.trim());
</script>

<section class="setting" data-testid="no-model-room" aria-labelledby="no-model-room-label">
  <span class="label" id="no-model-room-label" data-testid="no-model-room-hint" use:tooltip={hint}>When no account has room for an agent's model</span>
  {#if error && !setting}
    <span class="failed" data-testid="no-model-room-error" title={error}>Could not read this setting.</span>
  {:else}
    <Select label="When no account has room for an agent's model" size="sm" options={OPTIONS} bind:value disabled={!setting || saving} onchange={next => void save(next)} />
  {/if}
</section>

<style>
  .setting { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-2) var(--space-4); margin-top: var(--space-4); padding-top: var(--space-3); border-top: 1px solid var(--border-standard); }
  .label { color: var(--text-standard); font: var(--text-body-sm); cursor: default; }
  .failed { color: var(--text-danger); font: var(--text-body-sm); }
</style>
