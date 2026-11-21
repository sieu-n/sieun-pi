<script lang="ts">
  import { api } from "$lib/api";
  import Button from "$lib/ui/Button.svelte";
  import Dialog from "$lib/ui/Dialog.svelte";
  import Field from "$lib/ui/Field.svelte";
  import Input from "$lib/ui/Input.svelte";
  import { toast } from "$lib/ui/toast.svelte";

  /** Renames a channel through `PATCH /api/rooms/:id`; the server normalizes the name and refuses a blank one or one an open channel holds. */
  type Props = { target: { id: string; name: string }; onclose: () => void };
  let { target, onclose }: Props = $props();

  // svelte-ignore state_referenced_locally
  let name = $state(target.name);
  let open = $state(true);
  let pending = $state(false);
  let error = $state<string | null>(null);

  /** Lowercases and turns spaces into dashes as the owner types, as Slack does, so the field shows the name the server keeps. */
  const slug = (text: string): string => text.trimStart().replace(/^#/, "").toLowerCase().replace(/\s+/g, "-");
  const typed = $derived(name.trim().replace(/^#/, ""));
  const unchanged = $derived(!typed || typed === target.name);

  async function rename(event?: Event) {
    event?.preventDefault();
    if (pending || unchanged) return;
    pending = true;
    error = null;
    try {
      const room = await api.updateRoom(target.id, { name: typed });
      open = false;
      onclose();
      toast.success(`Renamed to #${room.name}`);
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
      pending = false;
    }
  }
</script>

<Dialog bind:open title="Rename channel" width={440} dirty={name !== target.name} initialFocus="#rename-channel-name" {onclose}>
  <form id="rename-channel-form" onsubmit={rename} aria-label="Rename channel">
    <Field label="Name" id="rename-channel-name" {error}>
      <Input
        id="rename-channel-name"
        icon="hash"
        bind:value={name}
        autocomplete="off"
        spellcheck={false}
        invalid={!!error}
        disabled={pending}
        oninput={() => {
          name = slug(name);
          error = null;
        }}
        onfocus={(e) => e.currentTarget.select()}
      />
    </Field>
  </form>
  {#snippet actions()}
    <Button variant="ghost" onclick={() => ((open = false), onclose())} disabled={pending}>Cancel</Button>
    <Button variant="primary" type="submit" form="rename-channel-form" loading={pending} disabled={pending || unchanged}>Rename</Button>
  {/snippet}
</Dialog>
