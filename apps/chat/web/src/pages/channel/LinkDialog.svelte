<script lang="ts">
  import Button from "$lib/ui/Button.svelte";
  import Dialog from "$lib/ui/Dialog.svelte";
  import Field from "$lib/ui/Field.svelte";
  import Input from "$lib/ui/Input.svelte";
  import { linkHref } from "./composer-format";

  /** Slack's Add link dialog: the link's text and its address; Enter saves and Esc drops it. */
  type Props = { open: boolean; text: string; url: string; onsave: (text: string, url: string) => void; onclose: () => void };
  let { open = $bindable(), text, url, onsave, onclose }: Props = $props();

  // svelte-ignore state_referenced_locally
  let draftText = $state(text);
  // svelte-ignore state_referenced_locally
  let draftUrl = $state(url);
  const editing = $derived(!!url);
  const ready = $derived(!!linkHref(draftUrl));

  function save(e?: SubmitEvent) {
    e?.preventDefault();
    if (!ready) return;
    open = false;
    onsave(draftText, draftUrl);
  }
</script>

<Dialog bind:open title={editing ? "Edit link" : "Add link"} width={440} dirty={!!draftUrl} {onclose} initialFocus={text ? "#link-url" : "#link-text"}>
  <form class="link-form" id="link-form" onsubmit={save}>
    <Field label="Text" id="link-text">
      <Input id="link-text" bind:value={draftText} autocomplete="off" />
    </Field>
    <Field label="Link" id="link-url">
      <Input id="link-url" bind:value={draftUrl} autocomplete="off" inputmode="url" placeholder="https://" />
    </Field>
  </form>
  {#snippet actions()}
    <Button variant="accent" type="submit" form="link-form" disabled={!ready} data-testid="link-save">Save</Button>
  {/snippet}
</Dialog>

<style>
  .link-form {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
</style>
