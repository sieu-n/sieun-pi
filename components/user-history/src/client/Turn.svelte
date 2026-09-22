<script lang="ts">
  import { api } from "./api.ts";
  import { store } from "./store.svelte.ts";
  import { clockTime } from "./format.ts";
  import { renderMarkdown, copyFromClick } from "./markdown.ts";
  import { messageText, type Turn } from "../shared/turns.ts";
  import type { ImagePart } from "../shared/types.ts";
  import WorkRow from "./WorkRow.svelte";
  import Icon from "./Icon.svelte";

  let { turn, threadId }: { turn: Turn; threadId: string } = $props();

  const prompt = $derived(turn.prompt);
  const promptText = $derived(prompt ? messageText(prompt.message) : "");
  const promptImages = $derived(prompt && typeof prompt.message.content !== "string" ? prompt.message.content.filter((part): part is ImagePart => part.type === "image") : []);
  const promptAt = $derived(prompt ? clockTime(prompt.message.timestamp) : "");

  const reply = $derived(turn.reply);
  const replyLive = $derived(reply?.live ?? false);
  const replyText = $derived(reply ? messageText(reply.message) : "");
  const replyTruncated = $derived(reply ? reply.message.content.some(part => part.type === "text" && part.truncated) : false);
  const failed = $derived(reply && !reply.live && (reply.message.stopReason === "error" || reply.message.stopReason === "aborted") ? reply.message : null);
  let fullReply = $state<string | null>(null);
  const shownText = $derived(fullReply ?? replyText);
  const replyHtml = $derived(shownText ? renderMarkdown(shownText) : "");
  let copied = $state(false);

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
</script>

<article class="turn" class:triggered={turn.trigger !== null} id={turn.key}>
  {#if prompt}
    <div class="prompt-row">
      {#if prompt.message.skill}<div class="skill-tag"><Icon name="sparkle" size={12} />{prompt.message.skill}</div>{/if}
      <div class="bubble">
        {#if promptImages.length}
          <div class="images">
            {#each promptImages as image, index (image.url + index)}
              <img src={image.url} alt="Attached" loading="lazy" />
            {/each}
          </div>
        {/if}
        {#if promptText}<div class="prompt-text">{promptText}</div>{/if}
      </div>
      <div class="stamp">{promptAt}</div>
    </div>
  {/if}
  {#if turn.trigger || turn.work.length}
    <WorkRow {turn} {threadId} />
  {/if}
  {#if reply && (shownText || replyLive)}
    <div class="reply fade-in">
      <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
      <div class="prose" onclick={copyFromClick}>{@html replyHtml}{#if replyLive}<span class="caret"></span>{/if}</div>
      {#if replyTruncated && fullReply === null}
        <button class="more" onclick={() => void store.run(loadFullReply())}>Show the full reply</button>
      {/if}
      {#if !replyLive && shownText}
        <div class="reply-actions">
          <button class="icon-button" aria-label="Copy reply" title={copied ? "Copied" : "Copy reply"} onclick={copyReply}><Icon name={copied ? "check" : "copy"} size={15} /></button>
          {#if reply.message.model}<span class="model faint">{reply.message.model}</span>{/if}
        </div>
      {/if}
    </div>
  {/if}
  {#if failed}
    <div class="failed" role="status">{failed.stopReason === "aborted" ? "Response stopped" : "Error: " + (failed.errorMessage || "the model returned an error")}</div>
  {/if}
</article>

<style>
  .turn { content-visibility: auto; contain-intrinsic-size: auto 120px; padding: 8px 0; }
  .turn.triggered { padding: 2px 0; }
  .prompt-row { display: flex; flex-direction: column; align-items: flex-end; margin: 8px 0 14px; }
  .bubble { max-width: min(85%, 640px); padding: 10px 16px; border-radius: 18px 18px 6px 18px; background: var(--user-bubble); }
  .skill-tag { display: inline-flex; align-items: center; gap: 4px; margin-bottom: 4px; padding: 1px 8px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); font-size: 12px; font-family: var(--mono); }
  .prompt-text { white-space: pre-wrap; overflow-wrap: anywhere; }
  .images { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
  .images img { max-width: 240px; max-height: 240px; border-radius: var(--radius-small); display: block; }
  .stamp { margin-top: 4px; font-size: 11px; color: var(--text-faint); opacity: 0; transition: opacity 0.15s; }
  .prompt-row:hover .stamp { opacity: 1; }
  .reply { position: relative; }
  .reply-actions { display: flex; align-items: center; gap: 8px; margin-top: 4px; opacity: 0; transition: opacity 0.15s; font-size: 12px; }
  .reply:hover .reply-actions, .reply-actions:focus-within { opacity: 1; }
  .more { color: var(--accent); font-size: 13px; margin-top: 4px; }
  .failed { display: inline-block; margin-top: 8px; padding: 6px 10px; border-radius: var(--radius-small); background: var(--danger-soft); color: var(--danger); font-size: 13px; }
</style>
