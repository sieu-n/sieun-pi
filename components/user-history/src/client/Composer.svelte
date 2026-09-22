<script module lang="ts">
  import { api } from "./api.ts";
  import type { Command } from "../shared/types.ts";
  export interface Attachment { id: number; name: string; mimeType: string; size: number; data: string; url: string }
  interface Draft { text: string; images: Attachment[] }
  const drafts = new Map<string, Draft>();
  const commandCache = new Map<string, Promise<Command[]>>();
  let attachmentId = 0;

  function loadCommands(threadId: string): Promise<Command[]> {
    let pending = commandCache.get(threadId);
    if (!pending) {
      pending = api.commands(threadId).catch(() => { commandCache.delete(threadId); return []; });
      commandCache.set(threadId, pending);
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
  import { tick, untrack } from "svelte";
  import { store } from "./store.svelte.ts";
  import { bytes } from "./format.ts";
  import { IMAGE_MIME_TYPES, MAX_CHAT_IMAGES, MAX_CHAT_IMAGE_BYTES, MAX_CHAT_TOTAL_IMAGE_BYTES, MAX_MESSAGE_LENGTH } from "../shared/limits.ts";
  import type { ImageInput, SendMode } from "../shared/types.ts";
  import Icon from "./Icon.svelte";

  let { draftKey, threadId = null, busy = false, placeholder = "Message Prime Agent", acceptsImages = true, focusOnMount = false, send, stop }: {
    draftKey: string; threadId?: string | null; busy?: boolean; placeholder?: string; acceptsImages?: boolean; focusOnMount?: boolean;
    send: (text: string, images: ImageInput[], mode: SendMode) => Promise<boolean>; stop?: () => void;
  } = $props();

  const restored = drafts.get(untrack(() => draftKey));
  let text = $state(restored?.text ?? "");
  let images = $state<Attachment[]>(restored?.images ?? []);
  let sending = $state(false);
  let steer = $state(false);
  let dragging = $state(false);
  let menuDismissed = $state(false);
  let menuIndex = $state(0);
  let commands = $state<Command[]>([]);
  let textarea: HTMLTextAreaElement | undefined = $state();
  let fileInput: HTMLInputElement | undefined = $state();

  $effect(() => { drafts.set(draftKey, { text, images }); });
  $effect(() => {
    void text;
    const node = textarea;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = Math.min(node.scrollHeight, window.innerHeight * 0.4) + "px";
  });
  $effect(() => { if (focusOnMount) textarea?.focus(); });

  const slashQuery = $derived.by(() => {
    if (!threadId) return null;
    const match = /^\/(\S*)$/.exec(text);
    return match ? match[1]!.toLowerCase() : null;
  });
  $effect(() => {
    const id = threadId;
    if (slashQuery === null || !id) return;
    let cancelled = false;
    void loadCommands(id).then(list => { if (!cancelled) commands = list; });
    return () => { cancelled = true; };
  });
  const filtered = $derived(slashQuery === null ? [] : commands.filter(command => command.name.toLowerCase().startsWith(slashQuery)).slice(0, 12));
  const menuOpen = $derived(!menuDismissed && filtered.length > 0);
  $effect(() => { void filtered; menuIndex = 0; });

  const canSend = $derived((text.trim().length > 0 || images.length > 0) && !sending && text.length <= MAX_MESSAGE_LENGTH);
  const totalBytes = $derived(images.reduce((sum, image) => sum + image.size, 0));

  function insertCommand(command: Command): void {
    text = "/" + command.name + " ";
    menuDismissed = true;
    void tick().then(() => { textarea?.focus(); textarea?.setSelectionRange(text.length, text.length); });
  }

  function onInput(): void { menuDismissed = false; }

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
      void submit(busy && (event.metaKey || event.ctrlKey || steer) ? "steer" : "followUp");
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
  function onFilePick(): void {
    if (fileInput?.files) void addFiles([...fileInput.files]);
    if (fileInput) fileInput.value = "";
  }
</script>

<div class="composer" class:dragging class:busy role="group" aria-label="Composer"
  ondragover={event => { event.preventDefault(); dragging = true; }} ondragleave={() => { dragging = false; }} ondrop={onDrop}>
  {#if images.length}
    <div class="thumbs">
      {#each images as image (image.id)}
        <div class="thumb fade-in" title="{image.name} ({bytes(image.size)})">
          <img src={image.url} alt={image.name} />
          <button class="remove" aria-label="Remove {image.name}" onclick={() => removeImage(image.id)}><Icon name="x" size={12} /></button>
        </div>
      {/each}
    </div>
  {/if}
  {#if menuOpen}
    <div class="slash-menu fade-in" role="listbox" aria-label="Commands">
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
  <div class="row">
    {#if acceptsImages}
      <button class="icon-button" aria-label="Attach image" title="Attach image" onclick={() => fileInput?.click()}><Icon name="image" /></button>
      <input bind:this={fileInput} type="file" accept={IMAGE_MIME_TYPES.join(",")} multiple hidden onchange={onFilePick} />
    {/if}
    <textarea data-composer bind:this={textarea} bind:value={text} {placeholder} rows="1" aria-label={placeholder}
      oninput={onInput} onkeydown={onKeydown} onpaste={onPaste}></textarea>
    {#if busy}
      <button class="chip steer-toggle" class:active={steer} aria-pressed={steer} title="Steer: interrupt the current step with this message" onclick={() => { steer = !steer; }}>
        <Icon name="steer" size={14} /><span>Steer</span>
      </button>
      <button class="send stop" aria-label="Stop" title="Stop (Esc)" onclick={() => stop?.()}><Icon name="stop" size={16} /></button>
    {:else}
      <button class="send" aria-label="Send" title="Send (Enter)" disabled={!canSend} onclick={() => void submit("followUp")}>
        {#if sending}<span class="spinner light"></span>{:else}<Icon name="send" size={16} />{/if}
      </button>
    {/if}
  </div>
  {#if busy && (text.trim() || sending)}
    <div class="hint-line">{steer ? "Enter steers the current step" : "Enter queues a follow-up"} · Cmd+Enter steers · Shift+Enter for a new line</div>
  {:else if text.length > MAX_MESSAGE_LENGTH}
    <div class="hint-line danger">Message is {text.length.toLocaleString()} characters. The limit is {MAX_MESSAGE_LENGTH.toLocaleString()}.</div>
  {/if}
</div>

<style>
  .composer { position: relative; border: 1px solid var(--border); border-radius: 18px; background: var(--bg-elevated); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04); transition: border-color 0.15s ease, box-shadow 0.15s ease; }
  .composer:focus-within { border-color: var(--border-strong); box-shadow: 0 2px 12px rgba(0, 0, 0, 0.06); }
  .composer.dragging { border-color: var(--accent); background: var(--accent-soft); }
  .row { display: flex; align-items: flex-end; gap: 6px; padding: 8px 8px 8px 10px; }
  textarea { flex: 1; min-width: 0; resize: none; border: 0; background: none; outline: none; padding: 5px 4px; line-height: 1.5; max-height: 40vh; font-size: 15px; }
  textarea::placeholder { color: var(--text-faint); }
  .send { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 50%; background: var(--accent); color: var(--accent-text); flex: none; transition: transform 0.12s ease; }
  .send:hover:not(:disabled) { transform: scale(1.05); }
  .send:disabled { background: var(--bg-active); color: var(--text-faint); opacity: 1; }
  .send.stop { background: var(--text); color: var(--bg); }
  .spinner.light { border-color: rgba(255, 255, 255, 0.4); border-top-color: #fff; }
  .steer-toggle { height: 28px; margin-bottom: 2px; }
  .thumbs { display: flex; gap: 8px; padding: 10px 12px 0; flex-wrap: wrap; }
  .thumb { position: relative; width: 64px; height: 64px; border-radius: var(--radius-small); overflow: hidden; border: 1px solid var(--border); }
  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .remove { position: absolute; top: 3px; right: 3px; width: 18px; height: 18px; border-radius: 50%; background: rgba(0, 0, 0, 0.6); color: #fff; display: inline-flex; align-items: center; justify-content: center; }
  .slash-menu { position: absolute; left: 8px; right: 8px; bottom: calc(100% + 6px); z-index: 20; padding: 6px; border-radius: var(--radius); border: 1px solid var(--border); background: var(--bg-elevated); box-shadow: var(--shadow); max-height: 320px; overflow: auto; }
  .command-name { font-family: var(--mono); font-size: 13px; white-space: nowrap; }
  .command-description { color: var(--text-muted); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .hint-line { padding: 0 14px 8px; font-size: 12px; color: var(--text-faint); }
  .hint-line.danger { color: var(--danger); }
</style>
