<script lang="ts">
  import { onMount, tick } from "svelte";
  import { attach, type AgentSummary, type Attached, type Room } from "$lib/api";
  import { holdReload, releaseReload } from "$lib/api/reload";
  import { emojiOf, searchEmoji } from "$lib/api/shared/emoji";
  import AvatarStack from "$lib/ui/AvatarStack.svelte";
  import Checkbox from "$lib/ui/Checkbox.svelte";
  import FileCard, { fileSize } from "$lib/ui/FileCard.svelte";
  import IconButton from "$lib/ui/IconButton.svelte";
  import Picker from "$lib/ui/Picker.svelte";
  import Popover from "$lib/ui/Popover.svelte";
  import { toast } from "$lib/ui/toast.svelte";
  import type { PickerItem } from "$lib/ui/types";
  import { insertChip, insertPlainText, insertQueryText, insertTextAt, readDraft, textBeforeCaret, type ChipTarget } from "./composer-dom";
  import EmojiPicker from "./EmojiPicker.svelte";
  import { frequentEmoji } from "./frequent-emoji.svelte";
  import { closedEmojiName, matchCandidates, openQuery, parseCommand, type Query, type SlashCommand } from "./typeahead";
  import type { Outgoing } from "./present";
  import { composing } from "$lib/ui/keyboard";
  import { activeFormats, applyFormat, fillDraft, formatForKey, inCodeBlock, insertLink, linkAtSelection, listBreak, pasteLink, STRUCTURE, type Format } from "./composer-format";
  import FormatBar from "./FormatBar.svelte";
  import LinkDialog from "./LinkDialog.svelte";
  import { drafts } from "$lib/drafts.svelte";

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
    /** The draft's key in lib/drafts, from roomDraftKey or threadDraftKey. */
    draftKey?: string;
    autofocus?: boolean;
    compact?: boolean;
    /** A channel thread's composer: the label of Slack's "Also send to #channel" box, whose check sends the reply to the channel too. */
    alsoSend?: string | null;
    /** Takes the message and returns at once; the page shows it as sending. A rejection puts the text back in an empty box. */
    onsend: (out: Outgoing) => Promise<void>;
    onstop?: () => void;
    /** What `/` lists here; a draft that names one runs it instead of posting. With none, `/` opens nothing and such a draft posts. */
    commands?: SlashCommand[];
  };
  let { placeholder, agents, channels, room = null, working = false, draftKey, autofocus = false, compact = false, alsoSend = null, onsend, onstop, commands = [] }: Props = $props();

  /** An attached image or other file, whose upload starts as it is attached (`attach`). */
  type Attachment = { file: File; image: Attached };
  let box = $state<HTMLDivElement>();
  let empty = $state(true);
  /** A list, quote or code block with no text yet still hides the placeholder. */
  let structured = $state(false);
  let formats = $state<ReadonlySet<Format>>(new Set());
  /** The Add link dialog, with the selection it puts the link in. */
  let link = $state<{ text: string; url: string; range: Range } | null>(null);
  let mentions = $state<string[]>([]);
  let attachments = $state<Attachment[]>([]);
  // An attached image not sent yet lives only in this page, so it holds the reload a new release asks for (lib/api/reload.ts).
  const reloadHold = `composer:${crypto.randomUUID()}`;
  $effect(() => {
    if (attachments.length) holdReload(reloadHold);
    else releaseReload(reloadHold);
  });
  $effect(() => () => releaseReload(reloadHold));
  let query = $state<Query | null>(null);
  const MAX_UPLOAD = 40 * 1024 * 1024;
  let dragging = $state(false);
  /** The "Also send to #channel" box, cleared after each send as Slack clears it. */
  let alsoChecked = $state(false);
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
  const matches = $derived(query?.trigger === "@" || query?.trigger === "#" ? matchCandidates(query.trigger === "@" ? agentCandidates : channelCandidates, query.text, 8) : []);
  /** The name Slack shows for an emoji row: the one the typed letters match, so :thu reads :thumbsup: and not :+1:. */
  const shownName = (names: readonly string[], typed: string): string => {
    const q = typed.toLowerCase();
    return names.find((n) => n.startsWith(q)) ?? names.find((n) => n.includes(q)) ?? names[0] ?? "";
  };
  const commandMatches = $derived(query?.trigger === "/" ? commands.filter((c) => c.name.startsWith(query!.text.toLowerCase())) : []);
  const pickerItems = $derived<PickerItem[]>(
    query?.trigger === ":"
      ? searchEmoji(query.text, 8).map((e) => ({ id: e.char, label: `:${shownName(e.names, query!.text)}:`, glyph: e.char }))
      : query?.trigger === "/"
        ? commandMatches.map((c) => ({ id: c.name, label: `/${c.name}`, detail: c.description, ...(c.args ? { trailing: c.args } : {}) }))
        : matches.map((m) => ({
            id: m.id,
            label: m.name,
            trailing: m.kind,
            ...(m.detail ? { detail: m.detail } : {}),
            ...(m.kind === "channel" ? { icon: "hash" } : { avatar: { name: m.name, kind: "agent" as const, seed: m.id } }),
          })),
  );
  const pickerLabel = $derived(({ "@": "Agents", "#": "Channels", ":": "Emoji", "/": "Commands" } as const)[query?.trigger ?? "@"]);
  let pickerOpen = $state(false);
  $effect(() => {
    pickerOpen = !!query && pickerItems.length > 0;
  });
  /** The caret's last place in the box, so the emoji button inserts there while focus sits in the picker's search field. */
  let lastRange: Range | null = null;
  let emojiOpen = $state(false);
  let emojiButton = $state<HTMLButtonElement>();

  onMount(() => {
    if (!box) return;
    const saved = draftKey ? drafts.take(draftKey) : null;
    if (saved) {
      fillDraft(box, saved);
      sync();
    }
    // After the first frame, so the focus and its caret do not force a style and layout pass in the middle of the page's mount: on 11-03
    // that pass cost 39 to 56 ms of each thread open in the box Chrome at 6x CPU throttle.
    if (autofocus) requestAnimationFrame(() => box?.isConnected && focusEnd());
    const onSelection = () => {
      if (document.activeElement !== box) return;
      const selection = document.getSelection();
      if (selection?.rangeCount && box?.contains(selection.getRangeAt(0).startContainer)) lastRange = selection.getRangeAt(0).cloneRange();
      updateQuery();
      formats = activeFormats(box!);
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
    structured = !!box.querySelector(STRUCTURE);
    if (empty && box.hasChildNodes() && !box.querySelector("[data-chip-id]") && !structured) box.replaceChildren();
    mentions = draft.mentions;
    if (draftKey) drafts.write(draftKey, empty ? "" : draft.text);
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
    if (!box || !query) return;
    if (query.trigger === ":") {
      insertQueryText(box, query.text.length, `${id}\u00a0`);
      frequentEmoji.use(id);
    } else if (query.trigger === "/") {
      insertQueryText(box, query.text.length, `/${id}\u00a0`);
    } else {
      const hit = matches.find((m) => m.id === id);
      if (!hit) return;
      insertChip(box, query.text.length, hit.target);
    }
    query = null;
    sync();
  }

  /** Slack turns a whole `:name:` into its emoji as the closing colon is typed. */
  function oninput(e: Event) {
    if (box && e instanceof InputEvent && e.inputType === "insertText" && e.data === ":") {
      const before = textBeforeCaret(box)?.text ?? "";
      const name = closedEmojiName(before, before.length);
      const emoji = name ? emojiOf(name) : undefined;
      if (name && emoji) {
        insertQueryText(box, name.length + 1, emoji.char);
        frequentEmoji.use(emoji.char);
      }
    }
    sync();
  }

  function caretBack() {
    if (!box) return;
    box.focus();
    const selection = document.getSelection();
    if (lastRange && box.contains(lastRange.startContainer)) {
      selection?.removeAllRanges();
      selection?.addRange(lastRange);
    } else focusEnd();
  }

  /** A Shift pick keeps the picker open for the next emoji, as Slack's does. */
  function pickEmoji(emoji: string, keepOpen: boolean) {
    if (!box) return;
    lastRange = insertTextAt(box, lastRange, emoji);
    frequentEmoji.use(emoji);
    sync();
    if (keepOpen) return;
    emojiOpen = false;
    caretBack();
  }

  function format(kind: Format) {
    if (!box) return;
    if (document.activeElement !== box) caretBack();
    if (kind === "link") {
      if (document.getSelection()?.rangeCount) link = { ...linkAtSelection(box), range: document.getSelection()!.getRangeAt(0).cloneRange() };
      return;
    }
    applyFormat(box, kind);
    sync();
    formats = activeFormats(box);
  }

  /** Runs after the dialog has closed, since the page behind an open modal dialog takes no focus or edit. */
  async function saveLink(text: string, url: string) {
    if (!box || !link) return;
    lastRange = link.range;
    link = null;
    await tick();
    caretBack();
    insertLink(box, text, url);
    sync();
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.defaultPrevented) return;
    const kind = formatForKey(e);
    if (kind) {
      e.preventDefault();
      format(kind);
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !composing(e)) {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === "Enter" && !composing(e) && box && (e.shiftKey ? listBreak(box) : !query && inCodeBlock(box) && document.execCommand("insertLineBreak"))) {
      e.preventDefault();
      sync();
      return;
    }
    if (e.key === "Escape" && query) {
      e.preventDefault();
      dismiss();
      return;
    }
    // Slack's Up arrow in an empty box edits the owner's last post here (MessageRow listens).
    if (e.key === "ArrowUp" && !e.altKey && !hasContent && !query && box) {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent("chat:edit-last", { detail: box }));
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !composing(e)) {
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
      // The chat server refuses a request body over 40 MB (MAX_BODY in server/http.ts), so a bigger file is refused here before its upload.
      if (file.size > MAX_UPLOAD) {
        toast.error(`${file.name} is ${fileSize(file.size)}; a file can be up to 40 MB.`);
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
    const files = [...e.clipboardData.files];
    if (files.length) addFiles(files);
    // A file copied in Finder pastes its name as text too; an image copied from a page or app keeps its text, as before.
    const text = files.some((f) => !f.type.startsWith("image/")) ? "" : e.clipboardData.getData("text/plain");
    if (text && !pasteLink(box, text)) insertPlainText(box, text);
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
    const command = commands.length && !attachments.length ? parseCommand(draft.text) : null;
    if (command) {
      runCommand(command, draft);
      return;
    }
    const images: Outgoing["images"] = attachments.map((a) => a.image);
    const alsoInChannel = !!alsoSend && alsoChecked;
    box.replaceChildren();
    attachments = [];
    alsoChecked = false;
    sync();
    onsend({ text: draft.text, mentions: draft.mentions, images, ...(alsoInChannel ? { alsoInChannel } : {}) }).catch((error: unknown) => {
      if (box && !readDraft(box).text) {
        fillDraft(box, draft.text);
        alsoChecked = alsoInChannel;
        sync();
      }
      toast.error(error instanceof Error ? error.message : "Could not send the message");
    });
  }

  function runCommand(command: { name: string; args: string }, draft: { text: string; mentions: string[] }) {
    const known = commands.find((c) => c.name === command.name);
    if (!known) {
      toast.error(`/${command.name} is not a command here. Type / to see the list.`);
      return;
    }
    box?.replaceChildren();
    sync();
    void Promise.resolve()
      .then(() => known.run({ args: command.args, mentions: draft.mentions }))
      .catch((error: unknown) => {
        if (box && !readDraft(box).text) {
          box.textContent = draft.text;
          sync();
        }
        toast.error(error instanceof Error ? error.message : `/${command.name} did not work`);
      });
  }

  function mentionButton() {
    if (!box) return;
    if (document.activeElement !== box) caretBack();
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
  <FormatBar active={formats} onformat={format} />
  <div
    bind:this={box}
    class="input"
    class:empty={empty && !structured}
    contenteditable="true"
    role="textbox"
    tabindex="0"
    aria-multiline="true"
    aria-label={placeholder}
    data-placeholder={placeholder}
    data-testid="composer-input"
    {oninput}
    onblur={() => (query = null)}
    {onkeydown}
    {onpaste}
  ></div>
  {#if attachments.length}
    <div class="attachments">
      {#each attachments as a, index (a.image.preview)}
        {#if a.image.mimeType.startsWith("image/")}
          <div class="thumb">
            <img src={a.image.preview} alt={a.file.name} />
            <span class="remove"><IconButton icon="close" label="Remove {a.file.name}" size="xs" variant="glass" onclick={() => removeAttachment(index)} /></span>
          </div>
        {:else}
          <FileCard name={a.file.name} mimeType={a.image.mimeType} size={a.file.size} onremove={() => removeAttachment(index)} />
        {/if}
      {/each}
    </div>
  {/if}
  <div class="tools">
    {#if recipients.length}
      <span class="recipients" title="Sends to {recipients.map((r) => r.name).join(', ')}">
        <AvatarStack members={recipients.map((r) => ({ id: r.id, name: r.name, kind: "agent" }))} size={28} max={4} />
      </span>
    {/if}
    <IconButton icon="smile" label="Emoji" size="sm" bind:element={emojiButton} pressed={emojiOpen} onclick={() => (emojiOpen = !emojiOpen)} data-testid="composer-emoji" />
    <IconButton icon="at" label="Mention an agent" size="sm" onclick={mentionButton} />
    <IconButton icon="paperclip" label="Attach files" size="sm" onclick={() => fileInput?.click()} />
    <input bind:this={fileInput} type="file" multiple hidden onchange={(e) => {
      const input = e.currentTarget as HTMLInputElement;
      if (input.files) addFiles(input.files);
      input.value = "";
    }} />
    {#if alsoSend}<span class="also-send"><Checkbox bind:checked={alsoChecked} label={alsoSend} data-testid="also-send" /></span>{/if}
    <span class="spacer"></span>
    {#if working && onstop}
      <IconButton icon="stop" label="Stop" size="md" variant="outline" onclick={onstop} data-testid="stop" />
    {/if}
    <IconButton icon="arrow-up" label="Send" size="md" variant={hasContent ? "accent" : "ghost"} disabled={!hasContent} onclick={submit} data-testid="send" />
  </div>
</div>

{#if link}
  <LinkDialog open text={link.text} url={link.url} onsave={saveLink} onclose={() => ((link = null), caretBack())} />
{/if}

<Picker
  bind:open={pickerOpen}
  anchor={box}
  items={pickerItems}
  placement="top-start"
  width={340}
  label={pickerLabel}
  typeahead={box && query ? { query: "", keys: box } : undefined}
  onselect={(id) => pick(id)}
  onclose={dismiss}
/>

<Popover
  bind:open={emojiOpen}
  anchor={emojiButton}
  placement="top-start"
  label="Emoji"
  padding={0}
  radius="row"
  onclose={() => requestAnimationFrame(() => {
    if (!document.activeElement || document.activeElement === document.body || document.activeElement === emojiButton) caretBack();
  })}
>
  <EmojiPicker onpick={pickEmoji} />
</Popover>

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
  /* The formats as a post draws them (lib/ui/prose.css), so the box shows what the post will. */
  .input :global(:is(b, strong)) {
    font-weight: 600;
  }
  .input :global(a) {
    color: var(--text-message-link);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .input :global(code) {
    padding: 1px 5px;
    border-radius: 6px;
    background: color-mix(in srgb, currentColor 8%, transparent);
    font: var(--text-mono);
    font-size: 0.9em;
  }
  .input :global(pre) {
    margin: 4px 0;
    padding: 8px 10px;
    border: 1px solid var(--border-standard);
    border-radius: 8px;
    background: var(--surface-inset);
    font: var(--text-mono);
    white-space: pre-wrap;
  }
  .input :global(blockquote) {
    margin: 4px 0;
    padding-left: 12px;
    border-left: 2px solid var(--border-message-thread);
    color: var(--text-subtle);
  }
  .input :global(:is(ul, ol)) {
    margin: 4px 0;
    padding-left: 22px;
  }
  .input :global(ul) {
    list-style-type: disc;
  }
  .input :global(ol) {
    list-style-type: decimal;
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
  .also-send {
    display: flex;
    min-width: 0;
    margin-left: 8px;
    color: var(--text-metadata);
  }
  .also-send :global(.checkbox) {
    min-width: 0;
  }
  .also-send :global(.label) {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
