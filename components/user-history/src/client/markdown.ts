import { Marked } from "marked";

export function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

const marked = new Marked({
  gfm: true,
  async: false,
  renderer: {
    html({ text }) { return escapeHtml(text); },
    link({ href, title, tokens }) {
      return `<span class="link">${this.parser.parseInline(tokens)} <span class="inert-url">(${escapeHtml(href)})${title ? " " + escapeHtml(title) : ""}</span></span>`;
    },
    image({ href, text }) { return `<span class="inert-image">Image: ${escapeHtml(text || href)}</span>`; },
    code({ text, lang }) {
      const language = (lang ?? "").split(/\s/)[0] ?? "";
      return `<div class="code-block"><div class="code-head"><span class="code-lang">${escapeHtml(language)}</span><button type="button" class="copy-button" data-copy>Copy</button></div><pre><code>${escapeHtml(text)}</code></pre></div>\n`;
    },
    checkbox({ checked }) { return `<span class="checkbox">${checked ? "[x]" : "[ ]"}</span> `; },
  },
});

const cache = new Map<string, string>();
const CACHE_LIMIT = 4000;

export function renderMarkdown(text: string): string {
  const cached = cache.get(text);
  if (cached !== undefined) return cached;
  const html = marked.parse(text, { async: false });
  cache.set(text, html);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return html;
}

export function copyFromClick(event: MouseEvent): boolean {
  const target = event.target;
  if (!(target instanceof Element)) return false;
  const button = target.closest("[data-copy]");
  if (!button) return false;
  const block = button.closest(".code-block");
  const code = block?.querySelector("code")?.textContent ?? "";
  void navigator.clipboard.writeText(code).then(() => {
    button.textContent = "Copied";
    setTimeout(() => { button.textContent = "Copy"; }, 1200);
  });
  event.preventDefault();
  return true;
}
