<script lang="ts">
  import { mount, unmount } from "svelte";
  import Lightbox from "./Lightbox.svelte";
  import Mermaid from "./Mermaid.svelte";
  import { renderInline, renderMarkdown, type MarkdownContext } from "./markdown";

  type Props = {
    text: string;
    /** inline renders only inline markdown with line breaks, for the owner's bubbles and one-line rows. */
    inline?: boolean;
    context?: MarkdownContext;
    /** Draw a blinking caret after the text while it streams; diagrams wait until streaming stops. */
    streaming?: boolean;
    /** An artifact link was clicked: `job:<name>`, `thread:<id>`, `file:<path>` or `wiki:<path>`. Without it wiki links open in a tab. */
    onartifact?: (target: string, e: MouseEvent) => void;
    onboardid?: (id: string, chatId: string, e: MouseEvent) => void;
    onmention?: (id: string, kind: string, e: MouseEvent) => void;
    class?: string;
  };
  let { text, inline = false, context = {}, streaming = false, onartifact, onboardid, onmention, class: className = "" }: Props = $props();

  let root = $state<HTMLElement>();
  let lightbox = $state<{ src: string; alt: string } | null>(null);
  const html = $derived(inline ? renderInline(text, context) : renderMarkdown(text, context));

  $effect(() => {
    void html;
    if (!root || streaming) return;
    const mounted: ReturnType<typeof mount>[] = [];
    for (const block of root.querySelectorAll<HTMLElement>(".diagram-block")) {
      const slot = block.querySelector<HTMLElement>(".diagram-slot");
      const source = block.querySelector("code")?.textContent ?? "";
      if (!slot || slot.dataset.mounted) continue;
      slot.dataset.mounted = "1";
      mounted.push(mount(Mermaid, { target: slot, props: { source } }));
    }
    return () => {
      for (const m of mounted) void unmount(m);
    };
  });

  function onclick(e: MouseEvent) {
    const el = e.target instanceof Element ? e.target : null;
    if (!el) return;
    const copy = el.closest<HTMLElement>("[data-copy]");
    if (copy) {
      const code = copy.closest(".code-block")?.querySelector("code")?.textContent ?? "";
      void navigator.clipboard.writeText(code).then(() => {
        copy.textContent = "Copied";
        setTimeout(() => (copy.textContent = "Copy"), 1200);
      });
      return;
    }
    const toggle = el.closest<HTMLElement>("[data-diagram-toggle]");
    if (toggle) {
      const block = toggle.closest(".diagram-block");
      const pre = block?.querySelector("pre");
      const slot = block?.querySelector<HTMLElement>(".diagram-slot");
      if (pre && slot) {
        pre.hidden = !pre.hidden;
        slot.hidden = !pre.hidden;
        toggle.textContent = pre.hidden ? "Source" : "Diagram";
      }
      return;
    }
    const img = el.closest<HTMLImageElement>("img.md-image");
    if (img) {
      e.preventDefault();
      lightbox = { src: img.src, alt: img.alt };
      return;
    }
    const chip = el.closest<HTMLElement>("[data-board-id]");
    if (chip && onboardid) {
      e.preventDefault();
      onboardid(chip.dataset.boardId!, chip.dataset.chatId ?? "", e);
      return;
    }
    const mention = el.closest<HTMLElement>("[data-mention-id]");
    if (mention && onmention) {
      e.preventDefault();
      onmention(mention.dataset.mentionId!, mention.dataset.mentionKind ?? "person", e);
      return;
    }
    const link = el.closest<HTMLElement>(".artifact-link");
    if (link?.dataset.target) {
      const newTab = e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0;
      if (link.hasAttribute("target") && (newTab || !onartifact)) return;
      e.preventDefault();
      onartifact?.(link.dataset.target, e);
    }
  }
</script>

<!-- Clicks inside rendered HTML are delegated here; every target inside is a link or a button. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<svelte:element this={inline ? "span" : "div"} bind:this={root} class="prose {className}" class:inline class:streaming {onclick}>
  {@html html}
</svelte:element>

<Lightbox src={lightbox?.src ?? null} alt={lightbox?.alt ?? ""} onclose={() => (lightbox = null)} />
