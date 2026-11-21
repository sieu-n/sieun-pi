import { Lexer, type Token, type Tokens } from "marked";
import { isMac } from "../../lib/ui/keyboard";

/**
 * Slack's formatting in the composer's editable box: the formats, their keys and buttons, and how each one changes the box.
 * The box holds the formatted text as the browser draws it (<b>, <i>, <s>, <code>, <a>, lists, quotes and code blocks), `readDraft` writes
 * it out as the markdown the post renders, and `fillDraft` puts a saved markdown draft back as the same elements.
 */

export type Format = "bold" | "italic" | "strike" | "link" | "ordered" | "bullet" | "quote" | "code" | "codeBlock";

type Keys = { code: string; shift?: boolean; alt?: boolean };
export type FormatSpec = { format: Format; label: string; icon: string; keys: Keys };

/** The bar's groups in Slack's order, with Slack's keys: Cmd on a Mac and Ctrl elsewhere, plus the listed modifiers. */
export const FORMAT_GROUPS: readonly (readonly FormatSpec[])[] = [
  [
    { format: "bold", label: "Bold", icon: "bold", keys: { code: "KeyB" } },
    { format: "italic", label: "Italic", icon: "italic", keys: { code: "KeyI" } },
    { format: "strike", label: "Strikethrough", icon: "strike", keys: { code: "KeyX", shift: true } },
  ],
  [{ format: "link", label: "Link", icon: "link", keys: { code: "KeyU", shift: true } }],
  [
    { format: "ordered", label: "Numbered list", icon: "list-ordered", keys: { code: "Digit7", shift: true } },
    { format: "bullet", label: "Bulleted list", icon: "list-bullet", keys: { code: "Digit8", shift: true } },
  ],
  [{ format: "quote", label: "Quote", icon: "quote", keys: { code: "Digit9", shift: true } }],
  [
    { format: "code", label: "Code", icon: "code", keys: { code: "KeyC", shift: true } },
    { format: "codeBlock", label: "Code block", icon: "code-block", keys: { code: "KeyC", shift: true, alt: true } },
  ],
];
const SPECS = FORMAT_GROUPS.flat();

/** The key a format's tooltip shows, such as ⇧⌘X on a Mac and Ctrl+Shift+X elsewhere. */
export function shortcutLabel(keys: Keys): string {
  const key = keys.code.replace(/^(Key|Digit)/, "");
  if (isMac) return `${keys.alt ? "⌥" : ""}${keys.shift ? "⇧" : ""}⌘${key}`;
  return ["Ctrl", keys.alt && "Alt", keys.shift && "Shift", key].filter(Boolean).join("+");
}

/** The format a keydown asks for. Matches the physical key, so the keys work while a Korean input source is on. */
export function formatForKey(e: KeyboardEvent): Format | null {
  if (!(isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey)) return null;
  const hit = SPECS.find((s) => s.keys.code === e.code && !!s.keys.shift === e.shiftKey && !!s.keys.alt === e.altKey);
  return hit?.format ?? null;
}

const LIST: Partial<Record<Format, "UL" | "OL">> = { bullet: "UL", ordered: "OL" };
const COMMAND: Partial<Record<Format, string>> = { bold: "bold", italic: "italic", strike: "strikeThrough" };
/** Elements that make the box more than a line of text, so an empty box with one of them is not cleared and shows no placeholder. */
export const STRUCTURE = "ul, ol, blockquote, pre, code";
const ZWSP = "\u200b";

function within(node: Node | null, root: HTMLElement, tags: string): HTMLElement | null {
  const element = node instanceof HTMLElement ? node : node?.parentElement;
  const hit = element?.closest<HTMLElement>(tags);
  return hit && root.contains(hit) && hit !== root ? hit : null;
}

function selectionIn(root: HTMLElement): Range | null {
  const selection = root.ownerDocument.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  return root.contains(range.commonAncestorContainer) ? range : null;
}

/** The formats on at the caret, which the bar shows as pressed. */
export function activeFormats(root: HTMLElement): Set<Format> {
  const on = new Set<Format>();
  const range = selectionIn(root);
  if (!range) return on;
  const doc = root.ownerDocument;
  for (const [format, command] of Object.entries(COMMAND)) if (doc.queryCommandState(command)) on.add(format as Format);
  const at = range.startContainer;
  if (within(at, root, "a[href]")) on.add("link");
  const list = within(at, root, "ul, ol");
  if (list) on.add(list.tagName === "OL" ? "ordered" : "bullet");
  if (within(at, root, "blockquote")) on.add("quote");
  if (within(at, root, "pre")) on.add("codeBlock");
  else if (within(at, root, "code")) on.add("code");
  return on;
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function caretAt(root: HTMLElement, node: Node, offset: number) {
  const range = root.ownerDocument.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const selection = root.ownerDocument.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** Inline code: wraps the selection, or starts a code span at the caret; inside one it unwraps the selection or steps the caret out. */
function toggleCode(root: HTMLElement, range: Range) {
  const doc = root.ownerDocument;
  const code = within(range.commonAncestorContainer, root, "code");
  if (code && range.collapsed) {
    const after = doc.createTextNode(ZWSP);
    code.after(after);
    caretAt(root, after, 1);
  } else if (code) {
    const whole = doc.createRange();
    whole.selectNode(code);
    doc.getSelection()?.removeAllRanges();
    doc.getSelection()?.addRange(whole);
    doc.execCommand("insertText", false, (code.textContent ?? "").replaceAll(ZWSP, ""));
  } else if (range.collapsed) {
    doc.execCommand("insertHTML", false, `<code>${ZWSP}</code>`);
    const made = within(doc.getSelection()?.anchorNode ?? null, root, "code") ?? [...root.querySelectorAll("code")].find((c) => c.textContent === ZWSP);
    if (made?.firstChild) caretAt(root, made.firstChild, made.firstChild.textContent?.length ?? 0);
  } else {
    doc.execCommand("insertHTML", false, `<code>${escapeHtml(range.toString()) || ZWSP}</code>`);
  }
}

function toggleBlock(root: HTMLElement, range: Range, tag: "blockquote" | "pre") {
  const doc = root.ownerDocument;
  const inside = within(range.startContainer, root, tag);
  if (!inside) doc.execCommand("formatBlock", false, tag);
  else if (tag === "blockquote") doc.execCommand("outdent");
  else doc.execCommand("formatBlock", false, "div");
}

/** Applies a format to the box at its selection. A link needs its text and address, so the composer asks for them and calls `insertLink`. */
export function applyFormat(root: HTMLElement, format: Exclude<Format, "link">): void {
  const range = selectionIn(root);
  if (!range) return;
  const doc = root.ownerDocument;
  const command = COMMAND[format];
  const list = LIST[format];
  if (command) doc.execCommand(command);
  else if (list) doc.execCommand(list === "UL" ? "insertUnorderedList" : "insertOrderedList");
  else if (format === "quote") toggleBlock(root, range, "blockquote");
  else if (format === "codeBlock") toggleBlock(root, range, "pre");
  else if (format === "code") toggleCode(root, range);
}

/** What the link dialog opens with: the link under the caret, or the selected text. */
export function linkAtSelection(root: HTMLElement): { text: string; url: string } {
  const range = selectionIn(root);
  if (!range) return { text: "", url: "" };
  const link = within(range.commonAncestorContainer, root, "a[href]");
  if (link) {
    const whole = root.ownerDocument.createRange();
    whole.selectNodeContents(link);
    root.ownerDocument.getSelection()?.removeAllRanges();
    root.ownerDocument.getSelection()?.addRange(whole);
    return { text: link.textContent ?? "", url: link.getAttribute("href") ?? "" };
  }
  return { text: range.toString(), url: "" };
}

/** An address as a link's href: a bare domain such as slack.com gets https://. */
export function linkHref(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  return /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed.replace(/^\/+/, "")}`;
}

/** Puts a link with this text and address in place of the selection, which `linkAtSelection` set to the whole link when it edits one. */
export function insertLink(root: HTMLElement, text: string, url: string): void {
  const href = linkHref(url);
  if (!href || !selectionIn(root)) return;
  root.ownerDocument.execCommand("insertHTML", false, `<a href="${escapeHtml(href)}">${escapeHtml(text.trim() || href)}</a>`);
}

/** A bare web address pasted over selected text links that text, as in Slack. */
export function pasteLink(root: HTMLElement, pasted: string): boolean {
  const range = selectionIn(root);
  if (!range || range.collapsed || !/^https?:\/\/\S+$/i.test(pasted.trim()) || within(range.commonAncestorContainer, root, "pre, code")) return false;
  return root.ownerDocument.execCommand("createLink", false, pasted.trim());
}

/** Shift+Enter in a list starts the next item, and on an empty item ends the list, as in Slack. False when the caret is not in a list. */
export function listBreak(root: HTMLElement): boolean {
  const range = selectionIn(root);
  const item = range && within(range.startContainer, root, "li");
  if (!item) return false;
  const doc = root.ownerDocument;
  if ((item.textContent ?? "").replaceAll(ZWSP, "").trim() === "") {
    doc.execCommand(item.parentElement?.tagName === "OL" ? "insertOrderedList" : "insertUnorderedList");
  } else {
    doc.execCommand("insertParagraph");
  }
  return true;
}

/** Whether the caret sits in a code block, where Enter adds a line as in Slack. */
export function inCodeBlock(root: HTMLElement): boolean {
  const range = selectionIn(root);
  return !!range && !!within(range.startContainer, root, "pre");
}

/** The marks on a run of text, so a mark nested in the same mark is written once. */
type Marks = { bold?: boolean; italic?: boolean; strike?: boolean };

/** Puts a mark around each line's text, outside its edge spaces, since `** x**` is not bold in markdown. */
function wrap(inner: string, mark: string): string {
  return inner
    .split("\n")
    .map((line) => {
      const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(line)!;
      return core ? `${lead}${mark}${core}${mark}${trail}` : line;
    })
    .join("\n");
}

function codeSpan(text: string): string {
  if (!text) return "";
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

function styleMarks(element: HTMLElement): Marks {
  const tag = element.tagName;
  const style = element.style;
  const weight = style.fontWeight;
  return {
    bold: tag === "B" || tag === "STRONG" || weight === "bold" || Number(weight) >= 600,
    italic: tag === "I" || tag === "EM" || style.fontStyle === "italic",
    strike: tag === "S" || tag === "STRIKE" || tag === "DEL" || style.textDecorationLine.includes("line-through") || style.textDecoration.includes("line-through"),
  };
}

/** Element names that start a new line in the draft. */
const BLOCKS = new Set(["DIV", "P", "UL", "OL", "LI", "BLOCKQUOTE", "PRE"]);

export type Writer = {
  /** Whether to write markdown for the formatting, or the bare text the typeahead reads. */
  markup: boolean;
  /** Writes a mention or channel chip and records its id. */
  chip: (element: HTMLElement) => string | null;
};

/** The draft's text with its formatting as markdown, as `readDraft` sends it. */
export function writeMarkdown(root: HTMLElement, writer: Writer): string {
  return children(root, writer, {}).replaceAll(ZWSP, "");
}

function children(node: Node, writer: Writer, marks: Marks): string {
  let text = "";
  /** The newlines a finished block needs before the next content: a list or quote needs a blank line, or the next line joins it. */
  let pending = 0;
  const ensure = (count: number) => {
    if (!text) return;
    const have = /\n*$/.exec(text)![0].length;
    if (have < count) text += "\n".repeat(count - have);
  };
  for (const child of node.childNodes) {
    const block = child instanceof HTMLElement && BLOCKS.has(child.tagName);
    const part = one(child, writer, marks);
    if (!part) continue;
    ensure(block ? Math.max(pending, 1) : pending);
    text += part;
    pending = !block ? 0 : child instanceof HTMLElement && /^(UL|OL|BLOCKQUOTE)$/.test(child.tagName) && writer.markup ? 2 : 1;
  }
  return text;
}

function one(node: Node, writer: Writer, marks: Marks): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (!(node instanceof HTMLElement)) return "";
  const chip = writer.chip(node);
  if (chip !== null) return chip;
  const tag = node.tagName;
  if (tag === "BR") return "\n";
  if (!writer.markup) return children(node, writer, marks);
  if (tag === "PRE") {
    const body = children(node, { ...writer, markup: false }, {}).replaceAll(ZWSP, "").replace(/\n+$/, "");
    return body.trim() ? `\`\`\`\n${body}\n\`\`\`` : "";
  }
  if (tag === "CODE") return codeSpan((node.textContent ?? "").replaceAll(ZWSP, ""));
  if (tag === "UL" || tag === "OL") return list(node, writer, marks);
  if (tag === "BLOCKQUOTE") {
    const body = children(node, writer, marks).replace(/\n+$/, "");
    return body.trim() ? body.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n") : "";
  }
  if (tag === "A") {
    const inner = children(node, writer, marks);
    const href = node.getAttribute("href") ?? "";
    if (!href || !inner.trim() || inner === href) return inner || href;
    return `[${inner}](${href.replace(/[\s()]/g, encodeURIComponent)})`;
  }
  const own = styleMarks(node);
  const next: Marks = { bold: marks.bold || own.bold, italic: marks.italic || own.italic, strike: marks.strike || own.strike };
  let inner = children(node, writer, next);
  if (own.strike && !marks.strike) inner = wrap(inner, "~~");
  if (own.italic && !marks.italic) inner = wrap(inner, "*");
  if (own.bold && !marks.bold) inner = wrap(inner, "**");
  return inner;
}

function list(element: HTMLElement, writer: Writer, marks: Marks): string {
  const ordered = element.tagName === "OL";
  let number = ordered ? Number(element.getAttribute("start") ?? 1) || 1 : 0;
  const lines: string[] = [];
  for (const item of element.children) {
    if (item.tagName !== "LI") continue;
    const body = children(item, writer, marks).replaceAll(ZWSP, "").replace(/\n+$/, "");
    if (!body.trim()) continue;
    const marker = ordered ? `${number++}. ` : "- ";
    const indent = " ".repeat(marker.length);
    lines.push(body.split("\n").map((line, i) => (i === 0 ? marker + line : line ? indent + line : line)).join("\n"));
  }
  return lines.join("\n");
}

/** Puts a saved markdown draft back in the box as the formatted elements it came from, so a restored draft looks as it did. */
export function fillDraft(root: HTMLElement, markdown: string): void {
  const doc = root.ownerDocument;
  root.replaceChildren(...blocks(doc, new Lexer({ gfm: true }).lex(markdown)));
}

function blocks(doc: Document, tokens: Token[]): Node[] {
  const out: Node[] = [];
  let paragraph = false;
  for (const token of tokens) {
    if (token.type === "space") continue;
    if (token.type === "paragraph" || token.type === "text") {
      if (paragraph) out.push(doc.createTextNode("\n\n"));
      const t = token as Tokens.Paragraph | Tokens.Text;
      out.push(...("tokens" in t && t.tokens ? inline(doc, t.tokens) : [doc.createTextNode(t.text)]));
      paragraph = true;
      continue;
    }
    paragraph = false;
    if (token.type === "list") {
      const t = token as Tokens.List;
      const element = doc.createElement(t.ordered ? "ol" : "ul");
      if (t.ordered && t.start !== "" && t.start !== 1) element.setAttribute("start", String(t.start));
      for (const item of t.items) {
        const li = doc.createElement("li");
        li.append(...blocks(doc, item.tokens));
        element.append(li);
      }
      out.push(element);
    } else if (token.type === "blockquote") {
      const element = doc.createElement("blockquote");
      element.append(...blocks(doc, (token as Tokens.Blockquote).tokens));
      out.push(element);
    } else if (token.type === "code") {
      const element = doc.createElement("pre");
      element.textContent = (token as Tokens.Code).text;
      out.push(element);
    } else {
      out.push(doc.createTextNode(token.raw.replace(/\n+$/, "")));
      paragraph = true;
    }
  }
  return out;
}

function inline(doc: Document, tokens: Token[]): Node[] {
  const out: Node[] = [];
  for (const token of tokens) {
    const nested = "tokens" in token && Array.isArray(token.tokens) ? (token.tokens as Token[]) : null;
    const element = (tag: string) => {
      const made = doc.createElement(tag);
      made.append(...(nested ? inline(doc, nested) : []));
      return made;
    };
    if (token.type === "strong") out.push(element("b"));
    else if (token.type === "em") out.push(element("i"));
    else if (token.type === "del") out.push(element("s"));
    else if (token.type === "link") {
      const a = element("a");
      a.setAttribute("href", (token as Tokens.Link).href);
      out.push(a);
    } else if (token.type === "codespan") {
      const code = doc.createElement("code");
      code.textContent = (token as Tokens.Codespan).text;
      out.push(code);
    } else if (token.type === "br") out.push(doc.createTextNode("\n"));
    else if (token.type === "text" && nested) out.push(...inline(doc, nested));
    else if (token.type === "text") out.push(doc.createTextNode((token as Tokens.Text).text));
    else out.push(doc.createTextNode(token.raw));
  }
  return out;
}
