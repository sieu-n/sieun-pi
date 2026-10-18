import mermaid from "mermaid";

/*
 * Runs inside the sandboxed `render` frame. The chat posts { type: "render", id, kind: "mermaid", source, theme } for one diagram, or
 * { type: "render", id, kind: "page", html, theme } for a wiki page, and gets back { type: "size", id, height } after each layout change,
 * or { type: "error", id, message }. A page's links come back as { type: "open", id, href } (the chat decides where they open), and its
 * images with a file path as { type: "image", id, index, src }; the chat answers { type: "image", id, index, blob }.
 */

type DiagramRequest = { type: "render"; id: string; kind: "mermaid"; source: string; theme: "light" | "dark" };
type PageRequest = { type: "render"; id: string; kind: "page"; html: string; theme: "light" | "dark" };
type RenderRequest = DiagramRequest | PageRequest;
type ImageReply = { type: "image"; id: string; index: number; blob: Blob };
const out = document.getElementById("out")!;
const doc = document.getElementById("doc")!;
let current: RenderRequest | null = null;
let naturalWidth = 0;
let sequence = 0;
/** Wide diagrams shrink to fit the column, but never below this scale; past it the frame scrolls sideways. */
const MIN_SCALE = 0.7;
const MAX_PAGE_BYTES = 4_000_000;

function post(message: Record<string, unknown>): void { window.parent.postMessage(message, "*"); }

function isRequest(value: unknown): value is RenderRequest {
  if (typeof value !== "object" || value === null) return false;
  const data = value as Record<string, unknown>;
  if (data.type !== "render" || typeof data.id !== "string" || (data.theme !== "light" && data.theme !== "dark")) return false;
  if (data.kind === "mermaid") return typeof data.source === "string" && data.source.length <= 100_000;
  return data.kind === "page" && typeof data.html === "string" && data.html.length <= MAX_PAGE_BYTES;
}
function isImageReply(value: unknown): value is ImageReply {
  if (typeof value !== "object" || value === null) return false;
  const data = value as Record<string, unknown>;
  return data.type === "image" && typeof data.id === "string" && typeof data.index === "number" && data.blob instanceof Blob;
}

function report(): void { if (current) post({ type: "size", id: current.id, height: Math.ceil(document.documentElement.scrollHeight) }); }

/** A drawing wider than its column shrinks to fit, to 70% at the least; past that its holder scrolls sideways. */
function fitSvg(svg: SVGSVGElement, natural: number, room: number): void {
  const scale = natural > room ? Math.max(room / natural, MIN_SCALE) : 1;
  svg.style.maxWidth = "none";
  svg.setAttribute("width", String(Math.round(natural * scale)));
  svg.removeAttribute("height");
}
const widthOf = (svg: SVGSVGElement): number => svg.viewBox.baseVal?.width || svg.getBoundingClientRect().width || 0;

function fit(): void {
  if (current?.kind === "page") {
    for (const svg of doc.querySelectorAll<SVGSVGElement>(".diagram svg")) fitSvg(svg, Number(svg.dataset.natural), (svg.parentElement?.clientWidth ?? 0) - 16);
    report();
    return;
  }
  const svg = out.querySelector("svg");
  if (!svg) return;
  fitSvg(svg, naturalWidth, out.clientWidth - 16);
  report();
}

function initialize(theme: "light" | "dark"): void {
  // Matching the frame element's scheme keeps the browser from painting an opaque backdrop behind the drawing.
  document.documentElement.style.colorScheme = theme;
  mermaid.initialize({
    startOnLoad: false, securityLevel: "strict", theme: theme === "dark" ? "dark" : "neutral",
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
    flowchart: { useMaxWidth: false }, sequence: { useMaxWidth: false }, gantt: { useMaxWidth: false },
    themeVariables: { background: "transparent" },
  });
}

async function drawDiagram(request: DiagramRequest): Promise<void> {
  doc.textContent = "";
  try {
    const { svg } = await mermaid.render("diagram-" + ++sequence, request.source);
    if (current !== request) return;
    out.innerHTML = svg;
    const drawn = out.querySelector("svg");
    naturalWidth = drawn ? widthOf(drawn) : 0;
    fit();
  } catch (error) {
    if (current !== request) return;
    out.textContent = "";
    post({ type: "error", id: request.id, message: error instanceof Error ? error.message : String(error) });
  }
}

/*
 * A wiki page is HTML an agent wrote. The frame's sandbox (opaque origin) and policy (no script but render.js, no network) are the
 * boundary; the allowlist below keeps the page to document markup on top of that. An element off the list keeps its text and loses
 * its tag; a script, style, form, embed or inline SVG goes with its content.
 */
const KEEP = new Set(["a", "abbr", "article", "aside", "b", "blockquote", "br", "caption", "code", "dd", "del", "details", "div", "dl", "dt", "em", "figcaption", "figure",
  "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "i", "img", "ins", "kbd", "li", "main", "mark", "nav", "ol", "p", "pre", "s", "section", "small", "span", "strong",
  "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul", "wiki-tldr"]);
const DROP = new Set(["script", "style", "template", "iframe", "object", "embed", "noscript", "svg", "math", "form", "input", "textarea", "select", "button", "link", "meta", "base", "title", "head"]);
const ATTRIBUTES: Record<string, readonly string[]> = { a: ["href", "title"], img: ["src", "alt", "title", "width", "height"], td: ["colspan", "rowspan"], th: ["colspan", "rowspan", "scope"], ol: ["start"], details: ["open"] };
const SAFE_LINK = /^(https?:|mailto:|#)/i;
const SAFE_IMAGE = /^(https:|data:image\/)/i;
let imageIndex = 0;

function cleanInto(source: Node, into: Node): void {
  for (const child of source.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) { into.appendChild(document.createTextNode(child.nodeValue ?? "")); continue; }
    if (!(child instanceof Element)) continue;
    const tag = child.localName;
    if (DROP.has(tag)) continue;
    if (!KEEP.has(tag)) { cleanInto(child, into); continue; }
    const element = document.createElement(tag);
    for (const name of ["class", "id", ...(ATTRIBUTES[tag] ?? [])]) {
      const value = child.getAttribute(name);
      if (value !== null) element.setAttribute(name, value);
    }
    if (tag === "a") {
      const href = element.getAttribute("href") ?? "";
      if (!SAFE_LINK.test(href) && /^[a-z][a-z0-9+.-]*:/i.test(href)) element.removeAttribute("href");
    }
    if (tag === "img") {
      const src = element.getAttribute("src") ?? "";
      if (!SAFE_IMAGE.test(src)) {
        element.removeAttribute("src");
        if (src && !/^[a-z][a-z0-9+.-]*:/i.test(src)) { element.dataset.index = String(imageIndex); post({ type: "image", id: current!.id, index: imageIndex, src }); imageIndex += 1; }
      }
    }
    cleanInto(child, element);
    if (tag === "table") { const wrap = document.createElement("div"); wrap.className = "table-wrap"; wrap.appendChild(element); into.appendChild(wrap); }
    else into.appendChild(element);
  }
}

async function drawPage(request: PageRequest): Promise<void> {
  out.textContent = "";
  doc.textContent = "";
  imageIndex = 0;
  const parsed = new DOMParser().parseFromString(request.html, "text/html");
  const fragment = document.createDocumentFragment();
  cleanInto(parsed.body, fragment);
  doc.appendChild(fragment);
  report();
  for (const block of doc.querySelectorAll("pre.mermaid")) {
    const source = block.textContent?.trim() ?? "";
    const holder = document.createElement("div");
    holder.className = "diagram";
    block.replaceWith(holder);
    try {
      const { svg } = await mermaid.render("diagram-" + ++sequence, source);
      if (current !== request) return;
      holder.innerHTML = svg;
      const drawn = holder.querySelector("svg");
      if (drawn) { drawn.dataset.natural = String(widthOf(drawn)); fitSvg(drawn, widthOf(drawn), holder.clientWidth - 16); }
    } catch (error) {
      if (current !== request) return;
      const note = document.createElement("p");
      note.className = "diagram-error";
      note.textContent = "Could not draw this diagram: " + String(error instanceof Error ? error.message : error).split("\n")[0];
      const pre = document.createElement("pre");
      pre.textContent = source;
      holder.append(note, pre);
    }
    report();
  }
}

function placeImage(reply: ImageReply): void {
  if (current?.kind !== "page" || reply.id !== current.id) return;
  const image = doc.querySelector<HTMLImageElement>(`img[data-index="${reply.index}"]`);
  if (image) image.src = URL.createObjectURL(reply.blob);
}

doc.addEventListener("click", event => {
  const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
  const href = link?.getAttribute("href");
  if (!href || href.startsWith("#") || !current) return;
  event.preventDefault();
  post({ type: "open", id: current.id, href });
});

window.addEventListener("message", event => {
  if (event.source !== window.parent) return;
  if (isImageReply(event.data)) { placeImage(event.data); return; }
  if (!isRequest(event.data)) return;
  current = event.data;
  initialize(event.data.theme);
  document.body.className = event.data.kind;
  void (event.data.kind === "mermaid" ? drawDiagram(event.data) : drawPage(event.data));
});
new ResizeObserver(fit).observe(document.body);
post({ type: "ready" });
