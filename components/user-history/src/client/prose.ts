import { artifactFromClick, copyFromClick } from "./markdown.ts";
import { diagramSwitchFromClick, expandFromClick } from "./diagrams.ts";

/**
 * One click handler for rendered markdown: the copy button, the Diagram / Source switch and Expand are handled here; an artifact link
 * button and a reply image are handed back to the view, which opens the reader or a lightbox.
 */
export type ProseClick = { kind: "handled" } | { kind: "artifact"; target: string } | { kind: "image"; src: string; alt: string } | null;
export function proseClick(event: MouseEvent): ProseClick {
  if (copyFromClick(event) || diagramSwitchFromClick(event) || expandFromClick(event)) return { kind: "handled" };
  const artifact = artifactFromClick(event);
  if (artifact) return { kind: "artifact", target: artifact };
  const target = event.target;
  if (target instanceof HTMLImageElement && target.classList.contains("reply-image")) return { kind: "image", src: target.src, alt: target.alt || "Image" };
  return null;
}

/** A reply image that fails to load becomes a line naming what it pointed at. For `onerrorcapture` on the prose element. */
export function brokenImage(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLImageElement) || !target.classList.contains("reply-image")) return;
  const note = document.createElement("span");
  note.className = "inert-image";
  note.textContent = "Image not found: " + (target.dataset.source ?? target.alt);
  target.replaceWith(note);
}
