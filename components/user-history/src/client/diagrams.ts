/*
 * Draws `.diagram-block` code blocks, and a wiki page's own HTML, in sandboxed frames (see src/chat-render.ts). The chat page keeps
 * its strict CSP; each frame has an opaque origin and gets only the block's source, or the page's HTML, by postMessage. Blocks draw
 * after the reply stops streaming and when they come near the screen. A page frame asks the chat for its file images (the frame
 * cannot reach the API) and hands link clicks back to the chat.
 */

type Theme = "light" | "dark";
type Payload = { kind: "mermaid"; source: string } | { kind: "page"; html: string };
/** What a page frame needs from the chat: where a clicked link goes, and the bytes of an image the page names by path. */
export interface PageHost { onOpen(href: string): void; image(src: string): Promise<Blob | null> }
type Frame = { id: string; block: HTMLElement; frame: HTMLIFrameElement; payload: Payload; maxHeight: number; page: PageHost | null; ready: boolean; drawn: Theme | null };

const frames = new Map<Window, Frame>();
let nextId = 0;
const MAX_FRAME_HEIGHT = 4000;
/** A page frame grows with its page; the reader scrolls, not the frame. */
const MAX_PAGE_HEIGHT = 200_000;

/** The page's actual scheme: the OS setting, or a forced `color-scheme` on <html>. Read from the canvas color. */
function theme(): Theme {
  const channels = getComputedStyle(document.body).backgroundColor.match(/\d+(\.\d+)?/g)?.map(Number) ?? [];
  const [r = 255, g = 255, b = 255] = channels;
  return 0.299 * r + 0.587 * g + 0.114 * b < 128 ? "dark" : "light";
}

function send(entry: Frame): void {
  const current = theme();
  if (!entry.ready || entry.drawn === current || !entry.frame.contentWindow) return;
  entry.drawn = current;
  entry.frame.style.colorScheme = current;
  entry.frame.contentWindow.postMessage({ type: "render", id: entry.id, theme: current, ...entry.payload }, "*");
}

function onMessage(event: MessageEvent): void {
  const entry = event.source ? frames.get(event.source as Window) : undefined;
  if (!entry || typeof event.data !== "object" || event.data === null) return;
  const data = event.data as { type?: unknown; id?: unknown; height?: unknown; message?: unknown; href?: unknown; index?: unknown; src?: unknown };
  if (data.type === "ready") { entry.ready = true; send(entry); return; }
  if (data.id !== entry.id) return;
  if (data.type === "open" && typeof data.href === "string") { entry.page?.onOpen(data.href); return; }
  if (data.type === "image" && typeof data.src === "string" && typeof data.index === "number") {
    const index = data.index;
    void entry.page?.image(data.src).then(blob => { if (blob && entry.frame.contentWindow) entry.frame.contentWindow.postMessage({ type: "image", id: entry.id, index, blob }, "*"); });
    return;
  }
  if (data.type === "size" && typeof data.height === "number") {
    entry.frame.style.height = Math.min(Math.max(Math.ceil(data.height), 40), entry.maxHeight) + "px";
    entry.block.classList.remove("diagram-failed");
    entry.block.classList.add("diagram-ready");
  } else if (data.type === "error") {
    entry.block.classList.remove("diagram-ready");
    entry.block.classList.add("diagram-failed");
    const note = entry.block.querySelector(".diagram-error") ?? entry.block.querySelector(".diagram-slot")?.appendChild(document.createElement("div"));
    if (note) { note.className = "diagram-error"; note.textContent = "Could not draw this diagram: " + String(data.message ?? "unknown error").split("\n")[0]; }
  }
}

let listening = false;
function listen(): void {
  if (listening) return;
  listening = true;
  window.addEventListener("message", onMessage);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { for (const entry of frames.values()) send(entry); });
}

function mount(block: HTMLElement): void {
  const slot = block.querySelector<HTMLElement>(".diagram-slot");
  const source = block.querySelector("code")?.textContent ?? "";
  if (!slot || block.dataset.mounted) return;
  block.dataset.mounted = "1";
  attach(block, slot, { kind: "mermaid", source }, MAX_FRAME_HEIGHT, null);
}

function attach(block: HTMLElement, slot: HTMLElement, payload: Payload, maxHeight: number, page: PageHost | null): Frame {
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("title", payload.kind === "page" ? "Wiki page" : "Diagram");
  frame.className = "diagram-frame";
  frame.src = "render";
  slot.appendChild(frame);
  const entry: Frame = { id: "d" + ++nextId, block, frame, payload, maxHeight, page, ready: false, drawn: null };
  const register = () => { if (frame.contentWindow) frames.set(frame.contentWindow, entry); };
  register();
  frame.addEventListener("load", register);
  return entry;
}

function unmount(root: HTMLElement): void {
  for (const [window, entry] of frames) if (!entry.block.isConnected || root.contains(entry.block)) frames.delete(window);
}

/** Svelte action for a reply's `.prose` element. `live` holds drawing back while the reply still streams; `eager` draws every block at once (a small card that scrolls inside) instead of as each nears the screen. */
export function diagrams(node: HTMLElement, params: { html: string; live: boolean; eager?: boolean }) {
  listen();
  let live = params.live;
  const eager = params.eager === true;
  const observer = new IntersectionObserver(entries => {
    for (const item of entries) {
      if (!item.isIntersecting) continue;
      observer.unobserve(item.target);
      mount(item.target as HTMLElement);
    }
  }, { rootMargin: "600px 0px" });
  const scan = () => {
    for (const [window, entry] of frames) if (!entry.block.isConnected) frames.delete(window);
    if (live) return;
    for (const block of node.querySelectorAll<HTMLElement>(".diagram-block:not([data-mounted])")) { if (eager) mount(block); else observer.observe(block); }
  };
  requestAnimationFrame(scan);
  return {
    update(next: { html: string; live: boolean; eager?: boolean }) { live = next.live; requestAnimationFrame(scan); },
    destroy() { observer.disconnect(); unmount(node); },
  };
}

/** Svelte action for the element that holds a wiki page's frame: the page's HTML drawn by the frame, sized to its content; `host` answers its links and images. */
export function pageFrame(node: HTMLElement, params: { html: string; host: PageHost }) {
  listen();
  let entry = attach(node, node, { kind: "page", html: params.html }, MAX_PAGE_HEIGHT, params.host);
  return {
    update(next: { html: string; host: PageHost }) {
      entry.page = next.host;
      if (entry.payload.kind === "page" && entry.payload.html === next.html) return;
      unmount(node);
      node.textContent = "";
      entry = attach(node, node, { kind: "page", html: next.html }, MAX_PAGE_HEIGHT, next.host);
    },
    destroy() { unmount(node); node.textContent = ""; },
  };
}

/** Handles the Diagram / Source switch. Returns true when the click was on it. */
export function diagramSwitchFromClick(event: MouseEvent): boolean {
  const target = event.target;
  if (!(target instanceof Element)) return false;
  const button = target.closest<HTMLElement>("[data-diagram-view]");
  const block = button?.closest<HTMLElement>(".diagram-block");
  if (!button || !block) return false;
  const source = button.dataset.diagramView === "source";
  block.classList.toggle("show-source", source);
  for (const other of block.querySelectorAll("[data-diagram-view]")) other.setAttribute("aria-pressed", String(other === button));
  return true;
}

/** Expand opens the diagram in a large top-layer dialog with its own frame. Esc, the close button or the backdrop closes it. */
export function expandFromClick(event: MouseEvent): boolean {
  const target = event.target;
  if (!(target instanceof Element)) return false;
  const button = target.closest("[data-diagram-expand]");
  const block = button?.closest<HTMLElement>(".diagram-block");
  if (!button || !block) return false;
  const dialog = document.createElement("dialog");
  dialog.className = "diagram-dialog panel-surface";
  dialog.setAttribute("aria-label", "Diagram");
  const close = document.createElement("button");
  close.type = "button";
  close.className = "button small diagram-dialog-close";
  close.textContent = "Close";
  const slot = document.createElement("div");
  slot.className = "diagram-dialog-body";
  dialog.append(close, slot);
  document.body.appendChild(dialog);
  attach(dialog, slot, { kind: "mermaid", source: block.querySelector("code")?.textContent ?? "" }, MAX_FRAME_HEIGHT, null);
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", clicked => { if (clicked.target === dialog) dialog.close(); });
  dialog.addEventListener("close", () => { unmount(dialog); dialog.remove(); (button as HTMLElement).focus(); });
  dialog.showModal();
  return true;
}
