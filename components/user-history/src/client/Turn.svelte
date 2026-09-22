<script lang="ts">
  import { api } from "./api.ts";
  import { store } from "./store.svelte.ts";
  import { clockTime } from "./format.ts";
  import { renderMarkdown, copyFromClick } from "./markdown.ts";
  import { messageText, triggerSummary, type Turn } from "../shared/turns.ts";
  import type { ImagePart } from "../shared/types.ts";
  import WorkRow from "./WorkRow.svelte";
  import Icon from "./Icon.svelte";

  let { turn, threadId }: { turn: Turn; threadId: string } = $props();

  const prompt = $derived(turn.prompt);
  const promptText = $derived(prompt ? messageText(prompt.message) : "");
  const promptImages = $derived(prompt && typeof prompt.message.content !== "string" ? prompt.message.content.filter((part): part is ImagePart => part.type === "image") : []);
  const promptAt = $derived(prompt ? clockTime(prompt.message.timestamp) : "");
  const trigger = $derived(turn.trigger ? triggerSummary(turn.trigger.message) : null);

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

  function noteTitle(role: string): string {
    return role === "compactionSummary" ? "Context compacted" : role === "branchSummary" ? "Branch summary" : role;
  }
</script>

<article class="turn" id={turn.key}>
  {#if trigger}
    <details class="trigger">
      <summary><Icon name="bolt" size={13} /><span class="trigger-label">{trigger.label}</span>{#if trigger.detail}<span class="trigger-detail">{trigger.detail}</span>{/if}{#if !trigger.body.includes("\n") && trigger.body.length < 120}<span class="trigger-inline">{trigger.body}</span>{/if}</summary>
      {#if trigger.body}<div class="trigger-body">{trigger.body}</div>{/if}
    </details>
  {/if}
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
  {#if turn.work.length}
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
  {#each turn.notes as note (note.index)}
    <div class="system-note">
      {#if note.message.role === "bashExecution"}
        <details>
          <summary><span class="mono">$ {note.message.command}</span>{#if note.message.exitCode !== undefined && note.message.exitCode !== 0} <span class="danger">exit {note.message.exitCode}</span>{/if}{#if note.message.cancelled} <span class="danger">cancelled</span>{/if}</summary>
          <pre>{note.message.output || "(no output)"}{#if note.message.truncated}
(truncated){/if}</pre>
        </details>
      {:else if note.message.role === "compactionSummary" || note.message.role === "branchSummary"}
        <details>
          <summary>{noteTitle(note.message.role)}{#if note.message.role === "compactionSummary"} <span class="faint">{note.message.tokensBefore.toLocaleString()} tokens before</span>{/if}</summary>
          <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
          <div class="prose summary" onclick={copyFromClick}>{@html renderMarkdown(note.message.summary)}</div>
        </details>
      {:else}
        <span class="custom-type">{note.message.customType.replaceAll("_", " ")}</span>
        <span class="custom-text">{messageText(note.message)}</span>
      {/if}
    </div>
  {/each}
</article>

<style>
  .turn { content-visibility: auto; contain-intrinsic-size: auto 200px; padding: 10px 0; }
  .prompt-row { display: flex; flex-direction: column; align-items: flex-end; margin: 8px 0 14px; }
  .bubble { max-width: min(85%, 640px); padding: 10px 16px; border-radius: 18px 18px 6px 18px; background: var(--user-bubble); }
  .skill-tag { display: inline-flex; align-items: center; gap: 4px; margin-bottom: 4px; padding: 1px 8px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); font-size: 12px; font-family: var(--mono); }
  .trigger { margin: 6px 0 10px; font-size: 13px; color: var(--text-muted); }
  .trigger summary { display: flex; align-items: center; gap: 6px; cursor: pointer; list-style: none; min-width: 0; padding: 2px 0; }
  .trigger summary::-webkit-details-marker { display: none; }
  .trigger summary:hover { color: var(--text); }
  .trigger-label { font-weight: 500; flex: none; }
  .trigger-detail { color: var(--text-faint); flex: none; }
  .trigger-inline { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-faint); font-family: var(--mono); font-size: 12px; }
  .trigger-body { margin: 4px 0 0 19px; padding: 8px 12px; border-left: 2px solid var(--border); white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; max-height: 360px; overflow: auto; }
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
  .system-note { margin: 8px 0; padding: 6px 12px; border-radius: var(--radius-small); background: var(--bg-sunken); color: var(--text-muted); font-size: 13px; }
  .system-note summary { cursor: pointer; }
  .system-note pre { margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--mono); font-size: 12px; max-height: 320px; overflow: auto; }
  .summary { margin-top: 6px; }
  .custom-type { font-weight: 600; text-transform: capitalize; margin-right: 6px; }
  .custom-text { white-space: pre-wrap; overflow-wrap: anywhere; }
  .danger { color: var(--danger); }
</style>
