import { Marked, type Token, type Tokens } from "marked";
import type { MentionIndex } from "./board.ts";
import { renderInline } from "./markdown.ts";

/**
 * The Reply button: the owner answers one chat message with a quote of it on top, the way he did by hand (10-09: a `> ...` line pasted
 * above his answer). The quote is a short plain-text excerpt of the message, sent as `> ` lines, a blank line, then his text, as one message.
 * The owner's bubble shows a leading `> ` block as a quote with the text under it.
 */
export const EXCERPT_CHARS = 160;
export const EXCERPT_LINES = 2;
const ELLIPSIS = "\u2026";

const lexer = new Marked({ gfm: true });

/** The words of a token tree: code and inline text as written, links and emphasis by their text, an image by its alt, markup dropped. */
function words(tokens: readonly Token[]): string {
  let out = "";
  for (const token of tokens) {
    if (token.type === "br") out += " ";
    else if ("tokens" in token && Array.isArray(token.tokens) && token.type !== "image") out += words(token.tokens);
    else if (token.type === "list") out += (token as Tokens.List).items.map(item => words(item.tokens)).join(" ");
    else if (token.type === "table") { const table = token as Tokens.Table; out += [...table.header, ...table.rows.flat()].map(cell => words(cell.tokens)).join(" "); }
    else if ("text" in token && typeof token.text === "string") out += token.text;
  }
  return out;
}

/** Each block of the markdown as one line of plain text; blank blocks dropped. */
export function plainLines(markdown: string): string[] {
  return lexer.lexer(markdown.replace(/\r\n?/g, "\n")).map(token => words([token]).replace(/\s+/g, " ").trim()).filter(line => line.length > 0);
}

/** The quote of a message: its plain text cut to about two lines, with an ellipsis when something was left out. */
export function replyExcerpt(markdown: string): string {
  const lines = plainLines(markdown);
  const kept = lines.slice(0, EXCERPT_LINES);
  let text = kept.join("\n");
  let cut = lines.length > kept.length;
  if (text.length > EXCERPT_CHARS) {
    const head = text.slice(0, EXCERPT_CHARS);
    const space = head.lastIndexOf(" ");
    text = (space > EXCERPT_CHARS / 2 ? head.slice(0, space) : head).replace(/[\s,;:.!?]+$/, "");
    cut = true;
  }
  return cut ? text + ELLIPSIS : text;
}

/** The message sent: the excerpt as `> ` lines, a blank line, the owner's text. No quote, the text alone. */
export function replyText(quote: string | null, text: string): string {
  if (quote === null || !quote.trim()) return text;
  return quote.split("\n").map(line => "> " + line).join("\n") + "\n\n" + text;
}

/** The owner's bubble HTML: a leading `> ` block as a `<blockquote class="quote">` over the inline-rendered text, else the text alone. */
export function renderSaid(text: string, index: MentionIndex | null = null): string {
  const { quote, body } = splitQuote(text);
  if (quote === null) return renderInline(text, index);
  return `<blockquote class="quote">${renderInline(quote, index)}</blockquote>` + (body ? renderInline(body, index) : "");
}

/** A message split for the owner's bubble: the `> ` lines it opens with as the quote (markers dropped), and the text after them. */
export function splitQuote(text: string): { quote: string | null; body: string } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let count = 0;
  while (count < lines.length && lines[count]!.startsWith(">")) count += 1;
  if (count === 0) return { quote: null, body: text };
  return { quote: lines.slice(0, count).map(line => line.replace(/^>[ \t]?/, "")).join("\n"), body: lines.slice(count).join("\n").replace(/^\n+/, "") };
}
