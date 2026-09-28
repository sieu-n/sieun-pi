import mermaid from "mermaid";

/*
 * Runs inside the sandboxed `render` frame. The chat posts { type: "render", id, kind, source, theme } and gets back
 * { type: "size", id, height } after each layout change, or { type: "error", id, message }.
 */

type RenderRequest = { type: "render"; id: string; kind: "mermaid"; source: string; theme: "light" | "dark" };
const out = document.getElementById("out")!;
let current: RenderRequest | null = null;
let naturalWidth = 0;
let sequence = 0;
/** Wide diagrams shrink to fit the column, but never below this scale; past it the frame scrolls sideways. */
const MIN_SCALE = 0.7;

function post(message: Record<string, unknown>): void { window.parent.postMessage(message, "*"); }

function isRequest(value: unknown): value is RenderRequest {
  if (typeof value !== "object" || value === null) return false;
  const data = value as Record<string, unknown>;
  return data.type === "render" && typeof data.id === "string" && data.kind === "mermaid" && typeof data.source === "string" &&
    data.source.length <= 100_000 && (data.theme === "light" || data.theme === "dark");
}

function fit(): void {
  const svg = out.querySelector("svg");
  if (!svg || !current) return;
  const room = out.clientWidth - 16;
  const scale = naturalWidth > room ? Math.max(room / naturalWidth, MIN_SCALE) : 1;
  svg.style.maxWidth = "none";
  svg.setAttribute("width", String(Math.round(naturalWidth * scale)));
  svg.removeAttribute("height");
  post({ type: "size", id: current.id, height: Math.ceil(document.documentElement.scrollHeight) });
}

async function draw(request: RenderRequest): Promise<void> {
  current = request;
  const dark = request.theme === "dark";
  // Matching the frame element's scheme keeps the browser from painting an opaque backdrop behind the drawing.
  document.documentElement.style.colorScheme = request.theme;
  mermaid.initialize({
    startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "neutral",
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
    flowchart: { useMaxWidth: false }, sequence: { useMaxWidth: false }, gantt: { useMaxWidth: false },
    themeVariables: { background: "transparent" },
  });
  try {
    const { svg } = await mermaid.render("diagram-" + ++sequence, request.source);
    if (current !== request) return;
    out.innerHTML = svg;
    const drawn = out.querySelector("svg");
    naturalWidth = drawn?.viewBox.baseVal?.width || drawn?.getBoundingClientRect().width || 0;
    fit();
  } catch (error) {
    if (current !== request) return;
    out.textContent = "";
    post({ type: "error", id: request.id, message: error instanceof Error ? error.message : String(error) });
  }
}

window.addEventListener("message", event => {
  if (event.source !== window.parent || !isRequest(event.data)) return;
  void draw(event.data);
});
new ResizeObserver(fit).observe(document.body);
post({ type: "ready" });
