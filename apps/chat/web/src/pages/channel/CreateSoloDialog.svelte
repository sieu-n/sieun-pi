<script lang="ts">
  import { api } from "$lib/api";
  import { router } from "$lib/router.svelte";
  import Avatar from "$lib/ui/Avatar.svelte";
  import Button from "$lib/ui/Button.svelte";
  import Chip from "$lib/ui/Chip.svelte";
  import Dialog from "$lib/ui/Dialog.svelte";
  import Field from "$lib/ui/Field.svelte";
  import Input from "$lib/ui/Input.svelte";
  import Picker from "$lib/ui/Picker.svelte";
  import TextArea from "$lib/ui/TextArea.svelte";
  import { directory } from "./directory.svelte";
  import { agentPickerItems } from "./present";

  /** A Solo room: the owner and the agents he invites, around one agenda (agent-model.md phase 5). Only registered agents are offered. */
  type Props = { open: boolean; onclose: () => void };
  let { open = $bindable(), onclose }: Props = $props();

  let agenda = $state("");
  let name = $state("");
  let members = $state<string[]>([]);
  let pickerOpen = $state(false);
  let addButton = $state<HTMLElement>();
  let pending = $state(false);
  let error = $state("");
  let agendaError = $state<string | null>(null);
  let membersError = $state<string | null>(null);

  const items = $derived(agentPickerItems(directory.agents));
  const chosen = $derived(members.map((id) => items.find((item) => item.id === id)).filter((item) => !!item));
  const dirty = $derived(!!agenda.trim() || !!name.trim() || members.length > 0);

  function reset() {
    agenda = "";
    name = "";
    members = [];
    error = "";
    agendaError = null;
    membersError = null;
    pending = false;
  }
  function close() {
    open = false;
    reset();
    onclose();
  }
  function toggle(id: string) {
    members = members.includes(id) ? members.filter((m) => m !== id) : [...members, id];
    membersError = null;
  }

  async function create(event?: Event) {
    event?.preventDefault();
    if (pending) return;
    agendaError = agenda.trim() ? null : "Write what this room should settle";
    membersError = members.length ? null : "Invite at least one agent";
    if (agendaError || membersError) return;
    pending = true;
    error = "";
    try {
      const room = await api.createRoom({ kind: "solo", agenda: agenda.trim(), members, ...(name.trim() ? { name: name.trim() } : {}) });
      open = false;
      reset();
      onclose();
      router.openConversation(room.id);
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
      pending = false;
    }
  }
</script>

<Dialog bind:open title="New Solo room" description="A group chat with the agents you invite, around one agenda. Every agent hears every post." width={532} {dirty} initialFocus="#solo-agenda" onclose={close}>
  <form id="create-solo-form" class="form" onsubmit={create} aria-label="New Solo room">
    <Field label="Agenda" id="solo-agenda" error={agendaError}>
      <TextArea id="solo-agenda" bind:value={agenda} rows={3} maxRows={8} placeholder="Pick the relay protocol" invalid={!!agendaError} disabled={pending} oninput={() => (agendaError = null)} />
    </Field>
    <Field label="Name" id="solo-name" optional hint="Defaults to the start of the agenda">
      <Input id="solo-name" bind:value={name} placeholder="relay protocol" autocomplete="off" disabled={pending} />
    </Field>
    <div class="members" data-testid="solo-invite">
      <span class="t-label-sm">Agents</span>
      <div class="chips">
        {#each chosen as agent (agent.id)}
          <Chip label={agent.label} onremove={() => toggle(agent.id)}>
            {#snippet leading()}<Avatar name={agent.label} kind="agent" seed={agent.id} size={16} />{/snippet}
          </Chip>
        {/each}
        <Button variant="ghost" size="sm" icon="plus" bind:element={addButton} disabled={pending} onclick={() => (pickerOpen = true)}>Invite agents</Button>
      </div>
      {#if membersError}<p class="error t-caption" role="alert">{membersError}</p>{/if}
    </div>
    {#if error}<p class="error t-body-sm" role="alert">{error}</p>{/if}
  </form>
  {#snippet actions()}
    <Button variant="primary" type="submit" form="create-solo-form" loading={pending} disabled={pending}>Create Solo room</Button>
  {/snippet}
</Dialog>

<Picker
  bind:open={pickerOpen}
  anchor={addButton}
  {items}
  value={members}
  multiple
  searchable
  label="Invite agents"
  emptyText="No agents match"
  onselect={(id) => toggle(id)}
/>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }
  .members {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .error {
    margin: 0;
    color: var(--text-danger);
  }
</style>
