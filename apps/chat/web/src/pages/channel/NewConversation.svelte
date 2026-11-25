<script lang="ts">
  import { api, keepOpened, type AgentSummary } from "$lib/api";
  import { router } from "$lib/router.svelte";
  import { sidebar } from "$lib/shell/sidebar.svelte";
  import { sidebarSections } from "$lib/shell/sidebar-sections.svelte";
  import { isSectionId } from "$lib/api/shared/sidebar-layout";
  import Button from "$lib/ui/Button.svelte";
  import Chip from "$lib/ui/Chip.svelte";
  import Field from "$lib/ui/Field.svelte";
  import Input from "$lib/ui/Input.svelte";
  import PanelHeader from "$lib/ui/PanelHeader.svelte";
  import Picker from "$lib/ui/Picker.svelte";
  import RecipientField from "$lib/ui/RecipientField.svelte";
  import TextArea from "$lib/ui/TextArea.svelte";
  import { composing } from "$lib/ui/keyboard";
  import { toast } from "$lib/ui/toast.svelte";
  import { directory } from "./directory.svelte";
  import { agentPickerItems, recentAgentItems } from "./present";

  /**
   * `channel` opens the new-channel form. `solo` and any other kind, an old `chat` link too, open New message, whose To: takes several
   * agents as Slack's does: one agent opens its DM, and two or more, or any number from New Solo room (`solo`), start a Solo room whose
   * first message is its agenda.
   */
  type Props = { kind: string; section?: string };
  let { kind, section }: Props = $props();
  /** The sidebar section a channel made from that section's Add channel lands in. */
  const into = $derived(section && isSectionId(section) ? sidebarSections.section(section) : undefined);

  /** Registered agents only: a job works inside its agent and is never a member or a DM of its own. */
  const live = $derived(directory.agents.filter((a) => a.id.startsWith("ag_") && !a.archived));
  const agentItems = $derived(agentPickerItems(directory.agents));
  const fail = (error: unknown) => toast.error(error instanceof Error ? error.message : "That did not work");

  let name = $state("");
  let purpose = $state("");
  let members = $state<string[]>([]);
  let pickerOpen = $state(false);
  let addButton = $state<HTMLElement>();
  let busy = $state(false);
  const memberRows = $derived(members.map((id) => live.find((a) => a.id === id)).filter((a): a is AgentSummary => !!a));
  const slug = $derived(name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
  /** The server refuses a name an open channel holds (server/group-rooms.ts), so the form says so while he types, as Slack does. */
  const taken = $derived(!!slug && directory.channels.some((c) => c.name === slug && !c.archived));

  async function createChannel(e: SubmitEvent) {
    e.preventDefault();
    if (!slug || taken || busy) return;
    busy = true;
    try {
      const channel = await api.createRoom({ kind: "channel", name: slug, agenda: purpose.trim(), members });
      keepOpened(channel.id, channel.opened);
      if (into) sidebarSections.move(channel.id, into.id);
      router.openConversation(channel.id);
    } catch (error) {
      fail(error);
    } finally {
      busy = false;
    }
  }

  let toInput = $state<HTMLInputElement>();
  let agenda = $state("");
  let agendaBox = $state<HTMLTextAreaElement>();
  const group = $derived(kind === "solo" || members.length > 1);
  const recent = $derived(recentAgentItems(directory.agents, sidebar.data.dms.map((row) => row.agent)));
  const named = $derived(memberRows.map((a) => a.name));
  const listNames = (list: readonly string[]): string => (list.length < 3 ? list.join(" and ") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`);

  $effect(() => {
    toInput?.focus();
  });

  async function openDm() {
    const agent = members[0];
    if (!agent || busy) return;
    busy = true;
    try {
      const summary = await api.openDm(agent);
      router.openConversation(summary.id);
    } catch (error) {
      fail(error);
      busy = false;
    }
  }

  async function createSolo(e?: Event) {
    e?.preventDefault();
    if (!agenda.trim() || !members.length || busy) return;
    busy = true;
    try {
      const room = await api.createRoom({ kind: "solo", agenda: agenda.trim(), members });
      keepOpened(room.id, room.opened);
      router.openConversation(room.id);
    } catch (error) {
      fail(error);
      busy = false;
    }
  }

  function onAgendaKeydown(e: KeyboardEvent) {
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    if (composing(e)) return;
    void createSolo();
  }
</script>

{#if kind === "channel"}
  <PanelHeader title={into ? `New channel in ${into.name}` : "New channel"} icon="hash" level={1} divider />
  <form class="form" onsubmit={createChannel}>
    <Field label="Name" id="channel-name" hint={slug ? `#${slug}` : "Lowercase words joined by dashes"} error={taken ? `That name is already taken by a channel.` : null}>
      <Input id="channel-name" bind:value={name} placeholder="pi-cutover" autocomplete="off" invalid={taken} aria-describedby={taken ? "channel-name-error" : "channel-name-hint"} />
    </Field>
    <Field label="Purpose" id="channel-purpose" optional>
      <Input id="channel-purpose" bind:value={purpose} placeholder="What this room is for" autocomplete="off" />
    </Field>
    <div class="members">
      <span class="label t-label-sm">Members</span>
      <div class="chips">
        <Chip label="You" />
        {#each memberRows as agent (agent.id)}
          <Chip label={agent.name} onremove={() => (members = members.filter((m) => m !== agent.id))} />
        {/each}
        <Button variant="ghost" size="sm" icon="plus" bind:element={addButton} onclick={() => (pickerOpen = true)}>Add agents</Button>
      </div>
    </div>
    <div class="buttons">
      <Button variant="primary" type="submit" disabled={!slug || taken} loading={busy}>Create channel</Button>
    </div>
  </form>
  <Picker
    bind:open={pickerOpen}
    anchor={addButton}
    items={agentItems}
    value={members}
    multiple
    searchable
    label="Add members"
    onselect={(id) => (members = members.includes(id) ? members.filter((m) => m !== id) : [...members, id])}
  />
{:else}
  <PanelHeader title={kind === "solo" ? "New Solo room" : "New message"} icon={kind === "solo" ? "users" : "chat"} level={1} divider />
  <div class="form">
    <RecipientField
      id="new-to"
      items={recent}
      bind:value={members}
      bind:input={toInput}
      placeholder="Type an agent's name"
      listLabel="Agents"
      emptyText="No agents match"
      onsubmit={() => (group ? agendaBox?.focus() : void openDm())}
    />
    {#if !members.length}
      <p class="hint t-body-sm">{kind === "solo" ? "Pick the agents to invite." : "Pick one agent to open its DM, or several to start a Solo room with all of them."}</p>
    {:else if !group}
      <div class="buttons">
        <p class="hint t-body-sm">Add another agent to start a Solo room instead.</p>
        <Button variant="primary" loading={busy} onclick={openDm}>Open DM with {named[0]}</Button>
      </div>
    {:else}
      <form class="solo" onsubmit={createSolo} aria-label="New Solo room">
        <Field label="First message" id="new-agenda" hint="It becomes the room's agenda, and its first line names the room. Every agent in a Solo room hears every post.">
          <TextArea id="new-agenda" bind:element={agendaBox} bind:value={agenda} rows={3} maxRows={10} placeholder="What should {listNames(named)} settle?" disabled={busy} onkeydown={onAgendaKeydown} />
        </Field>
        <div class="buttons">
          <Button variant="primary" type="submit" disabled={!agenda.trim()} loading={busy}>Create Solo room</Button>
        </div>
      </form>
    {/if}
  </div>
{/if}

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: 20px;
    width: min(100% - 48px, 32rem);
    margin: 32px auto;
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
  .buttons {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 12px;
  }
  .buttons .hint {
    flex: 1;
  }
  .hint {
    margin: 0;
    color: var(--text-metadata);
  }
  .solo {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
</style>
