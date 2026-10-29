<script lang="ts">
  import { api, type AgentSummary } from "$lib/api";
  import { router } from "$lib/router.svelte";
  import Avatar from "$lib/ui/Avatar.svelte";
  import Button from "$lib/ui/Button.svelte";
  import Chip from "$lib/ui/Chip.svelte";
  import Field from "$lib/ui/Field.svelte";
  import Input from "$lib/ui/Input.svelte";
  import PanelHeader from "$lib/ui/PanelHeader.svelte";
  import Picker from "$lib/ui/Picker.svelte";
  import { toast } from "$lib/ui/toast.svelte";
  import Composer from "./Composer.svelte";
  import { directory } from "./directory.svelte";
  import { agentPickerItems, type Outgoing } from "./present";

  type Props = { kind: string };
  let { kind }: Props = $props();

  /** Registered agents only: a job works inside its agent and is never a member or a DM of its own. */
  const live = $derived(directory.agents.filter((a) => a.id.startsWith("ag_") && !a.archived));
  const agentItems = $derived(agentPickerItems(directory.agents));
  const fail = (error: unknown) => toast.error(error instanceof Error ? error.message : "That did not work");

  async function startChat(out: Outgoing) {
    // A new chat is a solo root chat, never an agent: untitled agents filled every picker on 10-29.
    const agent = await api.createAgent({ kind: "solo" });
    const room = agent.room ?? agent.id;
    await api.send(room, { text: out.text, images: out.images, mentions: out.mentions, requestId: crypto.randomUUID() });
    router.openConversation(room);
  }

  let name = $state("");
  let purpose = $state("");
  let members = $state<string[]>([]);
  let pickerOpen = $state(false);
  let addButton = $state<HTMLElement>();
  let busy = $state(false);
  const memberRows = $derived(members.map((id) => live.find((a) => a.id === id)).filter((a): a is AgentSummary => !!a));
  const slug = $derived(name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));

  async function createChannel(e: SubmitEvent) {
    e.preventDefault();
    if (!slug || busy) return;
    busy = true;
    try {
      const channel = await api.createRoom({ kind: "channel", name: slug, agenda: purpose.trim(), members });
      router.openConversation(channel.id);
    } catch (error) {
      fail(error);
    } finally {
      busy = false;
    }
  }

  async function openDm(agent: string) {
    try {
      const summary = await api.openDm(agent);
      router.openConversation(summary.id);
    } catch (error) {
      fail(error);
    }
  }
  let dmOpen = $state(true);
  let dmAnchor = $state<HTMLElement>();
</script>

{#if kind === "channel"}
  <PanelHeader title="New channel" icon="hash" level={1} divider />
  <form class="form" onsubmit={createChannel}>
    <Field label="Name" id="channel-name" hint={slug ? `#${slug}` : "Lowercase words joined by dashes"}>
      <Input id="channel-name" bind:value={name} placeholder="pi-cutover" autocomplete="off" />
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
      <Button variant="primary" type="submit" disabled={!slug} loading={busy}>Create channel</Button>
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
{:else if kind === "dm"}
  <PanelHeader title="New message" icon="chat" level={1} divider />
  <div class="form">
    <div class="to" bind:this={dmAnchor}>
      <span class="t-label-sm">To:</span>
      <Button variant="outline" size="sm" trailingIcon="chevron-down" onclick={() => (dmOpen = true)}>Choose an agent</Button>
    </div>
    <div class="recent">
      {#each live.slice(0, 8) as agent (agent.id)}
        <button type="button" class="agent" onclick={() => openDm(agent.id)}>
          <Avatar name={agent.name} kind="agent" seed={agent.id} size={28} />
          <span>{agent.name}</span>
        </button>
      {/each}
    </div>
  </div>
  <Picker bind:open={dmOpen} anchor={dmAnchor} items={agentItems} searchable label="Message" onselect={(id) => openDm(id)} />
{:else}
  <PanelHeader title="New chat" icon="chat" level={1} divider />
  <div class="draft">
    <div class="hello">
      <p class="t-heading">What should your new chat work on?</p>
      <p class="sub">The first message starts a new chat on the default model.</p>
    </div>
    <Composer placeholder="Message your agents" agents={directory.agents} channels={directory.channels} draftKey="new-chat" autofocus onsend={startChat} />
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
    justify-content: flex-end;
  }
  .to {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .recent {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .agent {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 8px;
    border: 0;
    border-radius: var(--radius-row);
    background: transparent;
    color: var(--text-standard);
    font: var(--text-body-sm);
    text-align: left;
    cursor: pointer;
  }
  .agent:hover {
    background: var(--affordance-ghost-hover);
  }
  .draft {
    display: flex;
    flex: 1;
    flex-direction: column;
    justify-content: flex-end;
    min-height: 0;
  }
  .hello {
    margin: auto auto 24px;
    text-align: center;
  }
  .hello p {
    margin: 0;
  }
  .sub {
    margin-top: 8px !important;
    color: var(--text-subtle);
    font: var(--text-body-sm);
  }
</style>
