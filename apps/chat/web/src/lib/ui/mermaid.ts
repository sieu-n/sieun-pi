type MermaidApi = typeof import("mermaid").default;

let api: Promise<MermaidApi> | null = null;
let configured: "light" | "dark" | null = null;
let queue: Promise<unknown> = Promise.resolve();
let seq = 0;

function mode(): "light" | "dark" {
  return document.documentElement.dataset.colorMode === "dark" ? "dark" : "light";
}

async function load(): Promise<MermaidApi> {
  api ??= import("mermaid").then((m) => m.default);
  const mermaid = await api;
  const current = mode();
  if (configured !== current) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: current === "dark" ? "dark" : "neutral",
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-sans") || "Inter, sans-serif",
    });
    configured = current;
  }
  return mermaid;
}

/** Draw mermaid source to an SVG string. Calls run one at a time, because mermaid keeps global state while it renders. */
export function drawMermaid(source: string): Promise<string> {
  const run = queue.then(async () => {
    const mermaid = await load();
    const { svg } = await mermaid.render(`mmd-${++seq}`, source);
    return svg;
  });
  queue = run.catch(() => undefined);
  return run;
}
