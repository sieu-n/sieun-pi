<script lang="ts">
  import { api } from "./api.ts";
  import { store } from "./store.svelte.ts";
  import { ui } from "./ui.svelte.ts";
  import { clockTime } from "./format.ts";
  import { renderMarkdown } from "./markdown.ts";
  import { diagrams } from "./diagrams.ts";
  import { brokenImage, proseClick } from "./prose.ts";
  import { parseArtifactTarget } from "../shared/artifact-link.ts";
  import { exchangesOf, messageText, ownRun, type Turn } from "../shared/turns.ts";
  import type { ImagePart } from "../shared/types.ts";
  import WorkRow from "./WorkRow.svelte";
  import TurnView from "./Turn.svelte";
  import Icon from "./Icon.svelte";
  import { tooltip } from "./ui/tooltip.ts";
  import { longpress } from "./ui/longpress.ts";
  import Lightbox from "./ui/Lightbox.svelte";
  import { copyPermalink } from "./permalink.ts";

  /**
   * `nested` marks an exchange: an agent message or background completion shown below the reply it followed.
   * `latest` marks the thread's last turn, which keeps its newest exchange open; every other exchange folds into one row.
   */
  let { turn, threadId, nested = false, latest = false }: { turn: Turn; threadId: string; nested?: boolean; latest?: boolean } = $props();

  const prompt = $derived(turn.prompt);
  const promptText = $derived(prompt ? messageText(prompt.message) : "");
  const promptImages = $derived(prompt && typeof prompt.message.content !== "string" ? prompt.message.content.filter((part): part is ImagePart => part.type === "image") : []);
  const promptAt = $derived(prompt ? clockTime(prompt.message.timestamp) : "");

  const own = $derived(ownRun(turn));
  const exchanges = $derived(exchangesOf(turn));
  const pinned = $derived(latest ? exchanges.at(-1) ?? null : null);
  const folded = $derived(pinned ? exchanges.slice(0, -1) : exchanges);
  const foldLabel = $derived(`${folded.length} ${pinned ? "earlier " : ""}${folded.length === 1 ? "message" : "messages"}${pinned ? "" : " after this reply"}`);
  let showFolded = $state(false);
  const reply = $derived(turn.reply);
  const replyLive = $derived(reply?.live ?? false);
  const replyText = $derived(reply ? messageText(reply.message) : "");
  const replyTruncated = $derived(reply ? reply.message.content.some(part => part.type === "text" && part.truncated) : false);
  const failed = $derived(reply && !reply.live && (reply.message.stopReason === "error" || reply.message.stopReason === "aborted") ? reply.message : turn.failure?.message ?? null);
  let fullReply = $state<string | null>(null);
  const shownText = $derived(fullReply ?? replyText);
  const cwd = $derived(store.thread(threadId)?.state?.info.cwd ?? "");
  const replyHtml = $derived(shownText ? renderMarkdown(shownText, cwd) : "");
  let replyImage = $state<{ src: string; alt: string } | null>(null);

  function onProseClick(event: MouseEvent): void {
    const click = proseClick(event);
    if (click?.kind === "image") replyImage = { src: click.src, alt: click.alt };
    else if (click?.kind === "artifact") { const target = parseArtifactTarget(click.target); if (target) store.openArtifact(target, threadId); }
  }
  let copied = $state(false);
  let lightbox = $state<number | null>(null);

  async function loadFullReply(): Promise<void> {
    if (!reply) return;
    const parts = await Promise.all(reply.message.content.flatMap((part, index) =>
      part.type === "text" ? [part.truncated ? api.part(threadId, reply.index, index).then(result => result.text) : Promise.resolve(part.text)] : []));
    fullReply = parts.join("\n\n");
  }

  function copyReply(): void {
    void navigator.clipboard.writeText(shownText).then(() => {
      copied = true;
      setTimeout(() => { copied = false; }, 1200);
    });
  }
  async function copyLink(at: number): Promise<void> {
    store.toast(await copyPermalink(threadId, at) ? "Link copied" : "Could not copy the link", "info");
  }
</script>

{#snippet linkButton(at: number)}
  <button type="button" class="icon-button small link-button" aria-label="Copy link to this message" use:tooltip={"Copy link"} onclick={() => void copyLink(at)}><Icon name="link" size={13} /></button>
{/snippet}

<article class="turn" class:triggered={turn.trigger !== null} class:nested id={turn.key}>
  {#if prompt}
    <div class="prompt-row" data-at={prompt.message.timestamp}>
      {#if prompt.message.skill}<div class="skill-tag"><Icon name="sparkle" size={12} />{prompt.message.skill}</div>{/if}
      <div class="bubble" use:longpress={() => void copyLink(prompt.message.timestamp)}>
        {#if promptImages.length}
          <div class="images">
            {#each promptImages as image, index (image.url + index)}
              <button type="button" class="view" aria-label="View image {index + 1}" onclick={() => { lightbox = index; }}><img src={image.url} alt="Attached" loading="lazy" /></button>
            {/each}
          </div>
        {/if}
        {#if promptText}<div class="prompt-text">{promptText}</div>{/if}
      </div>
      <div class="stamp">{@render linkButton(prompt.message.timestamp)}{promptAt}</div>
    </div>
  {/if}
  {#if (turn.trigger || own.work.length) && !(ui.viewMode === "read" && prompt)}
    <WorkRow turn={own} {threadId} {nested} />
  {/if}
  {#if reply && (shownText || replyLive)}
    <div class="reply fade-in" data-at={reply.message.timestamp}>
      <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
      <div class="prose" onclick={onProseClick} onerrorcapture={brokenImage} use:diagrams={{ html: replyHtml, live: replyLive }} use:longpress={() => void copyLink(reply.message.timestamp)}>{@html replyHtml}{#if replyLive}<span class="caret"></span>{/if}</div>
      {#if replyTruncated && fullReply === null}
        <button class="more" onclick={() => void store.run(loadFullReply())}>Show the full reply</button>
      {/if}
      {#if !replyLive && shownText}
        <div class="reply-actions">
          <button type="button" class="icon-button" aria-label={copied ? "Copied" : "Copy reply"} use:tooltip={copied ? "Copied" : "Copy reply"} onclick={copyReply}><Icon name={copied ? "check" : "copy"} size={15} /></button>
          {@render linkButton(reply.message.timestamp)}
          {#if reply.message.model}<span class="model faint">{reply.message.model}</span>{/if}
        </div>
      {/if}
    </div>
  {/if}
  {#if lightbox !== null}
    <Lightbox images={promptImages.map((image, index) => ({ src: image.url, alt: `Image ${index + 1}` }))} index={lightbox} onclose={() => { lightbox = null; }} />
  {/if}
  {#if replyImage}
    <Lightbox images={[replyImage]} index={0} onclose={() => { replyImage = null; }} />
  {/if}
  {#if failed}
    <div class="failed" role="status">{failed.stopReason === "aborted" ? "Response stopped" : "Error: " + (failed.errorMessage || "the model returned an error")}</div>
  {/if}
  {#if folded.length}
    <button type="button" class="fold" aria-expanded={showFolded} onclick={() => { showFolded = !showFolded; }}>
      <span class="fold-mark" class:down={showFolded}><Icon name="chevronRight" size={12} /></span>{foldLabel}
    </button>
    {#if showFolded}
      {#each folded as exchange (exchange.key)}
        <TurnView turn={exchange} {threadId} nested />
      {/each}
    {/if}
  {/if}
  {#if pinned}
    <TurnView turn={pinned} {threadId} nested />
  {/if}
</article>

<style>
  .turn { content-visibility: auto; contain-intrinsic-size: auto 120px; padding: 14px 0 22px; }
  :global(.turn) + .turn { border-top: 1px solid var(--border); }
  .turn.triggered { padding: 6px 0 10px; }
  .turn.nested { content-visibility: visible; padding: 10px 0 0; }
  .fold { display: flex; align-items: center; gap: 8px; margin-top: 12px; padding: 3px 0; font-size: 13px; line-height: 1.5; color: var(--text-faint); transition: color 0.12s; }
  .fold:hover { color: var(--text); }
  .fold-mark { display: inline-flex; width: 14px; justify-content: center; transition: transform 0.12s; }
  .fold-mark.down { transform: rotate(90deg); }
  :global(.turn.triggered) + .turn.triggered { border-top: 0; }
  .prompt-row { display: flex; flex-direction: column; align-items: flex-end; margin: 10px 0 18px; }
  .bubble { max-width: min(85%, 640px); padding: 10px 16px; border-radius: 18px 18px 6px 18px; background: var(--user-bubble); }
  .skill-tag { display: inline-flex; align-items: center; gap: 4px; margin-bottom: 4px; padding: 1px 8px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); font-size: 12px; font-family: var(--mono); }
  .prompt-text { white-space: pre-wrap; overflow-wrap: anywhere; }
  .images { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
  .view { display: block; cursor: zoom-in; border-radius: var(--radius-small); }
  .images img { max-width: 240px; max-height: 240px; border-radius: var(--radius-small); display: block; }
  .stamp { display: flex; align-items: center; gap: 2px; margin-top: 2px; font-size: 11px; color: var(--text-faint); opacity: 0; transition: opacity 0.15s; }
  .prompt-row:hover .stamp, .stamp:focus-within { opacity: 1; }
  .link-button { color: var(--text-faint); }
  .reply-actions .link-button { width: 30px; height: 30px; }
  .reply { position: relative; margin-top: 6px; }
  .reply-actions { display: flex; align-items: center; gap: 8px; margin-top: 4px; opacity: 0; transition: opacity 0.15s; font-size: 12px; }
  .reply:hover .reply-actions, .reply-actions:focus-within { opacity: 1; }
  .more { color: var(--accent); font-size: 13px; margin-top: 4px; }
  .failed { display: inline-block; margin-top: 8px; padding: 6px 10px; border-radius: var(--radius-small); background: var(--danger-soft); color: var(--danger); font-size: 13px; }
</style>
