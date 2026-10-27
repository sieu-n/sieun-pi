<script lang="ts">
  import Icon from "./Icon.svelte";

  type Props = {
    label: string;
    /** person, agent or channel; agents get a small robot glyph and channels a # glyph. */
    kind?: "person" | "agent" | "channel";
    /** A mention of the owner, drawn lime with black ink. */
    self?: boolean;
    href?: string;
    id?: string;
    onclick?: (e: MouseEvent) => void;
    /** Shown in the composer: a remove control replaces the click. */
    onremove?: () => void;
  };
  let { label, kind = "person", self = false, href, id, onclick, onremove }: Props = $props();
  const text = $derived(kind === "channel" ? label : label.replace(/^@?/, kind === "agent" ? "" : "@"));
</script>

<!-- The element is a link or a button whenever it has a click handler. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<svelte:element
  this={href ? "a" : onclick ? "button" : "span"}
  {href}
  type={!href && onclick ? "button" : undefined}
  class="inline-chip mention"
  class:self
  data-mention-kind={kind}
  data-mention-id={id}
  contenteditable="false"
  {onclick}
>
  {#if kind === "agent"}<Icon name="robot" size={13} />{:else if kind === "channel"}<Icon name="hash" size={13} />{/if}
  <span class="text">{text}</span>
  {#if onremove}
    <button type="button" class="remove" aria-label="Remove {label}" onclick={(e) => (e.stopPropagation(), onremove())}><Icon name="close" size={12} /></button>
  {/if}
</svelte:element>

