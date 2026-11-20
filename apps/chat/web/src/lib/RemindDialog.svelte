<script lang="ts">
  import Button from "$lib/ui/Button.svelte";
  import Dialog from "$lib/ui/Dialog.svelte";
  import Field from "$lib/ui/Field.svelte";
  import Input from "$lib/ui/Input.svelte";
  import { fromPicker, pickerValues, remindPresets, whenLabel } from "./remind";

  /** Remind me's Custom: a date and a time in the owner's local time, which must be ahead of now. */
  type Props = { title?: string; at?: number; onpick: (at: number) => void | Promise<void>; onclose: () => void };
  let { title = "Remind me about this", at, onpick, onclose }: Props = $props();

  // svelte-ignore state_referenced_locally
  const start = pickerValues(at && at > Date.now() ? at : remindPresets().find((p) => p.id === "tomorrow")!.at);
  let date = $state(start.date);
  let time = $state(start.time);
  let open = $state(true);
  let pending = $state(false);
  const picked = $derived(fromPicker(date, time));
  const error = $derived(picked === null ? "Pick a date and a time." : picked <= Date.now() ? "Pick a time ahead of now." : null);

  async function save(event?: Event) {
    event?.preventDefault();
    if (pending || error || picked === null) return;
    pending = true;
    try {
      await onpick(picked);
      open = false;
      onclose();
    } finally {
      pending = false;
    }
  }
</script>

<Dialog bind:open {title} width={400} initialFocus="#remind-date" {onclose}>
  <form id="remind-form" class="fields" onsubmit={save} aria-label="Custom reminder">
    <Field label="Date" id="remind-date">
      <Input id="remind-date" type="date" bind:value={date} min={pickerValues(Date.now()).date} required disabled={pending} />
    </Field>
    <Field label="Time" id="remind-time" error={error && date && time ? error : null} hint={picked && !error ? whenLabel(picked) : undefined}>
      <Input id="remind-time" type="time" bind:value={time} required disabled={pending} invalid={!!error && !!date && !!time} />
    </Field>
  </form>
  {#snippet actions()}
    <Button variant="ghost" onclick={() => ((open = false), onclose())} disabled={pending}>Cancel</Button>
    <Button variant="primary" type="submit" form="remind-form" loading={pending} disabled={pending || !!error} data-remind-save>Save</Button>
  {/snippet}
</Dialog>

<style>
  .fields {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
</style>
