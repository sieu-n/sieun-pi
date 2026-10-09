<script module lang="ts">
  import { api } from "./api.ts";
  import type { Command, SendMode } from "../shared/types.ts";
  import { drafts, type DraftAttachment } from "./drafts.ts";
  export type Attachment = DraftAttachment;
  const commandCache = new Map<string, Promise<Command[]>>();
  const NEW_CHAT = "";
  const BUSY_MODE_KEY = "chat.busySendMode";
  let attachmentId = 0;

  function storedBusyMode(): SendMode {
    try { return localStorage.getItem(BUSY_MODE_KEY) === "followUp" ? "followUp" : "steer"; } catch { return "steer"; }
  }

  function loadCommands(threadId: string | null): Promise<Command[]> {
    const key = threadId ?? NEW_CHAT;
    let pending = commandCache.get(key);
    if (!pending) {
      pending = api.commands(threadId).catch(() => { commandCache.delete(key); return []; });
      commandCache.set(key, pending);
    }
    return pending;
  }

  function readBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error("Could not read " + file.name));
      reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
      reader.readAsDataURL(file);
    });
  }
</script>

<script lang="ts">
  import { tick, untrack, type Snippet } from "svelte";
  import { store } from "./store.svelte.ts";
  import { bytes } from "./format.ts";
  import { insertSlashCommand, matchCommands, slashTokenAt } from "./command-match.ts";
  import { IMAGE_MIME_TYPES, MAX_CHAT_IMAGES, MAX_CHAT_IMAGE_BYTES, MAX_CHAT_TOTAL_IMAGE_BYTES, MAX_MESSAGE_LENGTH } from "../shared/limits.ts";
  import type { ImageInput } from "../shared/types.ts";
  import Icon from "./Icon.svelte";
  import Floating from "./ui/Floating.svelte";
  import Lightbox from "./ui/Lightbox.svelte";
  import { tooltip } from "./ui/tooltip.ts";

  let { draftKey, threadId = null, busy = false, placeholder = "Message Prime Agent", acceptsImages = true, focusOnMount = false, send, stop, left, right }: {
    draftKey: string; threadId?: string | null; busy?: boolean; placeholder?: string; acceptsImages?: boolean; focusOnMount?: boolean;
    send: (text: string, images: ImageInput[], mode: SendMode) => Promise<boolean>; stop?: () => void;
    left?: Snippet; right?: Snippet;
  } = $props();

  const restored = drafts.get(untrack(() => draftKey));
  let text = $state(restored?.text ?? "");
  let images = $state<Attachment[]>(restored?.images ?? []);
  let sending = $state(false);
  let busyMode = $state<SendMode>(storedBusyMode());
  let modeOpen = $state(false);
  let modeButton: HTMLButtonElement | undefined = $state();
  let dragging = $state(false);
  let menuDismissed = $state(false);
  let menuIndex = $state(0);
  let commands = $state<Command[]>([]);
  let textarea: HTMLTextAreaElement | undefined = $state();
  let caret = $state(0);
  let lightbox = $state<number | null>(null);

  $effect(() => { drafts.set(draftKey, { text, images, quote: null }); });
  $effect(() => {
    void text;
    const node = textarea;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = Math.min(node.scrollHeight, window.innerHeight * 0.4) + "px";
  });
  $effect(() => { if (focusOnMount) textarea?.focus(); });
  $effect(() => { if (!busy) modeOpen = false; });

  const slashToken = $derived(slashTokenAt(text, caret));
  $effect(() => {
    const id = threadId;
    if (slashToken === null) return;
    let cancelled = false;
    void loadCommands(id).then(list => { if (!cancelled) commands = list; });
    return () => { cancelled = true; };
  });
  const filtered = $derived(slashToken === null ? [] : matchCommands(commands, slashToken.query));
  const menuOpen = $derived(!menuDismissed && filtered.length > 0);
  $effect(() => { void filtered; menuIndex = 0; });
  let menu: HTMLElement | undefined = $state();
  $effect(() => { menu?.children[menuIndex]?.scrollIntoView({ block: "nearest" }); });

  const canSend = $derived((text.trim().length > 0 || images.length > 0) && !sending && text.length <= MAX_MESSAGE_LENGTH);
  const totalBytes = $derived(images.reduce((sum, image) => sum + image.size, 0));

  function insertCommand(command: Command): void {
    if (!slashToken) return;
    const next = insertSlashCommand(text, slashToken, command.name);
    text = next.text;
    caret = next.caret;
    menuDismissed = true;
    void tick().then(() => { textarea?.focus(); textarea?.setSelectionRange(next.caret, next.caret); });
  }

  function syncCaret(): void { caret = textarea?.selectionStart ?? text.length; }
  function onInput(): void { menuDismissed = false; syncCaret(); }

  function onKeydown(event: KeyboardEvent): void {
    if (event.isComposing || event.keyCode === 229) return;
    if (menuOpen) {
      if (event.key === "ArrowDown") { event.preventDefault(); menuIndex = (menuIndex + 1) % filtered.length; return; }
      if (event.key === "ArrowUp") { event.preventDefault(); menuIndex = (menuIndex - 1 + filtered.length) % filtered.length; return; }
      if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); insertCommand(filtered[menuIndex] ?? filtered[0]!); return; }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); menuDismissed = true; return; }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      const other: SendMode = busyMode === "steer" ? "followUp" : "steer";
      void submit(busy ? (event.metaKey || event.ctrlKey ? other : busyMode) : "followUp");
    }
  }

  async function submit(mode: SendMode): Promise<void> {
    if (!canSend) return;
    sending = true;
    const payload: ImageInput[] = images.map(image => ({ type: "image", mimeType: image.mimeType, data: image.data }));
    const ok = await send(text.trim(), payload, mode);
    sending = false;
    if (!ok) return;
    for (const image of images) URL.revokeObjectURL(image.url);
    drafts.delete(draftKey);
    text = "";
    caret = 0;
    images = [];
    menuDismissed = false;
    await tick();
    textarea?.focus();
  }

  async function addFiles(files: Iterable<File>): Promise<void> {
    for (const file of files) {
      if (!(IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) { store.toast(`${file.name || "This file"} is not a PNG, JPEG, GIF or WebP image.`); continue; }
      if (images.length >= MAX_CHAT_IMAGES) { store.toast(`Up to ${MAX_CHAT_IMAGES} images per message.`); break; }
      if (file.size > MAX_CHAT_IMAGE_BYTES) { store.toast(`${file.name || "This image"} is ${bytes(file.size)}. The limit is ${bytes(MAX_CHAT_IMAGE_BYTES)} per image.`); continue; }
      if (totalBytes + file.size > MAX_CHAT_TOTAL_IMAGE_BYTES) { store.toast(`Images add up to more than ${bytes(MAX_CHAT_TOTAL_IMAGE_BYTES)}.`); continue; }
      try {
        const data = await readBase64(file);
        images = [...images, { id: ++attachmentId, name: file.name || "image", mimeType: file.type, size: file.size, data, url: URL.createObjectURL(file) }];
      } catch (error) { store.toast(error instanceof Error ? error.message : String(error)); }
    }
  }

  function removeImage(id: number): void {
    const image = images.find(entry => entry.id === id);
    if (image) URL.revokeObjectURL(image.url);
    images = images.filter(entry => entry.id !== id);
  }

  function onPaste(event: ClipboardEvent): void {
    const files = [...(event.clipboardData?.files ?? [])].filter(file => file.type.startsWith("image/"));
    if (!files.length || !acceptsImages) return;
    event.preventDefault();
    void addFiles(files);
  }
  function onDrop(event: DragEvent): void {
    event.preventDefault();
    dragging = false;
    if (!acceptsImages) return;
    void addFiles([...(event.dataTransfer?.files ?? [])]);
  }
  function chooseMode(mode: SendMode): void {
    busyMode = mode;
    modeOpen = false;
    try { localStorage.setItem(BUSY_MODE_KEY, mode); } catch { /* private mode keeps it for this tab */ }
    textarea?.focus();
  }
  const MODES: readonly { mode: SendMode; label: string; detail: string }[] = [
    { mode: "steer", label: "Steer", detail: "Interrupts the current step" },
    { mode: "followUp", label: "Queue", detail: "Sends after the agent finishes" },
  ];</script>

<div class="composer" class:dragging class:busy role="group" aria-label="Composer"
  ondragover={event => { event.preventDefault(); dragging = true; }} ondragleave={() => { dragging = false; }} ondrop={onDrop}>
  {#if images.length}
    <div class="thumbs">
      {#each images as image, index (image.id)}
        <div class="thumb fade-in">
          <button type="button" class="view" aria-label="View {image.name}" onclick={() => { lightbox = index; }}><img src={image.url} alt={image.name} /></button>
          <button type="button" class="remove" aria-label="Remove {image.name}" onclick={() => removeImage(image.id)}><Icon name="x" size={12} /></button>
        </div>
      {/each}
    </div>
  {/if}
  {#if menuOpen}
    <div class="slash-menu panel-surface fade-in" role="listbox" aria-label="Commands" bind:this={menu}>
      {#each filtered as command, index (command.name)}
        <button class="menu-item" class:selected={index === menuIndex} role="option" aria-selected={index === menuIndex}
          onmouseenter={() => { menuIndex = index; }} onclick={() => insertCommand(command)}>
          <span class="command-name">/{command.name}{#if command.argumentHint}<span class="faint"> {command.argumentHint}</span>{/if}</span>
          {#if command.description}<span class="command-description">{command.description}</span>{/if}
          <span class="hint">{command.source}</span>
        </button>
      {/each}
    </div>
  {/if}
  <textarea data-composer bind:this={textarea} bind:value={text} {placeholder} rows="1" aria-label={placeholder}
    oninput={onInput} onkeydown={onKeydown} onkeyup={syncCaret} onclick={syncCaret} onpaste={onPaste}></textarea>
  <div class="bar">
    {#if left}<div class="slot left">{@render left()}</div>{/if}
    <span class="spacer"></span>
    {#if right}<div class="slot right">{@render right()}</div>{/if}
    {#if busy}
      <button type="button" class="round stop" aria-label="Stop" use:tooltip={"Stop (Esc)"} onclick={() => stop?.()}><Icon name="stop" size={14} /></button>
    {/if}
    <div class="split" class:ready={canSend} class:busy>
      <button type="button" class="send" aria-label={busy ? (busyMode === "steer" ? "Steer" : "Queue") : "Send"} use:tooltip={busy ? (busyMode === "steer" ? "Steer" : "Queue") : "Send"}
        disabled={!canSend} onclick={() => void submit(busy ? busyMode : "followUp")}>
        {#if sending}<span class="spinner tiny"></span>{:else}<Icon name={busy && busyMode === "steer" ? "steer" : "send"} size={16} />{/if}
      </button>
      {#if busy}
        <button type="button" class="mode" bind:this={modeButton} aria-label="While the agent works: {busyMode === 'steer' ? 'Steer' : 'Queue'}" aria-haspopup="menu" aria-expanded={modeOpen}
          use:tooltip={"While the agent works"} onclick={() => { modeOpen = !modeOpen; }}><Icon name="chevronDown" size={12} /></button>
      {/if}
    </div>
  </div>
  {#if busy && modeOpen && modeButton}
    <Floating anchor={modeButton} width={272} align="end" role="menu" label="While the agent works" onclose={() => { modeOpen = false; }}>
      <div class="menu-heading">While the agent works</div>
      {#each MODES as entry, index (entry.mode)}
        <button type="button" class="menu-item mode-item" role="menuitemradio" aria-checked={busyMode === entry.mode} data-autofocus={busyMode === entry.mode ? true : undefined}
          onkeydown={event => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); ((event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLElement>(".mode-item")[1 - index])?.focus(); } }}
          onclick={() => chooseMode(entry.mode)}>
          <span class="mode-check">{#if busyMode === entry.mode}<Icon name="check" size={13} />{/if}</span>
          <span class="mode-text"><span class="mode-label">{entry.label}</span><span class="mode-detail">{entry.detail}</span></span>
          <span class="hint">{busyMode === entry.mode ? "Enter" : "⌘Enter"}</span>
        </button>
      {/each}
    </Floating>
  {/if}
  {#if lightbox !== null}
    <Lightbox images={images.map(image => ({ src: image.url, alt: image.name }))} index={lightbox} onclose={() => { lightbox = null; }} />
  {/if}
  {#if text.length > MAX_MESSAGE_LENGTH}
    <div class="hint-line danger">Message is {text.length.toLocaleString()} characters. The limit is {MAX_MESSAGE_LENGTH.toLocaleString()}.</div>
  {/if}
</div>

<style>
  .composer { position: relative; border: 1px solid var(--border-strong); border-radius: 14px; background: var(--bg-elevated); box-shadow: var(--shadow-small); transition: border-color 0.15s ease, box-shadow 0.15s ease; }
  .composer:focus-within { border-color: color-mix(in srgb, var(--accent) 45%, var(--border-strong)); box-shadow: 0 0 0 3px var(--accent-soft), var(--shadow-small); }
  .composer.dragging { border-color: var(--accent); background: var(--accent-soft); }
  textarea { display: block; width: 100%; resize: none; border: 0; background: none; outline: none; padding: 13px 16px 4px; line-height: 1.5; max-height: 40vh; font-size: 15px; }
  textarea::placeholder { color: var(--text-faint); }
  .bar { display: flex; align-items: center; gap: 4px; padding: 4px 8px 8px; min-width: 0; }
  .slot { display: flex; align-items: center; gap: 2px; min-width: 0; }
  .slot.right { flex: none; }
  .spacer { flex: 1; min-width: 4px; }
  .round { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 30px; height: 30px; border-radius: 8px; }
  .stop { background: var(--text); color: var(--bg); margin-right: 2px; }
  .stop:hover { opacity: 0.88; }
  .split { display: inline-flex; flex: none; height: 30px; border-radius: 8px; border: 1px solid transparent; background: var(--bg-active); color: var(--text-faint); transition: background-color 0.12s, color 0.12s; }
  .split.ready { background: var(--primary); color: var(--primary-text); border-color: var(--primary-edge); }
  .split > button { display: inline-flex; align-items: center; justify-content: center; height: 100%; color: inherit; }
  .send { width: 32px; border-radius: 7px; }
  .split.busy .send { border-radius: 7px 0 0 7px; }
  .send:disabled { opacity: 1; }
  .mode { width: 20px; border-radius: 0 7px 7px 0; border-left: 1px solid color-mix(in srgb, currentColor 22%, transparent); }
  .split.ready > button:hover:not(:disabled) { background: var(--primary-hover); }
  .split:not(.ready) .mode:hover { color: var(--text); }
  .mode-item { align-items: flex-start; }
  .mode-check { display: inline-flex; width: 14px; flex: none; padding-top: 2px; color: var(--accent-bold); }
  .mode-text { display: flex; flex-direction: column; min-width: 0; }
  .mode-label { font-weight: 500; }
  .mode-detail { font-size: 11.5px; color: var(--text-muted); }
  .mode-item .hint { padding-top: 2px; }
  .thumbs { display: flex; gap: 8px; padding: 10px 12px 0; flex-wrap: wrap; }
  .thumb { position: relative; width: 64px; height: 64px; border-radius: var(--radius-small); overflow: hidden; border: 1px solid var(--border); }
  .view { display: block; width: 100%; height: 100%; cursor: zoom-in; }
  .view img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .remove { position: absolute; top: 3px; right: 3px; width: 18px; height: 18px; border-radius: 50%; background: rgba(0, 0, 0, 0.6); color: #fff; display: inline-flex; align-items: center; justify-content: center; }
  .slash-menu { position: absolute; left: 8px; right: 8px; bottom: calc(100% + 6px); z-index: 20; padding: 4px; max-height: 320px; overflow: auto; }
  .command-name { font-family: var(--mono); font-size: 12.5px; white-space: nowrap; }
  .command-description { color: var(--text-muted); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .hint-line { padding: 0 14px 8px; font-size: 12px; color: var(--text-faint); }
  .hint-line.danger { color: var(--danger); }
</style>
