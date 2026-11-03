<script lang="ts">
  import { onMount } from "svelte";
  import { attach, type AgentSummary, type Attached, type Room } from "$lib/api";
  import AvatarStack from "$lib/ui/AvatarStack.svelte";
  import IconButton from "$lib/ui/IconButton.svelte";
  import Picker from "$lib/ui/Picker.svelte";
  import { toast } from "$lib/ui/toast.svelte";
  import type { PickerItem } from "$lib/ui/types";
  import { insertChip, insertPlainText, readDraft, textBeforeCaret, type ChipTarget } from "./composer-dom";
  import { matchCandidates, openQuery, type Query } from "./typeahead";
  import type { Outgoing } from "./present";

  type Props = {
    placeholder: string;
    /** Registered agents, the only rows the @ picker lists. */
    agents: AgentSummary[];
    /** Channels, the only rows the # picker lists. */
    channels: Room[];
    /** The channel or Solo room this box posts into: its members lead the @ picker, and an agent outside it reads "not in <label>". */
    room?: { label: string; members: string[] } | null;
    /** The agent works now: Stop shows beside Send. */
    working?: boolean;
    /** localStorage key for the draft, one per conversation. */
    draftKey?: string;
    autofocus?: boolean;
    compact?: boolean;
    /** Takes the message and returns at once; the page shows it as sending. A rejection puts the text back in an empty box. */
    onsend: (out: Outgoing) => Promise<void>;
    onstop?: () => void;
  };
  let { placeholder, agents, channels, room = null, working = false, draftKey, autofocus = false, compact = false, onsend, onstop }: Props = $props();

  /** An attached image, whose upload starts as it is attached (`attach`). */
  type Attachment = { file: File; image: Attached };
  let box = $state<HTMLDivElement>();
  let empty = $state(true);
  let mentions = $state<string[]>([]);
  let attachments = $state<Attachment[]>([]);
  let query = $state<Query | null>(null);
  let dragging = $state(false);
  let fileInput = $state<HTMLInputElement>();
  /** Where the query Escape closed starts, so it stays closed while that query goes on and a new @ opens the card again. */
  let dismissedAt: number | null = null;

  const hasContent = $derived(!empty || attachments.length > 0);
  const recipients = $derived(mentions.map((id) => agents.find((a) => a.id === id)).filter((a): a is AgentSummary => !!a));

  type Candidate = { id: string; name: string; kind: string; detail: string; target: ChipTarget };
  const agentCandidates = $derived<Candidate[]>(
    agents
      .filter((a) => !a.archived)
      .map((a) => ({ a, outside: !!room && !room.members.includes(a.id) }))
      .sort((x, y) => Number(x.outside) - Number(y.outside))
      .map(({ a, outside }) => ({
        id: a.id, name: a.name, kind: "agent",
        detail: outside ? `not in ${room!.label}` : a.status === "working" ? "working now" : "",
        target: { id: a.id, name: a.name, kind: "agent" },
      })),
  );
  const channelCandidates = $derived<Candidate[]>(
    channels.filter((c) => !c.archived).map((c) => ({ id: c.id, name: c.name, kind: "channel", detail: c.agenda || `${c.members.length} members`, target: { id: c.id, name: c.name, kind: "channel" } })),
  );
  const matches = $derived(query ? matchCandidates(query.trigger === "@" ? agentCandidates : channelCandidates, query.text, 8) : []);
  const pickerItems = $derived<PickerItem[]>(
    matches.map((m) => ({
      id: m.id,
      label: m.name,
      trailing: m.kind,
      ...(m.detail ? { detail: m.detail } : {}),
      ...(m.kind === "channel" ? { icon: "hash" } : { avatar: { name: m.name, kind: "agent" as const, seed: m.id } }),
    })),
  );
  let pickerOpen = $state(false);
  $effect(() => {
    pickerOpen = !!query && matches.length > 0;
  });

  onMount(() => {
    if (!box) return;
    const saved = draftKey ? localStorage.getItem(`chat.draft.${draftKey}`) : null;
    if (saved) {
      box.textContent = saved;
      sync();
    }
    if (autofocus) focusEnd();
    const onSelection = () => {
      if (document.activeElement === box) updateQuery();
    };
    document.addEventListener("selectionchange", onSelection);
    return () => document.removeEventListener("selectionchange", onSelection);
  });

  export function focus() {
    focusEnd();
  }

  function focusEnd() {
    if (!box) return;
    box.focus();
    const range = document.createRange();
    range.selectNodeContents(box);
    range.collapse(false);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  function sync() {
    if (!box) return;
    const draft = readDraft(box);
    empty = draft.text.trim() === "";
    if (empty && box.innerHTML !== "" && !box.querySelector("[data-chip-id]")) box.innerHTML = "";
    mentions = draft.mentions;
    if (draftKey) {
      if (empty) localStorage.removeItem(`chat.draft.${draftKey}`);
      else localStorage.setItem(`chat.draft.${draftKey}`, draft.text);
    }
    updateQuery();
  }

  function updateQuery() {
    if (!box || document.activeElement !== box) {
      query = null;
      return;
    }
    const before = textBeforeCaret(box);
    const next = before ? openQuery(before.text, before.text.length) : null;
    if (next?.start !== dismissedAt) dismissedAt = null;
    query = next && next.start !== dismissedAt ? next : null;
  }

  function dismiss() {
    if (query) dismissedAt = query.start;
    query = null;
  }

  function pick(id: string) {
    const hit = matches.find((m) => m.id === id);
    if (!box || !hit || !query) return;
    insertChip(box, query.text.length, hit.target);
    query = null;
    sync();
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.defaultPrevented) return;
    if (e.key === "Escape" && query) {
      dismiss();
      return;
    }
    // Slack's Up arrow in an empty box edits the owner's last post here (MessageRow listens).
    if (e.key === "ArrowUp" && !hasContent && !query && box) {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent("chat:edit-last", { detail: box }));
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    } else if (e.key === "Enter" && e.shiftKey) {
      e.preventDefault();
      document.execCommand("insertLineBreak");
      sync();
    }
  }

  function addFiles(files: Iterable<File>) {
    for (const file of files) {
      if (!file.type.startsWith("image/")) {
        toast.error(`${file.name} is not an image. Only images attach for now.`);
        continue;
      }
      attachments = [...attachments, { file, image: attach(file) }];
    }
  }

  function removeAttachment(index: number) {
    const [gone] = attachments.splice(index, 1);
    if (gone) URL.revokeObjectURL(gone.image.preview);
    attachments = [...attachments];
  }

  function onpaste(e: ClipboardEvent) {
    if (!box || !e.clipboardData) return;
    e.preventDefault();
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
    if (files.length) addFiles(files);
    const text = e.clipboardData.getData("text/plain");
    if (text) insertPlainText(box, text);
    sync();
  }

  function ondrop(e: DragEvent) {
    dragging = false;
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    addFiles(e.dataTransfer.files);
  }

  function submit() {
    if (!box) return;
    const draft = readDraft(box);
    if (!draft.text.trim() && !attachments.length) return;
    const images: Outgoing["images"] = attachments.map((a) => a.image);
    box.innerHTML = "";
    attachments = [];
    sync();
    onsend({ text: draft.text, mentions: draft.mentions, images }).catch((error: unknown) => {
      if (box && !readDraft(box).text) {
        box.textContent = draft.text;
        sync();
      }
      toast.error(error instanceof Error ? error.message : "Could not send the message");
    });
  }

  function mentionButton() {
    if (!box) return;
    if (document.activeElement !== box) focusEnd();
    const before = textBeforeCaret(box)?.text ?? "";
    insertPlainText(box, before && !/\s$/.test(before) ? " @" : "@");
    sync();
  }
</script>

<div
  class="composer"
  class:compact
  class:dragging
  data-testid="composer"
  role="group"
  aria-label="Message composer"
  ondragover={(e) => {
    if (e.dataTransfer?.types.includes("Files")) {
      e.preventDefault();
      dragging = true;
    }
  }}
  ondragleave={() => (dragging = false)}
  {ondrop}
>
  <div
    bind:this={box}
    class="input"
    class:empty
    contenteditable="true"
    role="textbox"
    tabindex="0"
    aria-multiline="true"
    aria-label={placeholder}
    data-placeholder={placeholder}
    data-testid="composer-input"
    oninput={sync}
    onblur={() => (query = null)}
    {onkeydown}
    {onpaste}
  ></div>
  {#if attachments.length}
    <div class="attachments">
      {#each attachments as a, index (a.image.preview)}
        <div class="thumb">
          <img src={a.image.preview} alt={a.file.name} />
          <span class="remove"><IconButton icon="close" label="Remove {a.file.name}" size="xs" variant="glass" onclick={() => removeAttachment(index)} /></span>
        </div>
      {/each}
    </div>
  {/if}
  <div class="tools">
    {#if recipients.length}
      <span class="recipients" title="Sends to {recipients.map((r) => r.name).join(', ')}">
        <AvatarStack members={recipients.map((r) => ({ id: r.id, name: r.name, kind: "agent" }))} size={28} max={4} />
      </span>
    {/if}
    <IconButton icon="at" label="Mention an agent" size="sm" onclick={mentionButton} />
    <IconButton icon="paperclip" label="Attach images" size="sm" onclick={() => fileInput?.click()} />
    <input bind:this={fileInput} type="file" accept="image/*" multiple hidden onchange={(e) => {
      const input = e.currentTarget as HTMLInputElement;
      if (input.files) addFiles(input.files);
      input.value = "";
    }} />
    <span class="spacer"></span>
    {#if working && onstop}
      <IconButton icon="stop" label="Stop" size="md" variant="outline" onclick={onstop} data-testid="stop" />
    {/if}
    <IconButton icon="arrow-up" label="Send" size="md" variant={hasContent ? "accent" : "ghost"} disabled={!hasContent} onclick={submit} data-testid="send" />
  </div>
</div>

<Picker
  bind:open={pickerOpen}
  anchor={box}
  items={pickerItems}
  placement="top-start"
  width={340}
  label={query?.trigger === "#" ? "Channels" : "Agents"}
  typeahead={box && query ? { query: "", keys: box } : undefined}
  onselect={(id) => pick(id)}
  onclose={dismiss}
/>

<style>
  .composer {
    position: relative;
    display: flex;
    flex: none;
    flex-direction: column;
    gap: 16px;
    width: min(calc(100% - 32px), var(--timeline-measure, 52rem));
    margin: 0 auto 16px;
    padding: 12px 6px 6px;
    border: 1px solid var(--border-standard);
    border-radius: calc(var(--radius-icon-button) + 7px);
    background: var(--surface-composer);
    box-shadow: var(--shadow-xs);
    color: var(--text-standard);
    font: var(--text-body);
  }
  .composer.compact {
    width: calc(100% - 24px);
    margin-bottom: 12px;
  }
  .composer:focus-within {
    border-color: var(--border-prominent);
  }
  .composer.dragging {
    border-color: var(--border-focus);
    background: var(--surface-inset);
  }
  .input {
    min-height: 20px;
    max-height: 40vh;
    padding: 0 10px;
    overflow-y: auto;
    outline: none;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .input.empty::before {
    content: attr(data-placeholder);
    position: absolute;
    color: var(--text-metadata);
    pointer-events: none;
  }
  .input :global(.mention) {
    user-select: all;
  }
  .tools {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .recipients {
    display: inline-flex;
    margin: 0 6px 0 2px;
  }
  .spacer {
    flex: 1;
  }
  .attachments {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 0 6px;
  }
  .thumb {
    position: relative;
    width: 64px;
    height: 64px;
    border-radius: 12px;
    overflow: hidden;
    border: 1px solid var(--border-standard);
  }
  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .remove {
    position: absolute;
    top: 2px;
    right: 2px;
  }
</style>
