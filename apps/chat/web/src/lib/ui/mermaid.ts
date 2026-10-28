type MermaidApi = typeof import("mermaid").default;

let api: Promise<MermaidApi> | null = null;
let configured: "light" | "dark" | null = null;
let queue: Promise<unknown> = Promise.resolve();
let seq = 0;

function mode(): "light" | "dark" {
  return document.documentElement.dataset.colorMode === "dark" ? "dark" : "light";
}

/** The design tokens mermaid's base theme derives its palette from, read in the current color mode (styles/tokens.css). */
function themeVariables(dark: boolean): Record<string, string | boolean> {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const panel = token("--surface-panel", dark ? "#1a1a1a" : "#ffffff");
  const text = token("--text-standard", dark ? "#ffffff" : "#0f0f0f");
  const node = token("--surface-message", dark ? "#292929" : "#f3f3f4");
  const line = token("--text-metadata", dark ? "#a4a4a4" : "#5f5f5f");
  const border = token("--border-prominent", dark ? "#737373" : "#808080");
  const accent = token("--accent-4", dark ? "#292e16" : "#e8f0cd");
  const accentText = token("--accent-12", dark ? "#edf7d2" : "#2b3110");
  const inset = token("--surface-inset", dark ? "#101010" : "#f5f5f6");
  return {
    darkMode: dark,
    background: panel,
    fontFamily: token("--font-sans", "Inter, sans-serif"),
    fontSize: "13px",
    primaryColor: node,
    primaryTextColor: text,
    primaryBorderColor: border,
    secondaryColor: accent,
    secondaryTextColor: accentText,
    secondaryBorderColor: border,
    tertiaryColor: inset,
    tertiaryTextColor: text,
    tertiaryBorderColor: border,
    lineColor: line,
    textColor: text,
    mainBkg: node,
    nodeBorder: border,
    clusterBkg: inset,
    clusterBorder: token("--border-standard", dark ? "#333333" : "#e8e8e8"),
    edgeLabelBackground: panel,
    noteBkgColor: accent,
    noteTextColor: accentText,
    noteBorderColor: border,
    actorBkg: node,
    actorBorder: border,
    actorTextColor: text,
    signalColor: text,
    signalTextColor: text,
    labelBoxBkgColor: node,
    labelTextColor: text,
  };
}

async function load(): Promise<MermaidApi> {
  api ??= import("mermaid").then((m) => m.default);
  const mermaid = await api;
  const current = mode();
  if (configured !== current) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      themeVariables: themeVariables(current === "dark"),
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-sans") || "Inter, sans-serif",
    });
    configured = current;
  }
  return mermaid;
}

/** The smallest scale a diagram shrinks to in a narrow bubble; below it the diagram scrolls sideways, so its labels stay readable. */
const MIN_SCALE = 0.8;

/** Gives mermaid's SVG, which sets `max-width` to its drawn width, a `min-width` of MIN_SCALE of that width. */
export function readable(svg: string): string {
  return svg.replace(/(<svg\b[^>]*?style="[^"]*?)max-width:\s*([\d.]+)px;?/, (_, head: string, width: string) =>
    `${head}max-width: ${width}px; min-width: min(${Math.round(Number(width) * MIN_SCALE)}px, ${width}px);`);
}

/**
 * Draw mermaid source to an SVG string. Calls run one at a time, because mermaid keeps global state while it renders. Source that does not
 * parse rejects before mermaid draws, so no error graphic is left in the page.
 */
export function drawMermaid(source: string): Promise<string> {
  const run = queue.then(async () => {
    const mermaid = await load();
    await mermaid.parse(source);
    const id = `mmd-${++seq}`;
    try {
      const { svg } = await mermaid.render(id, source);
      return readable(svg);
    } finally {
      document.getElementById(`d${id}`)?.remove();
    }
  });
  queue = run.catch(() => undefined);
  return run;
}

/**
 * One observer per scroll box: a diagram draws once it comes within 400 px of its scroll box's view. The box is the nearest scrolling
 * ancestor, because with the viewport as root the timeline's own scroll clips the diagram first and the margin never applies.
 */
const observers = new WeakMap<Element, IntersectionObserver>();
let viewportObserver: IntersectionObserver | undefined;
const pending = new Map<Element, () => void>();

function scrollBox(el: Element): Element | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
}

/** Calls `draw` once when `el` is near the view of its scroll box; the returned function cancels it. */
export function whenVisible(el: Element, draw: () => void): () => void {
  if (typeof IntersectionObserver === "undefined") {
    draw();
    return () => {};
  }
  const root = scrollBox(el);
  let observer = root ? observers.get(root) : viewportObserver;
  if (!observer) {
    const made = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const run = pending.get(entry.target);
          pending.delete(entry.target);
          made.unobserve(entry.target);
          run?.();
        }
      },
      { root, rootMargin: "400px 0px" },
    );
    if (root) observers.set(root, made);
    else viewportObserver = made;
    observer = made;
  }
  pending.set(el, draw);
  observer.observe(el);
  const owner = observer;
  return () => {
    pending.delete(el);
    owner.unobserve(el);
  };
}
