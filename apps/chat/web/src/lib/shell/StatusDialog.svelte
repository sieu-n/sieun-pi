<script lang="ts">
  import Button from "$lib/ui/Button.svelte";
  import Dialog from "$lib/ui/Dialog.svelte";
  import Field from "$lib/ui/Field.svelte";
  import Icon from "$lib/ui/Icon.svelte";
  import IconButton from "$lib/ui/IconButton.svelte";
  import Input from "$lib/ui/Input.svelte";
  import Popover from "$lib/ui/Popover.svelte";
  import Select from "$lib/ui/Select.svelte";
  import EmojiPicker from "$pages/channel/EmojiPicker.svelte";
  import { presence, setStatus } from "$lib/presence.svelte";
  import { toast } from "$lib/ui/toast.svelte";

  /** Slack's Set a status dialog: an emoji, a short text, one of its suggestions, and when the status clears itself. */
  type Props = { onclose: () => void };
  let { onclose }: Props = $props();

  type ClearAfter = "keep" | "never" | "30m" | "1h" | "4h" | "today" | "week";
  const PRESETS: { emoji: string; text: string; clear: ClearAfter; hint: string }[] = [
    { emoji: "🗓️", text: "In a meeting", clear: "1h", hint: "1 hour" },
    { emoji: "🚌", text: "Commuting", clear: "30m", hint: "30 minutes" },
    { emoji: "🤒", text: "Out sick", clear: "today", hint: "Today" },
    { emoji: "🌴", text: "Vacationing", clear: "never", hint: "Don't clear" },
    { emoji: "🏡", text: "Working remotely", clear: "today", hint: "Today" },
  ];

  const current = presence.status;
  let open = $state(true);
  let emoji = $state(current?.emoji ?? "");
  let text = $state(current?.text ?? "");
  let clear = $state<ClearAfter>(current?.until ? "keep" : current ? "never" : "today");
  let picking = $state(false);
  let emojiButton = $state<HTMLButtonElement>();

  const timeFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
  const options = $derived([
    ...(current?.until ? [{ value: "keep" as const, label: `Keep, clears ${timeFmt.format(current.until)}` }] : []),
    { value: "never" as const, label: "Don't clear" },
    { value: "30m" as const, label: "30 minutes" },
    { value: "1h" as const, label: "1 hour" },
    { value: "4h" as const, label: "4 hours" },
    { value: "today" as const, label: "Today" },
    { value: "week" as const, label: "This week" },
  ]);
  const empty = $derived(!emoji && !text.trim());

  function untilFor(choice: ClearAfter): number | undefined {
    const now = new Date();
    if (choice === "keep") return current?.until;
    if (choice === "never") return undefined;
    if (choice === "30m" || choice === "1h" || choice === "4h") return now.getTime() + { "30m": 30, "1h": 60, "4h": 240 }[choice] * 60_000;
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    // This week ends on Sunday night, as in Slack.
    if (choice === "week") end.setDate(end.getDate() + ((7 - end.getDay()) % 7));
    return end.getTime();
  }

  function close() {
    open = false;
    onclose();
  }

  function save(event?: Event) {
    event?.preventDefault();
    if (empty) return;
    const until = untilFor(clear);
    setStatus({ emoji: emoji || "💬", text: text.trim(), ...(until ? { until } : {}) });
    close();
  }

  function clearStatus() {
    const before = presence.status;
    setStatus(null);
    close();
    if (before) toast.show("Status cleared", { action: { label: "Undo", run: () => setStatus(before) } });
  }

  function usePreset(preset: (typeof PRESETS)[number]) {
    emoji = preset.emoji;
    text = preset.text;
    clear = preset.clear;
  }
</script>

<Dialog bind:open title={current ? "Edit status" : "Set a status"} width={460} dirty={!empty && (emoji !== current?.emoji || text !== current?.text)} initialFocus="#status-text" onclose={onclose}>
  <form id="status-form" onsubmit={save} aria-label="Status">
    <Field label="Status" id="status-text">
      <Input id="status-text" bind:value={text} maxlength={100} placeholder="What's your status?" autocomplete="off">
        {#snippet prefix()}
          <button bind:this={emojiButton} type="button" class="emoji" aria-label={emoji ? `Status emoji ${emoji}, change` : "Pick a status emoji"} onclick={() => (picking = !picking)}>
            {#if emoji}{emoji}{:else}<Icon name="smile" size={18} />{/if}
          </button>
        {/snippet}
        {#snippet suffix()}
          {#if !empty}<IconButton icon="close" label="Clear the field" size="sm" onclick={() => ((emoji = ""), (text = ""))} />{/if}
        {/snippet}
      </Input>
    </Field>

    {#if empty}
      <ul class="presets" aria-label="Suggestions">
        {#each PRESETS as preset (preset.text)}
          <li>
            <button type="button" onclick={() => usePreset(preset)}>
              <span class="preset-emoji">{preset.emoji}</span>
              <span>{preset.text}</span>
              <span class="hint">{preset.hint}</span>
            </button>
          </li>
        {/each}
      </ul>
    {:else}
      <div class="clear-after">
        <Select bind:value={clear} {options} label="Clear after" showLabel />
      </div>
    {/if}
  </form>
  {#snippet actions()}
    {#if current}<Button variant="ghost" onclick={clearStatus}>Clear status</Button>{/if}
    <span class="spacer"></span>
    <Button variant="ghost" onclick={close}>Cancel</Button>
    <Button variant="primary" type="submit" form="status-form" disabled={empty}>Save</Button>
  {/snippet}
</Dialog>

<Popover bind:open={picking} anchor={emojiButton} placement="bottom-start" label="Pick a status emoji" surface="solid" padding={0} radius="row">
  <EmojiPicker
    selected={(e) => e === emoji}
    onpick={(picked) => {
      emoji = picked;
      picking = false;
    }}
  />
</Popover>

<style>
  form {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .emoji {
    display: inline-grid;
    place-items: center;
    width: 28px;
    height: 28px;
    margin-left: -4px;
    padding: 0;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--text-subtle);
    font-size: 18px;
    line-height: 1;
  }
  .emoji:hover {
    background: var(--affordance-ghost-hover);
  }
  .presets {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .presets button {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 36px;
    padding: 6px 10px;
    border: 0;
    border-radius: 12px;
    background: transparent;
    color: var(--text-standard);
    font: var(--text-body-sm);
    text-align: left;
  }
  .presets button:hover,
  .presets button:focus-visible {
    background: var(--affordance-ghost-hover);
  }
  .preset-emoji {
    font-size: 18px;
  }
  .hint {
    margin-left: auto;
    color: var(--text-metadata);
    font: var(--text-caption);
  }
  .spacer {
    flex: 1;
  }
</style>
