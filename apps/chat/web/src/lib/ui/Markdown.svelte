<script lang="ts">
  import { mount, unmount } from "svelte";
  import Lightbox from "./Lightbox.svelte";
  import Mermaid from "./Mermaid.svelte";
  import { renderInline, renderMarkdown, type MarkdownContext } from "./markdown";
  import { whenVisible } from "./mermaid";

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

  /** A diagram that does not parse falls back to its code block, with mermaid's first error line above it. */
  function showSource(block: HTMLElement, message: string) {
    block.classList.add("diagram-failed");
    const note = block.querySelector<HTMLElement>(".diagram-error");
    if (note) {
      note.textContent = `This diagram did not parse, so here is its source. ${message}`;
      note.hidden = false;
    }
    const pre = block.querySelector("pre");
    const slot = block.querySelector<HTMLElement>(".diagram-slot");
    if (pre) pre.hidden = false;
    if (slot) slot.hidden = true;
    block.querySelector<HTMLElement>("[data-diagram-toggle]")?.remove();
    block.querySelector<HTMLElement>("[data-diagram-expand]")?.remove();
  }

  // Diagrams mount only once they come near the viewport, so a long history loads mermaid for none of them until one scrolls in.
  $effect(() => {
    void html;
    if (!root || streaming) return;
    const mounted: ReturnType<typeof mount>[] = [];
    const cancels: (() => void)[] = [];
    const slots: HTMLElement[] = [];
    for (const block of root.querySelectorAll<HTMLElement>(".diagram-block")) {
      const slot = block.querySelector<HTMLElement>(".diagram-slot");
      const source = block.querySelector("code")?.textContent ?? "";
      if (!slot || slot.dataset.mounted) continue;
      slot.dataset.mounted = "1";
      slots.push(slot);
      cancels.push(
        whenVisible(slot, () => {
          mounted.push(mount(Mermaid, { target: slot, props: { source, onerror: (message: string) => showSource(block, message) } }));
        }),
      );
    }
    return () => {
      for (const cancel of cancels) cancel();
      for (const m of mounted) void unmount(m);
      for (const slot of slots) delete slot.dataset.mounted;
    };
  });

  // A favicon that does not load goes away, and a broken image becomes a line that names it. `error` does not bubble, so this listens in capture.
  $effect(() => {
    const el = root;
    if (!el) return;
    const onError = (e: Event) => {
      const img = e.target;
      if (!(img instanceof HTMLImageElement)) return;
      if (img.classList.contains("favicon")) img.remove();
      else if (img.classList.contains("md-image")) {
        const note = document.createElement("span");
        note.className = "inert-image";
        note.textContent = `Image did not load: ${img.dataset.source || img.alt || img.src}`;
        img.replaceWith(note);
      }
    };
    el.addEventListener("error", onError, true);
    return () => el.removeEventListener("error", onError, true);
  });

  /** A drawn diagram opens in the lightbox at twice its size, as an SVG file of its own on a panel-colored ground. */
  function openDiagram(svg: SVGSVGElement) {
    const clone = svg.cloneNode(true) as SVGSVGElement;
    const box = svg.viewBox.baseVal;
    if (box?.width && box.height) {
      clone.setAttribute("width", String(Math.round(box.width * 2)));
      clone.setAttribute("height", String(Math.round(box.height * 2)));
    }
    clone.style.maxWidth = "none";
    clone.style.background = getComputedStyle(document.documentElement).getPropertyValue("--surface-panel").trim() || "#fff";
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" }));
    lightbox = { src: url, alt: "Diagram" };
  }

  function closeLightbox() {
    if (lightbox?.src.startsWith("blob:")) URL.revokeObjectURL(lightbox.src);
    lightbox = null;
  }

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
    const expand = el.closest<HTMLElement>("[data-expand]");
    if (expand) {
      const block = expand.closest(".code-block");
      const folded = !!block?.classList.toggle("folded");
      expand.textContent = folded ? `Show all ${expand.dataset.lines} lines` : "Show less";
      expand.setAttribute("aria-expanded", String(!folded));
      if (folded) block?.scrollIntoView({ block: "nearest" });
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
    const expandDiagram = el.closest("[data-diagram-expand]");
    const drawn = expandDiagram ? expandDiagram.closest(".diagram-block")?.querySelector(".diagram-slot svg") : el.closest(".diagram-slot svg");
    if (drawn instanceof SVGSVGElement) {
      openDiagram(drawn);
      return;
    }
    if (expandDiagram) return;
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
      if (onartifact) onartifact(link.dataset.target, e);
      else if (link.dataset.target.startsWith("file:")) void navigator.clipboard.writeText(link.dataset.target.slice(5));
    }
  }
</script>

<!-- Clicks inside rendered HTML are delegated here; every target inside is a link or a button. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<svelte:element this={inline ? "span" : "div"} bind:this={root} class="prose {className}" class:inline class:streaming {onclick}>
  {@html html}
</svelte:element>

<Lightbox src={lightbox?.src ?? null} alt={lightbox?.alt ?? ""} onclose={closeLightbox} />
