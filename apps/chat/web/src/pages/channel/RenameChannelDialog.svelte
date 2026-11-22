<script lang="ts">
  import { api } from "$lib/api";
  import Button from "$lib/ui/Button.svelte";
  import Dialog from "$lib/ui/Dialog.svelte";
  import Field from "$lib/ui/Field.svelte";
  import Input from "$lib/ui/Input.svelte";
  import { toast } from "$lib/ui/toast.svelte";
  import type { RenameKind } from "$lib/shell/rename-dialog.svelte";
  import { agentsChanged } from "$pages/agents/agent-actions.svelte";
  import { moveAndFollow } from "$lib/shell/wiki-page";

  /**
   * Renames a channel through `PATCH /api/rooms/:id`, where the server normalizes the name and refuses a blank one or one an open channel
   * holds, a Solo room through the same route, which keeps the name as typed, an agent through `PATCH /api/c/<its DM>`, which keeps it too,
   * or a wiki page, whose name is its path, by a move (lib/shell/wiki-page.ts), whose toast carries its own Undo.
   */
  type Props = { target: { id: string; name: string; kind: RenameKind }; onclose: () => void };
  let { target, onclose }: Props = $props();

  // svelte-ignore state_referenced_locally
  let name = $state(target.name);
  let open = $state(true);
  let pending = $state(false);
  let error = $state<string | null>(null);

  /** Lowercases and turns spaces into dashes as the owner types, as Slack does, so the field shows the name the server keeps. */
  const slug = (text: string): string => text.trimStart().replace(/^#/, "").toLowerCase().replace(/\s+/g, "-");
  const channel = $derived(target.kind === "channel");
  const noun = $derived(({ channel: "channel", solo: "room", agent: "agent", page: "page" } as const)[target.kind]);
  const page = $derived(target.kind === "page");
  const typed = $derived(channel ? name.trim().replace(/^#/, "") : name.trim());
  const unchanged = $derived(!typed || typed === target.name);

  async function rename(event?: Event) {
    event?.preventDefault();
    if (pending || unchanged) return;
    pending = true;
    error = null;
    try {
      if (target.kind === "page") {
        await moveAndFollow(target.id, typed);
        open = false;
        onclose();
        return;
      }
      const renamed =
        target.kind === "agent" ? (await api.renameAgent(target.id, typed), typed) : `${channel ? "#" : ""}${(await api.updateRoom(target.id, { name: typed })).name}`;
      if (target.kind === "agent") agentsChanged();
      open = false;
      onclose();
      toast.success(`Renamed to ${renamed}`);
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
      pending = false;
    }
  }
</script>

<Dialog bind:open title={page ? "Move page" : `Rename ${noun}`} width={440} dirty={name !== target.name} initialFocus="#rename-channel-name" {onclose}>
  <form id="rename-channel-form" onsubmit={rename} aria-label={page ? "Move page" : `Rename ${noun}`}>
    <Field label={page ? "Path" : "Name"} id="rename-channel-name" {error} hint={page ? "The old path keeps sending readers to the new one." : undefined}>
      <Input
        id="rename-channel-name"
        icon={({ channel: "hash", solo: "users", agent: "robot", page: "file" } as const)[target.kind]}
        bind:value={name}
        autocomplete="off"
        spellcheck={false}
        invalid={!!error}
        disabled={pending}
        oninput={() => {
          if (channel) name = slug(name);
          error = null;
        }}
        onfocus={(e) => e.currentTarget.select()}
      />
    </Field>
  </form>
  {#snippet actions()}
    <Button variant="ghost" onclick={() => ((open = false), onclose())} disabled={pending}>Cancel</Button>
    <Button variant="primary" type="submit" form="rename-channel-form" loading={pending} disabled={pending || unchanged}>{page ? "Move" : "Rename"}</Button>
  {/snippet}
</Dialog>
