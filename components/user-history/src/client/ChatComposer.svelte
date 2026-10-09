<script module lang="ts">
  import { drafts, type DraftAttachment } from "./drafts.ts";
  let attachmentId = 0;

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
  import type { ImageInput } from "../shared/types.ts";
  import { replyText } from "./reply.ts";
  import Icon from "./Icon.svelte";
  import Lightbox from "./ui/Lightbox.svelte";
  import { tooltip } from "./ui/tooltip.ts";

  /**
   * The chat box. Enter sends at once and the box is free again before the server answers; Shift+Enter adds a line. Images paste or
   * drop in. `send` resolves false when the server refused the message, and the text comes back into an empty box. The draft lives under `draftKey`.
   * A Reply on a bubble (`store.replyQuote` for this chat) puts a quote chip over the box; the send is `> ` lines of it, a blank line, then the text.
   * The x on the chip or Escape drops the quote.
   */
  let { draftKey, send, acceptsImages = true, focusOnMount = false }: { draftKey: string; send: (text: string, images: ImageInput[]) => Promise<boolean>; acceptsImages?: boolean; focusOnMount?: boolean } = $props();

  const restored = drafts.get(untrack(() => draftKey));
  let text = $state(restored?.text ?? "");
  let images = $state<DraftAttachment[]>(restored?.images ?? []);
  let quote = $state<string | null>(restored?.quote ?? null);
  let textarea: HTMLTextAreaElement | undefined = $state();
  let dragging = $state(false);
  let lightbox = $state<number | null>(null);

  $effect(() => { drafts.set(draftKey, { text, images, quote }); });
  $effect(() => {
    const request = store.replyQuote;
    if (!request || request.chat !== draftKey) return;
    untrack(() => { quote = request.text; store.replyQuote = null; textarea?.focus(); });
  });
  $effect(() => {
    void text;
    const node = textarea;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = Math.min(node.scrollHeight, window.innerHeight * 0.4) + "px";
  });
  $effect(() => { if (focusOnMount) textarea?.focus(); });

  const canSend = $derived((text.trim().length > 0 || images.length > 0) && text.length <= MAX_MESSAGE_LENGTH);
  const totalBytes = $derived(images.reduce((sum, image) => sum + image.size, 0));

  function onKeydown(event: KeyboardEvent): void {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); }
    else if (event.key === "Escape" && quote !== null) { event.preventDefault(); quote = null; }
  }

  function submit(): void {
    if (!canSend) return;
    const message = text.trim();
    const quoted = quote;
    const sent = images;
    const payload: ImageInput[] = sent.map(image => ({ type: "image", mimeType: image.mimeType, data: image.data }));
    text = "";
    images = [];
    quote = null;
    drafts.delete(draftKey);
    void tick().then(() => textarea?.focus());
    void send(replyText(quoted, message), payload).then(ok => {
      if (ok) { for (const image of sent) URL.revokeObjectURL(image.url); return; }
      if (!text.trim() && !images.length && quote === null) { text = message; images = sent; quote = quoted; }
      else for (const image of sent) URL.revokeObjectURL(image.url);
    });
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
</script>

<div class="chat-composer" class:dragging role="group" aria-label="Message"
  ondragover={event => { event.preventDefault(); dragging = true; }} ondragleave={() => { dragging = false; }} ondrop={onDrop}>
  {#if quote !== null}
    <div class="quote fade-in">
      <Icon name="reply" size={13} />
      <span class="quote-text">{quote}</span>
      <button type="button" class="quote-remove" aria-label="Remove the quote" use:tooltip={"Remove the quote (Esc)"} onclick={() => { quote = null; textarea?.focus(); }}><Icon name="x" size={12} /></button>
    </div>
  {/if}
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
  <div class="row">
    <textarea data-composer bind:this={textarea} bind:value={text} placeholder="Message" rows="1" aria-label="Message" enterkeyhint="send"
      onkeydown={onKeydown} onpaste={onPaste}></textarea>
    <button type="button" class="send" class:ready={canSend} aria-label="Send" disabled={!canSend} onclick={submit}><Icon name="send" size={16} /></button>
  </div>
  {#if text.length > MAX_MESSAGE_LENGTH}
    <div class="hint-line danger">Message is {text.length.toLocaleString()} characters. The limit is {MAX_MESSAGE_LENGTH.toLocaleString()}.</div>
  {/if}
  {#if lightbox !== null}
    <Lightbox images={images.map(image => ({ src: image.url, alt: image.name }))} index={lightbox} onclose={() => { lightbox = null; }} />
  {/if}
</div>

<style>
  .chat-composer { position: relative; border: 1px solid var(--border-strong); border-radius: 22px; background: var(--bg-elevated); box-shadow: var(--shadow-small); transition: border-color 0.15s ease, box-shadow 0.15s ease; }
  .chat-composer:focus-within { border-color: color-mix(in srgb, var(--accent) 45%, var(--border-strong)); box-shadow: 0 0 0 3px var(--accent-soft), var(--shadow-small); }
  .chat-composer.dragging { border-color: var(--accent); background: var(--accent-soft); }
  .row { display: flex; align-items: flex-end; gap: 6px; padding: 5px 5px 5px 16px; }
  textarea { flex: 1; min-width: 0; display: block; resize: none; border: 0; background: none; outline: none; padding: 6px 0; line-height: 1.5; max-height: 40vh; font-size: 16px; }
  textarea::placeholder { color: var(--text-faint); }
  .send { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 34px; height: 34px; border-radius: 50%; background: var(--bg-active); color: var(--text-faint); transition: background-color 0.12s, color 0.12s; }
  .send.ready { background: var(--primary); color: var(--primary-text); }
  .send.ready:hover { background: var(--primary-hover); }
  .send:disabled { opacity: 1; }
  /* The quote chip: the reply arrow, the excerpt clamped to two lines, and an x; it sits over the box like the image thumbs do. */
  .quote { display: flex; align-items: flex-start; gap: 8px; margin: 8px 10px 0; padding: 6px 6px 6px 10px; border-left: 3px solid var(--accent); border-radius: 4px var(--radius-small) var(--radius-small) 4px; background: var(--bg-sunken); color: var(--text-muted); font-size: 13px; line-height: 1.4; }
  .quote > :global(svg) { flex: none; margin-top: 3px; color: var(--text-faint); }
  .quote-text { flex: 1; min-width: 0; white-space: pre-line; overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow-wrap: anywhere; }
  .quote-remove { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: 50%; color: var(--text-faint); }
  .quote-remove:hover { background: var(--bg-hover); color: var(--text); }
  .thumbs { display: flex; gap: 8px; padding: 10px 12px 0; flex-wrap: wrap; }
  .thumb { position: relative; width: 64px; height: 64px; border-radius: var(--radius-small); overflow: hidden; border: 1px solid var(--border); }
  .view { display: block; width: 100%; height: 100%; cursor: zoom-in; }
  .view img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .remove { position: absolute; top: 3px; right: 3px; width: 18px; height: 18px; border-radius: 50%; background: rgba(0, 0, 0, 0.6); color: #fff; display: inline-flex; align-items: center; justify-content: center; }
  .hint-line { padding: 0 16px 8px; font-size: 12px; color: var(--text-faint); }
  .hint-line.danger { color: var(--danger); }
</style>
