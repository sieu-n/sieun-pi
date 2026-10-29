<script lang="ts">
  import Button from "$lib/ui/Button.svelte";
  import Dialog from "$lib/ui/Dialog.svelte";
  import Field from "$lib/ui/Field.svelte";
  import Input from "$lib/ui/Input.svelte";
  import { sidebarSections } from "./sidebar-sections.svelte";

  /** The sidebar's section dialogs: name a new section, rename one, or confirm deleting one that still holds channels. */
  type Props = { channelCount: (id: string) => number };
  let { channelCount }: Props = $props();

  let name = $state("");
  let error = $state<string | null>(null);

  const target = $derived(sidebarSections.dialog);
  const section = $derived(target && target.kind !== "new" ? sidebarSections.section(target.id) : undefined);
  const title = $derived(target?.kind === "rename" ? "Rename section" : "New section");

  $effect(() => {
    const t = target;
    name = t?.kind === "rename" ? (sidebarSections.section(t.id)?.name ?? "") : "";
    error = null;
  });

  function close() {
    sidebarSections.dialog = null;
  }

  function save(event: Event) {
    event.preventDefault();
    if (!target || target.kind === "delete") return;
    error = sidebarSections.nameError(name, target.kind === "rename" ? target.id : undefined);
    if (error) return;
    if (target.kind === "rename") sidebarSections.rename(target.id, name);
    else sidebarSections.create(name, target.channelId);
    close();
  }

  function remove() {
    if (target?.kind === "delete") sidebarSections.remove(target.id);
    close();
  }
</script>

{#if target?.kind === "delete"}
  {@const count = channelCount(target.id)}
  <Dialog open title="Delete {section?.name ?? 'section'}?" width={420} onclose={close}>
    <p class="t-body-sm">{count === 1 ? "Its channel moves" : `Its ${count} channels move`} back to Channels.</p>
    {#snippet actions()}
      <Button variant="ghost" onclick={close}>Cancel</Button>
      <Button variant="danger" onclick={remove}>Delete section</Button>
    {/snippet}
  </Dialog>
{:else if target}
  <Dialog open {title} width={420} dirty={!!name.trim() && name.trim() !== section?.name} initialFocus="#section-name" onclose={close}>
    <form id="section-name-form" onsubmit={save}>
      <Field label="Name" id="section-name" {error}>
        <Input id="section-name" bind:value={name} placeholder="Projects" autocomplete="off" invalid={!!error} oninput={() => (error = null)} />
      </Field>
    </form>
    {#snippet actions()}
      <Button variant="ghost" onclick={close}>Cancel</Button>
      <Button variant="primary" type="submit" form="section-name-form">{target.kind === "rename" ? "Save" : "Create section"}</Button>
    {/snippet}
  </Dialog>
{/if}

<style>
  p {
    margin: 0;
    color: var(--text-subtle);
  }
</style>
